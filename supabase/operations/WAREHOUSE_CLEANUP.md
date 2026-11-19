# Kiểm tra và dọn dữ liệu kho trước go-live

Đây là reset **toàn bộ dữ liệu nghiệp vụ trong 11 bảng**, không phải lọc tự động
các dòng test. Schema hiện không có `is_test`/mã đợt test chung. Chỉ dùng khi toàn
bộ 11 bảng dưới đây đều là dữ liệu thử; nếu đã trộn tồn/lịch giao thật thì phải
lập danh sách ID/phạm vi nghiệp vụ riêng, không dùng bản reset này.

Hai file SQL nằm ngoài migrations. `supabase db push` không chạy chúng. Chưa có
thao tác nào trên database production; việc rà soát này dựa trên schema/code và
database test cục bộ. Báo cáo DB thật vẫn cần chạy trước khi quyết định xóa.

| Bảng sẽ xóa dữ liệu | Nghiệp vụ |
|---|---|
| `inv_incoming` | Lô nhập, số nhận/đã xuất/tồn, nguồn nhập |
| `inv_incoming_batches` | Batch nhập đã ghi nhận, payload và chống retry trùng |
| `inv_opening_imports` | Lịch sử/fingerprint nạp tồn đầu |
| `inv_incoming_proposals` | Header đề xuất nhập kho |
| `inv_incoming_proposal_lines` | Dòng pending/posted/cancelled và liên kết batch duyệt |
| `inv_delivery_requests` | Lịch giao ERP/manual, dòng mẹ/con/origin, số yêu cầu/đã giao |
| `inv_delivery_issues` | Phiếu/lần xuất thực tế |
| `inv_delivery_issue_lines` | Lô FIFO và số lượng đã lấy cho từng lần xuất |
| `inv_delivery_commands` | Command/audit, payload/kết quả và chống retry trùng |
| `inv_delivery_reservations_legacy` | Đăng ký lô của flow cũ, giữ quan hệ FK tới nhập/yêu cầu |
| `inv_stock_summary` | Tổng tồn, on order, khả dụng và thiếu hàng theo item |

`inv_delivery_reservations` đã đổi tên thành `inv_delivery_reservations_legacy`
trong migration summary, hiện không có bảng reservation mới theo từng lô trong
schema repo. Nếu DB thật còn bảng này hoặc có thêm bảng `inv_*` chưa duyệt,
script từ chối. On order hiện được tổng hợp từ yêu cầu giao, không book lô riêng.

## Những dữ liệu giữ nguyên

- `item_pallet_config`: mã/tên/khách hàng/ERP name/khối lượng/số lượng pallet chẵn.
- `item_build_up`: các bộ mẹ/con và trạng thái active.
- `warehouse_positions`: danh mục vị trí kho.
- `pallet_data`, `wh_data_pallet`, `wh_receipt`, `pallet_change_history`: production,
  scan, snapshot kho, phiếu nhập và lịch sử pallet đang dùng.
- `planning_inject`, `shift_report_data`, tài khoản và toàn bộ phân quyền.
- `inv_scan_stock_activation`: dấu vết kích hoạt, tuyệt đối không reset bằng file này.

Receipt → Nhập kho cũ vẫn còn dữ liệu vì đọc phiếu scan/production được bảo toàn.
Receipt → Xuất kho thử sẽ hết do lịch sử xuất thuộc các bảng `inv_delivery_*`.
Tab Đối soát hiện là placeholder, chưa có bảng đối soát ERP riêng trong repo.

## Thứ tự thực hiện khi dữ liệu đã được xác nhận là test

1. Trong SQL Editor bằng database owner, chạy **`warehouse_cleanup_preview.sql`**.
   Báo cáo chỉ đọc: số dòng, JSON `expected_manifest` có fingerprint dữ liệu,
   khóa ngoại, bảng lạ và trigger có thể liên quan. Nếu thiếu bảng, đồng bộ schema
   hoặc kiểm tra DB thực tế trước; không bỏ bớt tên bảng để ép xóa.
2. Xuất bản sao 11 bảng đã duyệt. Manifest chỉ để phát hiện thay đổi, **không phải
   backup** và không chứng minh dữ liệu là test.
3. Tạm ngừng thao tác ghi kho/import/duyệt/cập nhật master; đóng các tab Quản lý
   kho trên mọi thiết bị. Tạo/in pallet và scan cũ có thể tiếp tục khi bridge chưa
   kích hoạt. Không chạy migration kích hoạt đồng thời với cleanup.
