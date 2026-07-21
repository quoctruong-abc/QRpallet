# QRpallet

Hệ thống quản lý kế hoạch sản xuất, tem pallet QR và nhập kho nội bộ.

README này là tài liệu tham chiếu chính cho kiến trúc, nghiệp vụ, phân quyền, database và cách vận hành dự án. Khi thay đổi workflow, permission, RPC hoặc cấu trúc bảng, cần cập nhật README trong cùng đợt thay đổi.

---

## 1. Tổng quan

Luồng nghiệp vụ hiện tại:

```text
Planning Inject
→ Production tạo và in tem pallet
→ Warehouse scan QR
→ Warehouse xác nhận và tạo phiếu nhập kho
→ Pallet chuyển sang WHdone
→ Warehouse xem lịch sử, chi tiết và in lại phiếu
```

Phạm vi hiện tại kết thúc tại `WHdone`. Hệ thống chưa quản lý tồn kho thực tế, xuất kho hoặc điều chỉnh tồn sau nhập kho.

---

## 2. Công nghệ

- Next.js 16 App Router
- TypeScript
- Tailwind/CSS ứng dụng
- Supabase Auth
- Supabase PostgreSQL
- PostgreSQL RPC cho nghiệp vụ transaction
- `pdf-lib`, `fontkit`, `qrcode` cho PDF tem và phiếu nhập kho
- Deploy trên Vercel

Nguyên tắc:

- Client không cập nhật trực tiếp trạng thái pallet.
- API phải xác thực user và permission ở server.
- Nghiệp vụ nhiều bước thực hiện trong RPC và cùng transaction.
- Pallet chỉ có một version đang hoạt động với `effect_to is null`.
- Không sửa hoặc đảo trạng thái pallet sau khi đã `WHdone`.

---

## 3. Cài đặt và chạy local

### 3.1 Yêu cầu

- Node.js phù hợp với Next.js 16
- npm
- Supabase project

### 3.2 Biến môi trường

