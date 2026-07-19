# QRpallet — Logic & Business Rules

README này là nguồn tham chiếu chính cho **logic nghiệp vụ**, **workflow**, **phân quyền**, **API** và **database** của dự án QRpallet.

Tài liệu không mô tả chi tiết giao diện. Khi thay đổi trạng thái pallet, quyền thao tác, API ghi dữ liệu, RPC, bảng hoặc field nghiệp vụ, README phải được cập nhật trong cùng đợt thay đổi.

---

## 1. Phạm vi hệ thống hiện tại

QRpallet quản lý luồng pallet từ kế hoạch sản xuất đến khi hoàn tất nhập kho:

```text
Planning
→ Production tạo và in tem pallet
→ Warehouse scan pallet
→ Warehouse xác nhận danh sách scan
→ Production xác nhận nhập kho
→ WHdone
```

Các nhóm nghiệp vụ chính:

1. Cập nhật kế hoạch sản xuất.
2. Tạo, in, sửa, xóa hiệu lực và gộp pallet.
3. Scan pallet để chuyển sang luồng nhập kho.
4. Xác nhận danh sách pallet đã scan.
5. Trả pallet về Production trước khi hoàn tất nhập kho.
6. Tạo phiếu nhập kho và khóa pallet tại `WHdone`.
7. Theo dõi người và thời gian thực hiện từng bước.
8. Ghi lịch sử chi tiết khi pallet bị sửa hoặc xóa.

Giai đoạn hiện tại chỉ triển khai đến `WHdone`. Chưa triển khai tồn kho thực tế, tách/gộp pallet trong kho hoặc xuất kho.

---

## 2. Công nghệ và nguyên tắc kiến trúc

- Application: Next.js App Router.
- Authentication: Supabase Auth.
- Database: Supabase PostgreSQL.
- Authorization: role, position và permission; kiểm tra phía server.
- Deploy: Vercel.
- Database transaction: ưu tiên RPC PostgreSQL cho các nghiệp vụ thay đổi nhiều record hoặc cần khóa dữ liệu.

Nguyên tắc bắt buộc:

- Client không được tự cập nhật trạng thái pallet trực tiếp.
- Mọi API ghi dữ liệu phải xác thực user và kiểm tra permission phía server.
- RPC phải kiểm tra trạng thái hiện tại trước khi update.
- Nghiệp vụ nhiều bước phải hoàn thành trong cùng transaction.
- Khi cần khóa record, khóa các dòng pallet trước bằng `FOR UPDATE`, sau đó mới chạy `count`, `sum` hoặc aggregate khác.
- Không dùng `FOR UPDATE` trực tiếp trên câu query aggregate.

---

## 3. Role, position và permission

### 3.1 Role

| Role | Quy tắc |
|---|---|
| `superadmin` | Toàn quyền và bỏ qua permission check thông thường |
| `admin` | Có các permission mặc định thuộc position của mình |
| `user` | Chỉ có permission được gán trong `user_permissions` |

### 3.2 Position

| Position | Trách nhiệm nghiệp vụ |
|---|---|
| `planning` | Cập nhật và điều chỉnh kế hoạch |
| `production` | Tạo pallet, quản lý pallet Production và xác nhận nhập kho |
| `warehouse` | Scan pallet, xác nhận scan và trả pallet chưa nhập kho về Production |

Giá trị legacy:

```text
pallet  → production
scanner → warehouse
```

### 3.3 Permission

| Permission | Nghiệp vụ |
|---|---|
| `planning.upload` | Import và replace kế hoạch |
| `planning.change` | Điều chỉnh thông tin kế hoạch được cho phép |
| `pallet.create` | Tạo pallet, gộp WO, tìm và in lại tem |
| `pallet.edit` | Sửa hoặc xóa hiệu lực pallet Production |
| `scan.standard` | Scan, xác nhận scan và hủy scan ở giai đoạn `pendingWH` |
| `receipt.create` | Production review, tạo phiếu và chuyển pallet sang `WHdone` |
| `receipt.edit` | Warehouse trả pallet `processingWH` về `production` |

