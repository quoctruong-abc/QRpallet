# Scan → tồn kho: CHƯA KÍCH HOẠT

`activate_scan_stock.sql` được giữ ngoài `supabase/migrations` theo yêu cầu của
user. Không copy/move, đổi acknowledgement hoặc chạy lên database thật cho tới
khi user yêu cầu kích hoạt. `supabase db push` hiện chỉ cài phần chuẩn bị.

File còn có chốt `__WAITING_FOR_USER_APPROVAL__`: copy nhầm sang migrations vẫn
bị từ chối. Test chỉ đổi acknowledgement trong chuỗi SQL ở bộ nhớ trên database
cục bộ tạm; không sửa file đang giữ và không kết nối Supabase.

## Những gì đã chuẩn bị

- Migration `20261119090000_prepare_scan_stock_bridge.sql` thêm nguồn scan vào
  `inv_incoming`, unique pallet-version ID, hàm bridge, validator và RPC recovery.
- Không gắn trigger, không sửa chữ ký/body/ACL RPC confirm, không backfill stock.
- Existing/manual/opening rows giữ dữ liệu cũ. Customer được phép trống cho scan,
  như manual; các constraint mới dùng NOT VALID để tránh quét validate bảng cũ.
- Không tạo FK mới tới production; ID pallet gốc được kiểm tra trong transaction.
- `inv_scan_stock_activation` chỉ là dấu vết go-live, không phải cờ tự bật luồng.
- `supabase/operations/scan_stock_preflight.sql` là báo cáo CHỈ ĐỌC cho SQL Editor
  bằng database owner, dùng sau khi cài preparation. Authenticated/service-role
  không được gọi trực tiếp helper ghi tồn, validator hoặc preflight nội bộ.

## Khi user yêu cầu bật

1. Lấy báo cáo read-only từ database thật. Blockers phải rỗng. Kiểm tra version
   PostgreSQL, RPC fingerprints, trigger tùy chỉnh và nguồn nhập ngoài app.
   Hash hiện được duyệt là RPC scan trong migration `20260922090000` và legacy
   receipt trong `supabase/20260719_fix_create_warehouse_receipt_lock.sql`.
   Nếu khác, review/test bản SQL thực tế; không bỏ qua guard để ép kích hoạt.
2. Chốt tồn đầu và mốc nhận hàng. Tạm ngưng riêng confirm scan trong lúc chốt
   để không có pallet được xác nhận giữa snapshot tồn đầu và go-live mà chưa
   có trong cả hai nguồn. Dừng nhập tay/tồn đầu cho các pallet sẽ nhận qua scan.
   Quá trình tạo/in pallet và kế hoạch production có thể tiếp tục.
3. Chỉ lúc đó thay acknowledgement bằng ghi chú chốt tồn có ý nghĩa, chuyển file
   sang `supabase/migrations/<timestamp_hien_tai>_activate_scan_stock.sql`.
   Không dùng timestamp chuẩn bị cũ nếu đã có migration mới hơn.
4. Chạy migration. Khóa DDL chờ tối đa 2 giây; statement tối đa 30 giây. Không
   lấy inventory advisory lock trước DDL locks: tránh inversion với confirm.
   Nếu không lấy được khóa hoặc preflight fail, transaction rollback hoàn toàn.
5. Kiểm tra 2 trigger và activation audit. Theo dõi phiếu đầu tiên bằng đối soát
   chỉ đọc: count pallet, sum received và ID nguồn phải khớp; không nhập lại phiếu.

## Logic sau kích hoạt

- `AFTER UPDATE ... FOR EACH STATEMENT` trên `pallet_data` chỉ xử lý các dòng vừa
  chuyển từ pending/processing sang WHdone, một INSERT kho theo batch.
- Ngày nhập lấy trên receipt; ngày sản xuất lấy working_day gốc, NULL giữ nguyên.
  Tên/khách snapshot pallet được ưu tiên, thiếu mới dùng shared identity read-only.
- Một pallet-version ID chỉ có một dòng nguồn scan. Không dùng ON CONFLICT DO
  NOTHING để che xung đột. Position edit hoặc WHdone → WHdone không nhập lại.
