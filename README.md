# CheckBrand Dashboard

Dashboard giám sát thương hiệu cho clinic, spa, thẩm mỹ và doanh nghiệp nhỏ: Google Review, Sentiment, Topics, Share of Voice, Crisis Monitoring, cảnh báo, báo cáo tự động. Không cần cài thư viện, chỉ cần **Node.js 20 trở lên**.

## Chạy thử ngay (dữ liệu mẫu)

```
cd checkbrand
node server.js
```
Mở http://127.0.0.1:3000. Khi chưa có `SERPAPI_KEY`, hệ thống tự chạy **dữ liệu mẫu** và hiện banner vàng ở mọi trang. Muốn ép chạy mẫu dù đã có key: đặt `USE_MOCK=1` trong `.env`.

## Chuyển sang dữ liệu thật

1. Sao chép `.env.example` thành `.env`.
2. Điền `SERPAPI_KEY` (lấy Google Review, Google Search, Google News qua SerpAPI).
3. (Khuyến nghị) điền `ANTHROPIC_API_KEY` để phân tích cảm xúc/chủ đề/mức nghiêm trọng bằng Claude và tóm tắt review tiếng nước ngoài sang tiếng Việt. Không có key thì dùng bộ luật từ khóa.
4. Lấy `dataId` cho từng chi nhánh và đối thủ:
   `npm run find-place -- "Thẩm mỹ viện Seoul Center Cần Thơ"`
5. Điền `dataId`, `domains`, `keywords` vào `config/brands.json` (mỗi brand một khối, có thể thêm brand mới).
6. Khởi động lại `node server.js`. Khi đổi chế độ mẫu sang thật, dữ liệu mẫu của brand đó bị xóa để không trộn lẫn.

## Cách hệ thống cập nhật dữ liệu

| Dữ liệu | Chu kỳ mặc định | Chi phí SerpAPI |
|---|---|---|
| Google Review | mỗi 60 phút, chỉ lấy review mới (dừng khi gặp review đã có) | 1 credit/trang 10 review. Lần đầu tối đa 5 trang/chi nhánh |
| Google Search + News | mỗi 24 giờ | 2 credit/từ khóa |
| Phân tích cảm xúc | ngay khi có review mới | token Claude |

Giao diện nhận cập nhật qua kết nối trực tiếp (SSE) nên không cần tải lại trang; nút "Cập nhật ngay" ép đồng bộ tức thì. Dữ liệu lưu trong `data/db.json`. Báo cáo HTML lưu trong `data/reports/`, tự tạo báo cáo 7 ngày vào thứ Hai.

## Các module

- **Tổng quan**: Brand Health Score, KPI, xu hướng tuần, phân bố sao, chi nhánh.
- **Google Review**: lọc 1-5 sao, theo chi nhánh, nội dung, ngày lấy dữ liệu, link Google.
- **Sentiment Analysis, Topics & Keywords**: cảm xúc, chủ đề (nhân viên, chi phí, hoàn tiền, biến chứng...), từ khóa.
- **Share of Voice**: tỷ trọng thương hiệu so với đối thủ trên Google Search/News, so sánh review.
- **Crisis Monitoring, Cảnh báo real-time**: review nghiêm trọng, tăng đột biến, tụt điểm sao, và **nghi review tấn công** (nhiều tài khoản đăng cùng nội dung).
- **Reputation Tracking, Báo cáo tự động**.
- **Social Listening**: chưa làm (giai đoạn sau), hiện là trang trống có chủ đích.

## Brand Health Score

Trung bình có trọng số của: điểm sao 90 ngày (35%), cân bằng cảm xúc 90 ngày (25%), mức an toàn 30 ngày dựa trên tỷ lệ tiêu cực và review nghiêm trọng (25%), mức hiện diện so với đối thủ theo số review 30 ngày (15%). Không có đối thủ thì chia lại trọng số. Công thức nằm trong `lib/metrics.js` (`healthScore`), chỉnh được trọng số ở đó.

## Lưu ý

- Chưa có đăng nhập. Mặc định chỉ lắng nghe `127.0.0.1`; **không mở ra internet** khi chưa thêm xác thực.
- Dữ liệu Google Maps lấy qua dịch vụ bên thứ ba: bạn tự kiểm tra điều khoản của nhà cung cấp và Google trước khi dùng cho khách hàng.
- Số liệu Share of Voice phụ thuộc `domains` và `keywords` bạn khai báo cho từng brand.

## Cấu trúc

```
server.js            máy chủ, API, lịch tự động
lib/sync.js          đồng bộ dữ liệu, snapshot hằng ngày
lib/providers/       serpapi.js (thật), mock.js (mẫu); thêm nguồn mới tại đây
lib/analysis.js      cảm xúc/chủ đề (Claude hoặc bộ luật)
lib/metrics.js       Health Score, SoV, thống kê
lib/crisis.js        quy tắc cảnh báo
lib/report.js        báo cáo HTML
public/              giao diện
config/brands.json   khai báo brand, chi nhánh, đối thủ
```