### 3.4 Permission mặc định theo position

| Position | Permission mặc định cho admin |
|---|---|
| `planning` | `planning.upload`, `planning.change` |
| `production` | `pallet.create`, `pallet.edit`, `receipt.create` |
| `warehouse` | `scan.standard`, `receipt.edit` |

Module xác nhận chuyển kho được dùng chung:

- Production truy cập bằng `receipt.create`.
- Warehouse truy cập bằng `receipt.edit`.
- Superadmin có cả hai nghiệp vụ.

---

## 4. Workflow trạng thái pallet

Workflow chuẩn:

```text
production
→ pendingWH
→ processingWH
→ WHdone
```

Ý nghĩa trạng thái:

| Status | Ý nghĩa |
|---|---|
| `production` | Pallet đang thuộc trách nhiệm Production |
| `pendingWH` | Pallet đã được Warehouse scan, chưa xác nhận danh sách |
| `processingWH` | Danh sách scan đã được xác nhận, đang chờ Production xác nhận nhập kho |
| `WHdone` | Đã tạo phiếu nhập kho và kết thúc phạm vi workflow hiện tại |

Luồng trả về hợp lệ:

```text
pendingWH    → production
processingWH → production
```

Không có luồng:

```text
WHdone → production
```

### 4.1 Quy tắc `WHdone`

`WHdone` là trạng thái cuối trong giai đoạn hiện tại:

- Không sửa số lượng pallet.
- Không xóa pallet.
- Không trả về Production.
- Không hủy phiếu để đảo trạng thái.
- Chỉ được xem dữ liệu và in lại phiếu.

Nếu sau này phát hiện sai lệch sau `WHdone`, phải xử lý bằng nghiệp vụ điều chỉnh kho riêng, không sửa dữ liệu pallet gốc của Production.

---

## 5. Nghiệp vụ theo từng module

## 5.1 Planning

Bảng chính:

```text
planning_inject
```

Nghiệp vụ:

- Import kế hoạch từ Excel.
- Replace dữ liệu kế hoạch hiện tại theo RPC/import flow.
- Cho phép điều chỉnh trường được phân quyền, hiện tại có đổi máy.
- Pallet Label đọc kế hoạch này để xác định máy, WO, item, khách hàng và số lượng order.

Điều kiện dùng cho in tem:

```text
WO không trống
WO khác "0"
```

API chính:

| API | Permission |
|---|---|
| `/api/planning-inject/import` | `planning.upload` |
| `/api/planning-inject/change-machine` | `planning.change` |

---

## 5.2 Pallet Production

Bảng chính:

```text
pallet_data
item_pallet_config
```

Nghiệp vụ:

- Tạo pallet từ một dòng kế hoạch hợp lệ.
- Sinh `pallet_id` tại database.
- Pallet mới có trạng thái `production`.
- In PDF chứa QR của `pallet_id`.
- Hỗ trợ pallet chẵn và pallet lẻ.
- Hỗ trợ gộp hai WO; pallet mới lấy thông tin nền từ WO thứ nhất và lưu dấu vết WO gộp trong `note`.
- Tìm lịch sử pallet theo WO, itemcode hoặc khoảng thời gian.
- Hỗ trợ khoảng thời gian 1, 7 và 30 ngày khi không nhập WO/itemcode.

### 5.2.1 Sửa pallet

Chỉ được sửa khi:

```text
status = production
effect_to is null
```

Bắt buộc:

- Nhập số lượng mới hợp lệ.
- Nhập lý do sửa.
- Lý do không được rỗng sau `trim`.

Khi sửa:

- Cập nhật số lượng.
- `has_been_edited = true`.
- Tăng `edit_count`.
- Ghi một dòng `edit` vào `pallet_change_history`.
- Lưu snapshot trước và sau khi sửa.

RPC:

```text
edit_pallet_quantity_tracked
```