4. Mở **`clear_warehouse_test_data.sql`** trong SQL Editor. Chỉ sau khi duyệt mới
   đổi `acknowledgement` thành `CLEAR_ONLY_PREACTIVATION_WAREHOUSE_TEST_DATA` và
   dán JSON vừa kiểm tra vào biến `expected_manifest`, ví dụ:

   ```sql
   acknowledgement text:='CLEAR_ONLY_PREACTIVATION_WAREHOUSE_TEST_DATA';
   expected_manifest jsonb:='{...JSON đầy đủ từ preview...}'::jsonb;
   ```

5. Chạy toàn bộ file. Một transaction, một `TRUNCATE` chỉ rõ 11 bảng, `RESTRICT`,
   `CONTINUE IDENTITY`. Không CASCADE, không DROP, không tắt trigger, không sửa
   schema hay reset số ID. Các bảng có FK và bảng self-link mẹ/con được xóa cùng
   một statement. Summary cũng được xóa để không còn on order/tồn thử.
6. Nếu lỗi, chạy `ROLLBACK;` trước lần thử lại. Bản chưa sửa acknowledgement,
   preview cũ/thiếu, khóa đang bận, FK ngoài phạm vi, trigger truncate lạ, bảng
   kế thừa/phân vùng, stock link receipt, audit/trigger scan (kể cả disable) đều
   làm thao tác bị từ chối và rollback. Không bỏ các guard để ép chạy.
7. Chạy lại preview: 11 bảng phải có số dòng 0. Kiểm tra master/production/phiếu
   cũ vẫn còn. Script không restart identity nên ID nhập mới tiếp tục tăng.
8. Xóa **đúng bộ nhớ thử của kho** trên từng trình duyệt đã test, rồi tải lại app.
   SQL không xóa được local/session storage; pending command cũ có thể được gửi
   lại sau khi bảng chống retry đã bị reset. Có thể chạy trong DevTools Console
   của chính app, sau khi đã duyệt bỏ các nháp thử:

   ```javascript
   for (const key of Object.keys(localStorage)) {
     if (key.startsWith('warehouse-incoming-v2:') ||
         key.startsWith('warehouse-outgoing-command-v1:')) localStorage.removeItem(key);
   }
   sessionStorage.removeItem('warehouse-incoming-pending-v1');
   location.reload();
   ```

Không dùng `localStorage.clear()` vì sẽ xóa cả tùy chọn không liên quan. Những
tab chưa tải lại có thể còn state trong RAM, nên cần đóng/tải lại trên mọi máy.

## Vì sao dùng khóa NOWAIT và thử advisory lock

Cleanup lấy khóa bảng đích `ACCESS EXCLUSIVE NOWAIT`, rồi chỉ **thử** lấy inventory
advisory lock. Bận ở bất kỳ bước nào thì rollback ngay, tránh chờ vòng với một
writer đã khóa bảng hoặc đang giữ inventory lock. Khóa `ROW EXCLUSIVE` trên hai
bảng production/receipt chỉ để ngăn DDL kích hoạt chen vào trong lúc kiểm tra;
khóa này tương thích với ghi dòng production/scan thông thường.

## Sau cleanup và trước kích hoạt scan

Nạp tồn đầu thực tế và lịch giao thực tế theo mốc đã chốt. Tạm ngưng confirm scan
trong giai đoạn chốt tồn đầu → kích hoạt để không bỏ sót/cộng trùng pallet.
Cleanup không tự đưa pallet WHdone cũ sang `inv_incoming`; scan bridge cũng không
backfill chúng. Xác nhận cách phản ánh các pallet cũ trong tồn đầu thực tế.

Sau đó chạy `scan_stock_preflight.sql`, kiểm tra blockers, rồi chỉ chuyển SQL
kích hoạt vào migrations khi user yêu cầu. Không xóa audit hay tắt trigger để
dùng lại script cleanup sau go-live; khi đó phải dùng nghiệp vụ điều chỉnh riêng.

Kiểm thử: `npm run test:warehouse-cleanup`. Các test dùng database cục bộ, đổi
acknowledgement/manifest trong bộ nhớ; file SQL nguồn vẫn khóa mặc định.

Đã kiểm tra reset đủ 11 bảng có FK/self-link, rollback cả khi lỗi xảy ra sau
TRUNCATE, bảo toàn master/production/receipt/sequence và luồng nhập mới sau reset.
Test PostgreSQL 17.11 nhiều session kiểm tra NOWAIT, writer đang giữ inventory
lock, preview cũ, ghi production song song và ngăn DDL kích hoạt chen ngang:

```bash
CLEANUP_POSTGRES_BIN=/usr/lib/postgresql/17/bin npm run test:warehouse-cleanup:postgres
```

Script test tự tạo/hủy cluster local và không nhận URL database có sẵn.
