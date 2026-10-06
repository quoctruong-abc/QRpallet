# Phase 2 — Chọn vị trí khi scan pallet

## Trạng thái

`HOLD` — ngày 28/09/2026.

Database và các file độc lập của phase 2 vẫn được giữ lại, nhưng luồng runtime
đã được tháo hoàn toàn khỏi main stream. Frontend scan và API scan hiện khớp với
bản ổn định trước phase 2; user không nhìn thấy vị trí, không cần chọn vị trí và
scan gọi RPC một tham số như trước.

## Logic đã chốt cho phase 2

1. Ô chọn vị trí nằm trong màn hình camera, giữa khung canh QR và bảng lịch sử
   scan rút gọn.
2. Danh sách vị trí lấy từ `warehouse_positions`, chỉ nhận vị trí đang active và
   tìm kiếm theo mã hoặc tên dạng search-as-you-type.
3. User chọn vị trí trước rồi quét toàn bộ pallet được kéo vào vị trí đó.
4. Vị trí đã chọn được giữ trong `sessionStorage`; không reset sau từng pallet,
   khi đóng/mở camera hoặc sau khi xác nhận phiếu.
5. Khi user đang mở danh sách để đổi vị trí, camera vẫn hiển thị nhưng kết quả QR
   tạm thời bị bỏ qua để không ghi nhầm vào vị trí cũ.
6. Scan phase 2 gửi đồng thời `palletId` và `position`. RPC hai tham số kiểm tra
   quyền, vị trí active và ghi `pendingWH + scanned_by + scanned_at + position`
   trong cùng một transaction.
7. Bảng pallet và lịch sử camera hiển thị vị trí; ô tìm kiếm cũng tìm theo vị trí.
8. Khi xác nhận phiếu, `wh_data_pallet` nhận snapshot từ `pallet_data`, gồm
   `pallet_data_id`, `itemcode`, `quantity`, `pallet_id` và `position`.
9. Sau snapshot, vị trí trong `wh_data_pallet` là dữ liệu nghiệp vụ kho độc lập;
   phase sau có thể đổi vị trí kho mà không sửa dữ liệu nguồn sản xuất.

## Thành phần đang được giữ lại

- Bảng `warehouse_positions` và dữ liệu mẫu.
- Cột `pallet_data.position`.
- Bảng `wh_data_pallet`, cột `position` và các khóa ngoại/index.
- RPC `scan_pallet_to_pending(text, text)` cho phase 2.
- API `/api/scan-qr/positions`.
- Component chọn vị trí `app/scan-qr/scan-position-dialog.tsx`.
- RPC một tham số vẫn là RPC của main stream hiện tại và sẽ ghi `position = null`
  cho lượt scan mới.

## Checklist mở lại phase 2

1. Dùng commit `45ac986` làm mốc tham chiếu để đưa lại phần frontend, API scan và
   CSS của phase 2; không bật lại bằng feature flag trên luồng production cũ.
2. Thêm lại `position` vào danh sách `.select(...)` tại `app/scan-qr/page.tsx` để
   các pallet đang chờ hiển thị đúng vị trí sau khi reload.
3. Xác nhận các migration vị trí và `wh_data_pallet` đã chạy trên database đích.
4. Test đủ bốn case: chưa chọn vị trí, đổi vị trí giữa phiên, vị trí bị khóa và
   xác nhận phiếu tạo snapshot kho.
5. Sau khi test đạt mới bật cho user production.