### 5.2.2 Xóa pallet

Chỉ được xóa khi:

```text
status = production
effect_to is null
```

Xóa là soft delete, không xóa vật lý:

```text
effect_to = now()
deleted_at = now()
deleted_by = auth.uid()
```

Bắt buộc nhập lý do xóa.

Khi xóa:

- Giữ nguyên record pallet trong database.
- Ghi một dòng `delete` vào `pallet_change_history`.
- Lưu snapshot trước và sau thao tác.

RPC:

```text
delete_pallet_record_tracked
```

API chính:

| API/action | Permission |
|---|---|
| Create pallet | `pallet.create` |
| Merge WO | `pallet.create` |
| Search/reprint | `pallet.create` |
| Edit pallet | `pallet.edit` |
| Delete pallet | `pallet.edit` |

---

## 5.3 Scan QR

Bảng chính:

```text
pallet_data
```

Permission:

```text
scan.standard
```

### 5.3.1 Scan pallet

Điều kiện:

```text
pallet tồn tại
pallet còn hiệu lực
status = production
```

Kết quả:

```text
production → pendingWH
```

Traceability tự ghi:

```text
scanned_at
scanned_by
```

RPC:

```text
scan_pallet_to_pending
```

### 5.3.2 Hủy pallet đã scan

Chỉ hợp lệ khi:

```text
status = pendingWH
```

Kết quả:

```text
pendingWH → production
```

Traceability tự ghi:

```text
returned_at
returned_by
return_from_status = pendingWH
```

### 5.3.3 Xác nhận danh sách scan

Chỉ xác nhận khi tất cả pallet được yêu cầu:

```text
còn hiệu lực
status = pendingWH
```

Kết quả:

```text
pendingWH → processingWH
```

Traceability tự ghi:

```text
scan_confirmed_at
scan_confirmed_by
```

RPC hiện hành:

```text
confirm_pending_pallets_tracked
```

Quy tắc khóa:

1. Khóa từng dòng pallet bằng `FOR UPDATE`.
2. Sau đó mới kiểm tra số lượng và trạng thái.
3. Update toàn bộ trong cùng transaction.

---

## 5.4 Xác nhận chuyển kho và nhập kho

Module này được Production và Warehouse cùng truy cập nhưng ownership khác nhau.

### 5.4.1 Warehouse: trả về Production

Permission:

```text
receipt.edit
```

Chỉ hợp lệ khi:

```text
status = processingWH
effect_to is null
```

Kết quả:

```text
processingWH → production
```

Đồng thời:

```text
wh_receipt = null
```

Traceability tự ghi:

```text
returned_at
returned_by
return_from_status = processingWH
```

RPC:

```text
cancel_processing_pallets
```

Quy tắc transaction:

1. Khóa từng pallet bằng `FOR UPDATE`.
2. Kiểm tra đầy đủ danh sách và trạng thái.
3. Chỉ update nếu toàn bộ danh sách hợp lệ.
4. Không update một phần.

### 5.4.2 Production: review và xác nhận nhập kho

Permission:

```text
receipt.create
```

Chỉ hợp lệ khi toàn bộ pallet:

```text
status = processingWH
effect_to is null
```

Nghiệp vụ:

1. Khóa từng pallet bằng `FOR UPDATE`.
2. Sau khi khóa mới tính tổng pallet và tổng số lượng.
3. Sinh `receipt_id` theo ngày và số thứ tự.
4. Tạo record trong `wh_receipt`.
5. Gắn `wh_receipt` vào các pallet.
6. Chuyển toàn bộ pallet sang `WHdone`.
7. Xuất PDF phiếu nhập kho.

Kết quả:

```text
processingWH → WHdone
```

Traceability tự ghi:

```text
warehouse_done_at
warehouse_done_by
```

RPC:

```text
create_warehouse_receipt
```

### 5.4.3 Phiếu đã tạo

Phiếu nhập kho đã tạo:

- Không được hủy.
- Không đảo pallet từ `WHdone` về Production.
- Chỉ được tìm, xem lịch sử và in lại.

API `/api/warehouse-receipt/void` đã bị loại bỏ khỏi workflow.

---

## 6. Traceability trên `pallet_data`

Các mốc nghiệp vụ được lưu trực tiếp trên record pallet:

```text
created_at
created_by

scanned_at
scanned_by

scan_confirmed_at
scan_confirmed_by

warehouse_done_at
warehouse_done_by

returned_at
returned_by
return_from_status
```

Các field theo dõi chỉnh sửa và xóa:

```text
has_been_edited
edit_count
deleted_at
deleted_by
```

Trigger:

```text
track_pallet_workflow_fields
```

Trigger có trách nhiệm:

- Ghi thời gian và người thực hiện khi trạng thái thay đổi hợp lệ.
- Chặn transition không hợp lệ.
- Chặn thay đổi record đã ở `WHdone`.

User thực hiện lấy từ:

```text
auth.uid()
```

Không nhận user ID từ payload phía client.

---

## 7. Lịch sử edit và delete

Bảng:

```text
pallet_change_history
```

Chỉ ghi hai action:

```text
edit
delete
```

Field chính:

```text
id
pallet_id
action
changed_at
changed_by
old_data jsonb
new_data jsonb
reason
```

Quy tắc:

- `reason` bắt buộc và không được rỗng.
- Transition trạng thái bình thường không ghi vào bảng này.
- Snapshot chứa dữ liệu đầy đủ của pallet trước và sau thao tác.
- Client không được insert trực tiếp vào history.
- RPC edit/delete ghi history trong cùng transaction với update pallet.

---

## 8. Database ownership

| Bảng | Ownership nghiệp vụ | Module đọc phụ |
|---|---|---|
| `profiles` | Auth/Admin | Tất cả module |
| `user_permissions` | Auth/Admin | Authorization helpers |
| `planning_inject` | Planning | Production Pallet |
| `item_pallet_config` | Production Pallet | — |
| `pallet_data` | Production giữ dữ liệu pallet gốc | Scan và Warehouse flow |
| `pallet_change_history` | Audit edit/delete pallet | Admin/audit khi cần |
| `wh_receipt` | Phiếu nhập kho | Reprint/history |

### 8.1 Ownership dữ liệu pallet

`pallet_data` là nguồn dữ liệu pallet gốc do Production tạo.

Sau khi `WHdone`:

- Record pallet gốc không được sửa.
- Không thay đổi quantity gốc.
- Không dùng pallet Production làm record tồn kho để tách/gộp trong tương lai.

Khi mở rộng Warehouse, mô hình dự kiến:

```text
pallet_data
→ warehouse_pallet_source
→ warehouse_pallet
→ warehouse_transaction
```

Các bảng Warehouse này chưa thuộc phạm vi triển khai hiện tại.

---

## 9. API authorization map

| Nghiệp vụ | Permission |
|---|---|
| Import kế hoạch | `planning.upload` |
| Điều chỉnh kế hoạch | `planning.change` |
| Tạo/gộp/tìm/in lại pallet | `pallet.create` |
| Sửa/xóa pallet Production | `pallet.edit` |
| Scan/xác nhận/hủy scan `pendingWH` | `scan.standard` |
| Production tạo phiếu và chuyển `WHdone` | `receipt.create` |
| Warehouse trả `processingWH` về Production | `receipt.edit` |

Mọi API ghi dữ liệu phải dùng:

```ts
await authorizePermission("permission.key")
```

Không dùng việc ẩn chức năng ở client để thay thế authorization phía server.

---

## 10. Quy tắc RPC và transaction

Mỗi RPC chuyển trạng thái phải:

1. Kiểm tra `auth.uid()`.
2. Kiểm tra danh sách đầu vào không rỗng.
3. Khóa các record pallet thực tế bằng `FOR UPDATE`.
4. Sau khi khóa mới chạy aggregate nếu cần.
5. Xác nhận toàn bộ pallet đúng trạng thái.
6. Không update một phần nếu có pallet không hợp lệ.
7. Update trạng thái và dữ liệu liên quan trong cùng transaction.
8. Trả lỗi rõ ràng như `PALLET_STATUS_CHANGED`, `NO_PALLETS`, `WHDONE_LOCKED`.

Mẫu không hợp lệ:

```sql
select count(*)
from public.pallet_data
for update;
```

Mẫu đúng:

```sql
perform 1
from public.pallet_data
where pallet_id = any(p_pallet_ids)
for update;

select count(*), sum(quantity)
from public.pallet_data
where pallet_id = any(p_pallet_ids);
```

---

## 11. Migration liên quan workflow hiện tại

Các migration mới quan trọng:

```text
supabase/20260718_pallet_traceability.sql
supabase/20260718_fix_confirm_pending_lock.sql
supabase/20260719_fix_create_warehouse_receipt_lock.sql
supabase/20260719_fix_cancel_processing_pallets_lock.sql
```

Quy tắc migration:

- Tạo file migration mới; không sửa file đã chạy trên môi trường dùng chung.
- Migration mới có thể dùng `create or replace function` để thay RPC hiện hành.
- Sau khi thêm migration, phải chạy trên Supabase trước khi test nghiệp vụ tương ứng.
- Thay đổi code API không tự cập nhật function trong database.

---

## 12. Checklist nghiệp vụ trước khi merge

### Authorization

- [ ] Production chỉ xác nhận nhập kho bằng `receipt.create`.
- [ ] Warehouse chỉ trả pallet về Production bằng `receipt.edit`.
- [ ] Scan action chỉ dùng `scan.standard`.
- [ ] Edit/delete chỉ dùng `pallet.edit`.
- [ ] API luôn kiểm tra permission phía server.

### Workflow

- [ ] Pallet mới bắt đầu tại `production`.
- [ ] Scan chuyển đúng `production → pendingWH`.
- [ ] Xác nhận scan chuyển đúng `pendingWH → processingWH`.
- [ ] Warehouse có thể trả `processingWH → production`.
- [ ] Production chuyển `processingWH → WHdone` khi tạo phiếu.
- [ ] Không có luồng `WHdone → production`.

### Traceability

- [ ] Các cột `*_at` và `*_by` được ghi đúng.
- [ ] `return_from_status` đúng nguồn trả về.
- [ ] Edit/delete bắt buộc có lý do.
- [ ] History lưu đúng snapshot trước và sau.
- [ ] `WHdone` bị khóa.

### Data integrity

- [ ] RPC khóa record trước aggregate.
- [ ] Không còn lỗi `FOR UPDATE is not allowed with aggregate functions`.
- [ ] Không update một phần khi danh sách có pallet sai trạng thái.
- [ ] Không tạo duplicate receipt ngoài ý muốn.
- [ ] PDF và reprint lấy đúng receipt.

---

## 13. Branch và release flow

```text
dev → demo → main
```

| Branch | Mục đích |
|---|---|
| `dev` | Phát triển và kiểm tra code mới |
| `demo` | Vercel Preview để review nghiệp vụ |
| `main` | Production |

Quy trình:

1. Thực hiện thay đổi trên `dev`.
2. Chạy migration Supabase cần thiết.
3. Kiểm tra nghiệp vụ local hoặc môi trường dev.
4. Merge `dev` vào `demo`.
5. Review workflow trên Vercel Preview.
6. Merge `demo` vào `main` sau khi đạt yêu cầu.

---

## 14. Khi code và README không khớp

Kiểm tra theo thứ tự:

```text
lib/types.ts
→ lib/routes.ts
→ lib/auth.ts
→ app/api/<module>/...
→ supabase/*.sql
→ app/<module>/page.tsx
```

Sau khi xác định logic thực tế, cập nhật README để tài liệu tiếp tục là nguồn tham chiếu chính của dự án.
