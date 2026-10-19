import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, providerMode, loadBrands, getBrand } from './lib/config.js';
import { brandData, save } from './lib/store.js';
import { syncBrand, listeners, isSyncing } from './lib/sync.js';
import { TOPICS, refreshRuleAnalysis } from './lib/analysis.js';
import { crisisLevel, duplicateGroups } from './lib/crisis.js';
import { saveReport } from './lib/report.js';
import { overview, listReviews, selfReviews, byBranch, sentimentCounts, weekly, topicStats, keywordStats, searchSov, competitorTable, dailyNegatives, entitiesOf, healthScore, entityOfUrl, snapshotBefore } from './lib/metrics.js';
import { DAY, ts, weekStart } from './lib/util.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const json = (res, data, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

function brandSummary(b) {
  const bd = brandData(b.id);
  const hs = healthScore(bd, b);
  return { id: b.id, name: b.name, industry: b.industry, color: b.color, mode: bd.mode || providerMode(), lastSync: bd.lastSync, syncing: isSyncing(b.id), unread: bd.alerts.filter((a) => !a.read).length, health: hs.score, level: crisisLevel(bd), reviews: selfReviews(bd).length };
}

const handlers = {
  overview: (b, bd, q) => ({ ...overview(bd, b, +q.days || 30), level: crisisLevel(bd), unread: bd.alerts.filter((a) => !a.read).length, mode: bd.mode, lastSync: bd.lastSync, syncLog: bd.syncLog.slice(0, 5) }),
  reviews: (b, bd, q) => {
    const self = selfReviews(bd);
    const inBranch = self.filter((r) => !q.branch || (r.branch || 'Khác') === q.branch);
    const res = listReviews(bd, { entity: 'self', ...q });
    const base = self.filter((r) => (q.stars ? r.rating === +q.stars : true));
    // Điểm và tổng số review Google hiển thị (của brand hoặc chi nhánh đang lọc), bình quân gia quyền theo số review
    const places = Object.entries(bd.places)
      .filter(([k]) => (q.branch ? k === `self|${q.branch}` : k.startsWith('self|')))
      .map(([, p]) => p)
      .filter((p) => p.rating && p.reviews);
    const gTotal = places.reduce((s, p) => s + p.reviews, 0);
    const google = gTotal ? { rating: +(places.reduce((s, p) => s + p.rating * p.reviews, 0) / gTotal).toFixed(2), total: gTotal } : null;
    return { ...res, branches: byBranch(base), starCounts: [1, 2, 3, 4, 5].map((s) => ({ star: s, n: inBranch.filter((r) => r.rating === s).length })), google };
  },
  sentiment: (b, bd, q) => {
    const days = +q.days || 90;
    const list = selfReviews(bd).filter((r) => ts(r) > Date.now() - days * DAY);
    const lang = {};
    list.forEach((r) => (lang[r.lang] = (lang[r.lang] || 0) + 1));
    return { days, counts: sentimentCounts(list), weekly: weekly(selfReviews(bd), 12), branches: byBranch(list), lang, llm: list.filter((r) => r.analysis?.by === 'llm').length, total: list.length };
  },
  topics: (b, bd, q) => {
    const list = selfReviews(bd).filter((r) => ts(r) > Date.now() - (+q.days || 90) * DAY);
    return { topics: topicStats(list), keywords: keywordStats(list), labels: Object.fromEntries(Object.entries(TOPICS).map(([k, t]) => [k, t.label])) };
  },
  sov: (b, bd) => {
    const items = bd.serp.items.map((i) => ({ ...i, entity: entityOfUrl(i.url, b) }));
    return { entities: entitiesOf(b), search: searchSov(bd, b), table: competitorTable(bd, b), prev: snapshotBefore(bd, 7), lastCompetitorSync: bd.lastCompetitorSync, items, keywords: b.keywords };
  },
  crisis: (b, bd) => ({
    level: crisisLevel(bd),
    daily: dailyNegatives(bd, 30),
    duplicates: duplicateGroups(bd).map((g) => g.map((r) => ({ id: r.id, author: r.author, date: r.date, text: r.text, branch: r.branch }))),
    severe: selfReviews(bd).filter((r) => r.analysis?.severity >= 2 && ts(r) > Date.now() - 30 * DAY).sort((a, c) => ts(c) - ts(a)).slice(0, 15),
    alerts: bd.alerts.slice(0, 50),
  }),
  alerts: (b, bd) => ({ alerts: bd.alerts.slice(0, 100), unread: bd.alerts.filter((a) => !a.read).length }),
  reputation: (b, bd) => ({ snapshots: bd.snapshots, weekly: weekly(selfReviews(bd), 12), table: competitorTable(bd, b), prev: snapshotBefore(bd, 7), lastCompetitorSync: bd.lastCompetitorSync, places: bd.places, syncLog: bd.syncLog.slice(0, 20) }),
  reports: (b, bd) => ({ reports: bd.reports }),
};