Tạo `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your_publishable_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

Không commit `.env.local` hoặc service-role key lên GitHub.

### 3.3 Chạy development

```bash
npm install
npm run dev
```

Mở:

```text
http://localhost:3000
```

### 3.4 Kiểm tra build

```bash
npm run build
npm start
```

---

## 4. Branch và deploy

Khuyến nghị:

- `main`: production
- `dev`: phát triển và kiểm thử
- `demo`: môi trường trình diễn nếu cần

Quy trình cơ bản:

```bash
git checkout dev
git pull origin dev
npm run build
git add .
git commit -m "mô tả thay đổi"
git push origin dev
```

Chỉ merge lên production sau khi build và kiểm thử nghiệp vụ thành công.

---

## 5. Role, position và permission

### 5.1 Role

| Role | Quy tắc |
|---|---|
| `superadmin` | Toàn quyền, bypass permission |
| `admin` | Permission được superadmin chọn trong `user_permissions` |
| `user` | Permission được admin hoặc superadmin cấp |

Admin không còn tự động nhận toàn bộ quyền theo position.

### 5.2 Position

| Position | Phạm vi quản lý |
|---|---|
| `planning` | Kế hoạch sản xuất |
| `production` | Tạo và quản lý pallet Production |
| `warehouse` | Scan, tạo và xem phiếu nhập kho |

Position vẫn được dùng để:

- giới hạn admin chỉ quản lý user cùng position;
- xác định page mapping;
- phân nhóm vận hành.

### 5.3 Permission hiện hành

| Permission | Chức năng |
|---|---|
| `planning.upload` | Upload và replace Planning Inject |
| `planning.change` | Thay đổi dữ liệu planning được phép |
| `pallet.create` | Tạo pallet, in tem, tìm kiếm, in lại và gộp pallet |
| `pallet.edit` | Sửa hoặc xóa pallet Production |
| `scan.standard` | Scan QR, hủy scan, xác nhận và tạo phiếu nhập kho |
| `receipt.view` | Truy cập module lịch sử phiếu, xem chi tiết và in lại |

Hai permission cũ không còn sử dụng:

```text
receipt.create
receipt.edit
```

### 5.4 Page mapping mặc định

| Position | Trang |
|---|---|
| Planning | `/planning-inject` |
| Production | `/pallet-label` |
| Warehouse | `/scan-qr`, `/warehouse-receipt` |

Superadmin có thể thay đổi mapping trên trang Admin.

---

## 6. Module 1 — Planning Inject

Route:

```text
/planning-inject
```

Bảng chính:

```text
planning_inject
```

Chức năng:

- Upload file Excel từ sheet dữ liệu quy định.
- Replace kế hoạch hiện tại.
- Hiển thị kế hoạch theo máy.
- Đổi máy khi có `planning.change`.
- Bỏ qua WO trống hoặc WO bằng `0` khi đưa sang module pallet.

Các trường chính:

```text
machine
itemcode
product_name
customer
wo
netweight
quanperh
quanperday
color
material
package
quanorder
```

API chính:

| API | Permission |
|---|---|
| `/api/planning-inject/import` | `planning.upload` |
| `/api/planning-inject/change-machine` | `planning.change` |

---

## 7. Module 2 — Xuất tem pallet

Route:

```text
/pallet-label
```

Bảng chính:

```text
pallet_data
item_pallet_config
```

### 7.1 Tạo pallet

Điều kiện:

- WO không trống.
- WO khác `0`.
- Quantity là số nguyên lớn hơn 0.
- User có `pallet.create`.

Pallet mới:

```text
status = production
effect_to = null
```

ID pallet:

```text
WO-001
WO-002
...
```

ID được sinh tại database và khóa transaction theo WO để tránh trùng số.

### 7.2 Working day

Mỗi pallet có:

```text
working_day date
```

Working day tính theo múi giờ:

```text
Asia/Ho_Chi_Minh
```

Ca làm việc:

```text
06:00 hôm nay → trước 06:00 hôm sau
```

Ví dụ:

- Tạo lúc `2026-07-21 05:59 +07` → `working_day = 2026-07-20`
- Tạo lúc `2026-07-21 06:00 +07` → `working_day = 2026-07-21`

Công thức:

```sql
(
  timezone('Asia/Ho_Chi_Minh', created_at)
  - interval '6 hours'
)::date
```

Khi sửa pallet và tạo version mới, `working_day` được giữ từ version gốc, không tính lại theo thời điểm sửa.

### 7.3 PDF tem pallet

- Khổ A4 theo template.
- QR chứa `pallet_id`.
- Font Roboto TTF để hỗ trợ tiếng Việt.
- Dùng `pdf-lib`, `fontkit` và `qrcode`.

### 7.4 Sửa pallet

Chỉ được sửa khi:

```text
status = production
effect_to is null
```

Bắt buộc nhập:

- quantity mới;
- lý do sửa.

Versioning:

1. Dòng hiện tại được đóng bằng `effect_to`.
2. Tạo dòng mới với cùng `pallet_id`.
3. `old_data_refer` trỏ về ID vật lý của dòng cũ.
4. Dòng mới có:

```text
has_been_edited = true
edit_count = edit_count cũ + 1
```

RPC:

```text
edit_pallet_quantity_tracked
```

### 7.5 Xóa pallet

Chỉ được xóa khi pallet còn active và `status = production`.

Xóa là versioned soft delete:

- đóng dòng active bằng `effect_to`;
- tạo dòng tombstone không active;
- `old_data_refer` trỏ về dòng bị xóa;
- bắt buộc nhập lý do.

RPC:

```text
delete_pallet_record_tracked
```

### 7.6 Gộp pallet

- Chỉ áp dụng cho pallet đang `production`.
- Có thể gộp theo WO và số lượng.
- Dấu vết pallet nguồn được lưu trong `note`.

---

## 8. Module 3 — Scan QR và tạo phiếu nhập kho

Route:

```text
/scan-qr
```

Permission:

```text
scan.standard
```

Workflow trạng thái:

```text
production
→ pendingWH
→ processingWH
→ WHdone
```

### 8.1 Scan pallet

Điều kiện:

```text
pallet tồn tại
effect_to is null
status = production
```

Kết quả:

```text
status = pendingWH
scanned_by = auth.uid()
scanned_at = now()
```

RPC:

```text
scan_pallet_to_pending
```

### 8.2 Hủy pallet vừa scan

Chỉ hủy khi:

```text
status = pendingWH
```

User thường chỉ hủy pallet do chính mình scan; superadmin/admin theo rule RPC có thể được phép tùy cấu hình hiện hành.

Kết quả:

```text
pendingWH → production
has_been_return = true
scanned_by = null
scanned_at = null
```

Chi tiết lần scan và lần hủy được ghi vào:

```text
pallet_change_history
```

Các trường lịch sử chính:

```text
pallet_data_id
pallet_id
change_type = scan_return
scanned_by
scanned_at
cancelled_by
cancelled_at
```

Không còn dùng các cột legacy:

```text
return_at
return_by
return_from
returned_at
returned_by
returned_from
```

RPC:

```text
cancel_pending_pallet
```

### 8.3 Xác nhận danh sách scan

Khi xác nhận:

```text
pendingWH → processingWH
```

Hệ thống khóa và kiểm tra toàn bộ pallet trước khi update.

### 8.4 Tạo phiếu nhập kho

Sau khi xác nhận danh sách, module Scan tạo phiếu nhập kho và chuyển pallet:

```text
processingWH → WHdone
```

Phiếu được ghi vào:

```text
wh_receipt
```

Pallet được liên kết qua:

```text
pallet_data.wh_receipt
```

Sau `WHdone`:

- không sửa pallet;
- không xóa pallet;
- không trả về Production;
- không hủy phiếu để đảo dữ liệu;
- chỉ xem và in lại.

---

## 9. Module 4 — Lịch sử phiếu nhập kho

Route:

```text
/warehouse-receipt
```

Permission:

```text
receipt.view
```

Position Warehouse được map vào module này. Admin Warehouse vẫn cần được superadmin cấp permission `receipt.view`.

Chức năng:

- Hiển thị phiếu 7 ngày gần nhất.
- Tìm theo ngày phiếu.
- In lại PDF.
- Xem chi tiết pallet của từng phiếu.

Chi tiết phiếu hiển thị:

```text
pallet_id
wo
itemcode
product_name
customer
quantity
```

API:

| API | Chức năng |
|---|---|
| `/api/warehouse-receipt/list` | Danh sách phiếu |
| `/api/warehouse-receipt/detail` | Danh sách pallet của phiếu |
| `/api/warehouse-receipt/reprint` | In lại PDF |

### 9.1 Receipt day

`wh_receipt.receipt_date` dùng cùng rule working day:

```text
06:00 hôm nay → trước 06:00 hôm sau
```

Ví dụ:

- Tạo phiếu lúc `05:30 ngày 21/07` → `receipt_date = 20/07`
- Tạo lúc `06:00 ngày 21/07` → `receipt_date = 21/07`

Số phiếu chạy theo `receipt_date`:

```text
WH-DDMMYY-001
WH-DDMMYY-002
```

Phiếu tạo trước 06:00 tiếp tục chuỗi số của working day hôm trước.

---

## 10. Trạng thái pallet

| Status | Ý nghĩa |
|---|---|
| `production` | Pallet thuộc Production |
| `pendingWH` | Đã scan, chưa xác nhận danh sách |
| `processingWH` | Đã xác nhận scan, đang tạo phiếu |
| `WHdone` | Đã hoàn tất nhập kho |

Luồng hợp lệ:

```text
production → pendingWH
pendingWH → production
pendingWH → processingWH
processingWH → WHdone
```

Không có luồng nghiệp vụ:

```text
WHdone → production
```

---

## 11. Các bảng database chính

### `profiles`

Thông tin tài khoản, role, position và trạng thái hoạt động.

### `permissions`

Danh mục permission hợp lệ.

### `user_permissions`

Permission được cấp cho admin và user.

### `position_page_access`

Mapping position với route.

### `planning_inject`

Kế hoạch sản xuất được import.

### `item_pallet_config`

Số lượng chuẩn trên mỗi pallet theo item.

### `pallet_data`

Dữ liệu pallet và version history.

Các field quan trọng:

```text
id
pallet_id
itemcode
product_name
customer
wo
quanorder
machine
quantity
status
effect_to
note
wh_receipt
created_by
created_at
updated_at
old_data_refer
has_been_edited
edit_count
has_been_return
scanned_by
scanned_at
working_day
```

### `pallet_change_history`

Hiện dùng cho sự kiện `scan_return`.

Lịch sử sửa/xóa pallet được theo dõi bằng version trong `pallet_data` và `old_data_refer`.

### `wh_receipt`

Thông tin phiếu nhập kho:

```text
receipt_id
receipt_date
total_pallet
total_quantity
uid_user
status
created_at
```

---

## 12. Supabase SQL

Thư mục:

```text
supabase/
```

Hiện tại database production vẫn sử dụng chuỗi migration lịch sử. Không chạy lại các migration đã áp dụng.

Các migration gần đây:

```text
008_pallet_data_versioning.sql
009_edit_flags_and_scan_return_history.sql
010_remove_legacy_return_triggers.sql
011_receipt_view_permission.sql
012_assign_admin_permissions.sql
013_pallet_working_day.sql
014_wh_receipt_working_day.sql
```

Lưu ý:

- Chỉ chạy file migration mới chưa áp dụng.
- Đọc nội dung file trước khi chạy.
- Không chạy `000_clean_install_full_schema.sql` trên production vì file này có thể drop và tạo lại bảng.
- Tạo backup trước các migration thay đổi cấu trúc lớn.
- Kế hoạch gom migration thành bộ consolidated đang tạm hoãn; database hiện tại giữ nguyên.

---

## 13. Navigation và đăng xuất

Header hiển thị icon theo permission:

| Module | Permission |
|---|---|
| Planning | `planning.upload` |
| Pallet | `pallet.create` |
| Scan QR | `scan.standard` |
| Phiếu nhập kho | `receipt.view` |

Đăng xuất:

1. POST `/auth/signout`.
2. Xóa session Supabase local.
3. Redirect về `/login`.
4. Response dùng `Cache-Control: no-store` để tránh quay lại trang đã đăng nhập từ cache.

---

## 14. Kiểm thử tối thiểu trước deploy

```bash
npm run build
```

Checklist:

1. Đăng nhập các role/position.
2. Superadmin cấp và thu hồi permission admin.
3. Navigation chỉ hiện module được cấp quyền.
4. Import planning.
5. Tạo pallet và PDF.
6. Kiểm tra `working_day` trước/sau 06:00.
7. Sửa pallet và kiểm tra version, `edit_count`.
8. Xóa pallet Production.
9. Scan QR và hủy scan.
10. Kiểm tra `pallet_change_history` khi hủy scan.
11. Xác nhận và tạo phiếu.
12. Kiểm tra `receipt_date` trước/sau 06:00.
13. Xem danh sách phiếu.
14. Xem chi tiết pallet của phiếu.
15. In lại PDF.
16. Đăng xuất và kiểm tra session đã xóa.

---

## 15. Các lỗi thường gặp

### Thiếu Supabase service-role key

```text
Missing Supabase admin environment variables
```

Kiểm tra:

```env
SUPABASE_SERVICE_ROLE_KEY
```

Sau khi sửa env cần restart server hoặc redeploy Vercel.

### PDF không tìm thấy font

```text
ENOENT ... Roboto-Regular.ttf
```

Kiểm tra file font trong:

```text
assets/fonts/
```

và đường dẫn dùng `process.cwd()`.

### Unknown font format

Đảm bảo dùng font TTF hợp lệ và đăng ký `fontkit` trước khi embed custom font.

### Trigger tham chiếu cột return cũ

```text
record "new" has no field "returned_at"
```

Chạy migration dọn legacy trigger:

```text
010_remove_legacy_return_triggers.sql
```

### Permission key không tồn tại

```text
violates foreign key constraint user_permissions_permission_key_fkey
```

Permission phải được tạo trong bảng `permissions` trước khi insert vào `user_permissions`.

---

## 16. Nguyên tắc phát triển tiếp theo

- Không chỉnh trực tiếp pallet `WHdone`.
- Không tái sử dụng permission cũ `receipt.create` hoặc `receipt.edit`.
- Admin permission phải lấy từ `user_permissions`.
- Mọi logic ngày vận hành dùng giờ Việt Nam và mốc 06:00.
- Khi thêm field versioned, phải bảo đảm RPC edit sao chép field đó sang version mới.
- Khi đổi RPC, giữ tên/signature nếu API hiện tại đang phụ thuộc, hoặc cập nhật API trong cùng commit.
- Luôn cập nhật README khi thay đổi nghiệp vụ hoặc database.