- Constraint trigger trên receipt chạy tại COMMIT, kiểm tra count/sum và từng
  nguồn. Nó chặn cả trường hợp cancellation race làm RPC cập nhật thiếu/zero row.
- Lỗi trong bridge/validator rollback receipt, WHdone, warehouse snapshot và stock.
- Inventory lock chờ tối đa 5 giây; bận thì rollback và thông báo thử lại.
- Quyền scan giữ ở RPC hiện tại. Bridge không bắt scanner phải có edit-WH.
  Duyệt Proposal/manual/ERP và FIFO xuất tiếp tục theo phân quyền đã triển khai.
- Recovery chỉ trả toàn bộ receipt đúng operator và đúng tập pallet. Nó không
  ghi/backfill tồn và không trả phiếu của người khác hoặc một tập con của phiếu.

## Rủi ro cần xử lý trước production

| Rủi ro | Chốt bảo vệ / việc cần làm |
|---|---|
| Tồn đầu/nhập tay đã chứa pallet sẽ scan | Unique source không phát hiện được trùng giữa số tổng hợp và pallet. Phải chốt mốc và ngưng nhập trùng nghiệp vụ. |
| Database thật khác repo | Preflight chặn RPC drift, receipt writer/reversal lạ, stock bridge/backflow trigger khác hoặc inventory trigger thiếu. Cần đọc report thật trước khi move file. |
| Thiếu tên, itemcode lỗi, WO quá 200 ký tự | Preflight liệt kê pending lỗi; dữ liệu mới sau preflight vẫn được validate trong confirm và rollback nếu không hợp lệ. Customer/ngày SX trống được chấp nhận. |
| Migration chuẩn bị trên bảng tồn kho lớn | Thêm cột/constraint và tạo unique index vẫn cần khóa/quét index, dù chưa bật scan. Chạy lúc ít tải; chờ khóa tối đa 2s, mỗi statement tối đa 30s, lỗi sẽ rollback. Không coi preparation là zero-downtime. |
| DDL khóa hoặc FIFO dài | Migration có lock timeout 2s; confirm có inventory lock timeout 5s. Lỗi bận có thể xuất hiện hợp lệ dưới tải cao, cần retry và theo dõi lock. |
| Tắt nhầm bridge sau go-live | Giữ receipt validator để fail closed; không drop/tắt cả hai trigger rồi tiếp tục confirm vì sẽ tạo khoảng hở stock. Dừng confirm, xử lý nguyên nhân, rồi bật lại. |
| SQL/service script sửa WHdone hoặc xóa nguồn scan | Các thao tác ngoài RPC đã duyệt không thuộc bảo đảm của luồng. Không reverse WHdone/receipt hay sửa ledger trực tiếp; cần nghiệp vụ điều chỉnh riêng. |
| Trigger/schema tùy chỉnh chưa biết | Fixture test không phải bản sao production. Đối chiếu thêm trigger thực tế từ báo cáo, nhất là luồng ghi ngược inventory → pallet. |

## Kết quả kiểm thử

- `npm run test:scan-stock`: PostgreSQL engine PGlite + contract API; preparation
  không hoạt động, handbrake, drift, no backfill, mapping, rollback, source unique,
  commit reconciliation, legacy RPC, scoped recovery, 200 pallet và bigint.
- `SCAN_POSTGRES_BIN=/usr/lib/postgresql/17/bin npm run test:scan-stock:postgres`:
  tự init và hủy cluster local, không nhận database URL. Đã chạy trên PostgreSQL
  17.11 với nhiều session: migration lock timeout, RPC chạy dở qua cutover,
  same/overlap batch, FIFO song song cả hai thứ tự khóa, lock timeout + production edit, cancel race,
  disable bridge fail-closed và không kích hoạt hai lần. Batch 200 pallet đo được
  khoảng 42–52ms trên cluster test; không coi đây là cam kết thời gian production.
- Existing `npm run test:delivery` kiểm tra tiếp manual/ERP/Proposal/FIFO.

Tài liệu PostgreSQL tham khảo: [trigger/transition tables](https://www.postgresql.org/docs/17/sql-createtrigger.html),
[locking](https://www.postgresql.org/docs/17/explicit-locking.html).