async function body(req) {
  let s = '';
  for await (const c of req) s += c;
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const q = Object.fromEntries(url.searchParams);

    if (p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 5000\n\n');
      listeners.add(res);
      const hb = setInterval(() => res.write(': hb\n\n'), 25000);
      req.on('close', () => {
        clearInterval(hb);
        listeners.delete(res);
      });
      return;
    }
    if (p === '/api/config') return json(res, { mode: providerMode(), llm: !!config.anthropicKey, syncMin: config.syncMin, syncTimes: config.syncTimes, competitorDays: config.competitorDays, topics: Object.fromEntries(Object.entries(TOPICS).map(([k, t]) => [k, t.label])), brands: loadBrands().map(brandSummary) });

    let m;
    if ((m = p.match(/^\/api\/([\w-]+)\/(\w+)$/))) {
      const brand = getBrand(m[1]);
      if (!brand) return json(res, { error: 'Brand không tồn tại' }, 404);
      const bd = brandData(brand.id);
      const [, , action] = m;
      if (req.method === 'POST') {
        const b = await body(req);
        if (action === 'sync') return json(res, await syncBrand(brand.id, { forceSearch: !!b.forceSearch }));
        if (action === 'read') {
          bd.alerts.forEach((a) => (!b.id || a.id === b.id) && (a.read = true));
          save();
          return json(res, { ok: true });
        }
        if (action === 'reports') {
          const e = saveReport(brand, bd, +b.days || 7);
          save();
          return json(res, e);
        }
        return json(res, { error: 'Không hỗ trợ' }, 404);
      }
      if (handlers[action]) return json(res, handlers[action](brand, bd, q));
      return json(res, { error: 'Không có endpoint' }, 404);
    }

    if ((m = p.match(/^\/reports\/([\w.-]+\.html)$/))) {
      const f = path.join(config.dataDir, 'reports', m[1]);
      if (!fs.existsSync(f)) return json(res, { error: 'Không thấy báo cáo' }, 404);
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(fs.readFileSync(f));
    }

    // Static
    const rel = p === '/' ? '/index.html' : p;
    const f = path.normalize(path.join(config.publicDir, rel));
    if (!f.startsWith(config.publicDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(fs.readFileSync(f));
  } catch (e) {
    console.error(e);
    json(res, { error: e.message }, 500);
  }
});

// Mốc giờ đồng bộ gần nhất đã qua (hôm nay hoặc hôm qua), theo giờ máy chủ. null nếu không cấu hình SYNC_TIMES
function lastSlot(now = new Date()) {
  let best = null;
  for (const t of config.syncTimes) {
    const [h, m] = t.split(':').map(Number);
    for (const back of [0, 1]) {
      const d = new Date(now);
      d.setDate(d.getDate() - back);
      d.setHours(h, m, 0, 0);
      if (d <= now && (!best || d > best)) best = d;
    }
  }
  return best;
}

// Đến hạn khi chưa đồng bộ kể từ mốc giờ gần nhất; server tắt lúc đến giờ thì đồng bộ bù khi bật lại
function syncDue(bd) {
  if (!bd.lastSync) return true;
  const slot = lastSlot();
  if (slot) return Date.parse(bd.lastSync) < slot.getTime();
  return Date.now() - Date.parse(bd.lastSync) > config.syncMin * 60e3;
}

// Lịch tự động: đồng bộ theo giờ cố định (SYNC_TIMES), báo cáo tuần vào thứ Hai
async function tick() {
  for (const b of loadBrands()) {
    const bd = brandData(b.id);
    if (syncDue(bd)) {
      try {
        await syncBrand(b.id);
      } catch (e) {
        console.error(`[sync ${b.id}]`, e.message);
      }
    }
    const isMonday = new Date().getDay() === 1;
    const wk = weekStart(Date.now());
    if (isMonday && !bd.reports.some((r) => r.days === 7 && r.createdAt.slice(0, 10) >= wk)) {
      saveReport(b, bd, 7);
      save();
    }
  }
}

// Bộ chủ đề/từ khóa đổi thì áp dụng lại cho dữ liệu đã lưu ngay khi khởi động
let refreshed = 0;
for (const b of loadBrands()) {
  const bd = brandData(b.id);
  refreshed += refreshRuleAnalysis([...bd.reviews, ...bd.serp.items]);
}
if (refreshed) {
  save();
  console.log(`Đã phân tích lại ${refreshed} bản ghi theo bộ chủ đề mới`);
}

server.listen(config.port, config.host, () => {
  console.log(`CheckBrand dashboard: http://${config.host}:${config.port}  |  chế độ dữ liệu: ${providerMode() === 'mock' ? 'MẪU (chưa có SERPAPI_KEY)' : 'THẬT (SerpAPI)'}  |  Claude: ${config.anthropicKey ? 'bật' : 'tắt (dùng bộ luật)'}`);
  console.log(`Lịch đồng bộ: chi nhánh ${config.syncTimes.length ? `lúc ${config.syncTimes.join(', ')} mỗi ngày` : `mỗi ${config.syncMin} phút`} · đối thủ mỗi ${config.competitorDays} ngày · Google Search/News mỗi ${config.searchHours} giờ`);
  tick();
  setInterval(tick, 60e3);
});
