# QRpallet — SVN Warehouse

Hệ thống quản lý kế hoạch sản xuất, tạo tem pallet QR, scan nhập kho và theo dõi lịch sử pallet nội bộ.

> **Baseline nghiệp vụ tạm chốt: 10/08/2026**  
> README này là tài liệu tham chiếu chính cho logic nghiệp vụ, trạng thái pallet, phân quyền, database, PWA và quy trình deploy. Khi thay đổi workflow, permission, RPC hoặc cấu trúc bảng, phải cập nhật README trong cùng đợt thay đổi.

---

## 1. Phạm vi hệ thống

Luồng nghiệp vụ hiện hành:

```text
Planning Inject
→ Production tạo và in tem pallet
→ Warehouse scan QR
→ Warehouse xác nhận danh sách scan
→ Hệ thống tạo phiếu nhập kho
→ Pallet chuyển sang WHdone
→ Xem lịch sử, chi tiết và in lại phiếu
```

Phạm vi hiện tại kết thúc tại `WHdone`.

Hệ thống **chưa quản lý**:

- tồn kho thực tế sau nhập kho;
- xuất kho;
- điều chỉnh tồn;
- hủy hoặc đảo phiếu đã hoàn tất;
- operation khi mất mạng.

---

## 2. Công nghệ

- Next.js 16 App Router
- TypeScript
- React
- CSS ứng dụng
- Supabase Auth
- Supabase PostgreSQL
- PostgreSQL RPC cho transaction nghiệp vụ
- `pdf-lib`, `@pdf-lib/fontkit`, `qrcode` cho PDF
- `read-excel-file` cho import planning
- Vercel để deploy frontend và backend
- PWA dạng cài lên màn hình chính, bắt buộc online

### Nguyên tắc kiến trúc

- Client không tự cập nhật trạng thái pallet trực tiếp.
- API phải xác thực user và permission ở server.
- Nghiệp vụ nhiều bước được xử lý bằng RPC/transaction trong database.
- Mỗi `pallet_id` chỉ có một version đang hoạt động với `effect_to is null`.
- Pallet đã `WHdone` không được sửa, xóa hoặc trả lại Production.
- `SUPABASE_SERVICE_ROLE_KEY` chỉ được sử dụng ở server.
- Không cache API hoặc dữ liệu operation.

---

## 3. Branch và quy tắc phát triển

| Branch | Mục đích |
|---|---|
| `main` | Production |
| `dev` | Phát triển và kiểm thử |

### Quy tắc bắt buộc

- Chỉ sửa code trên nhánh `dev`.
- Không commit trực tiếp vào `main`.
- Chỉ merge lên production sau khi build và kiểm thử nghiệp vụ thành công.

```bash
git checkout dev
git pull origin dev
npm run build
```

Sau khi kiểm thử:

```bash
git add .
git commit -m "mô tả thay đổi"
git push origin dev
```

---

## 4. Cài đặt và chạy local

### 4.1 Yêu cầu

- Node.js phù hợp với Next.js 16
- npm
- Supabase project đã chạy đủ migration

### 4.2 Biến môi trường

Tạo file `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your_publishable_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

Không commit `.env.local` hoặc service-role key lên GitHub.

### 4.3 Chạy development

```bash
npm install
npm run dev
```

Mở:

```text
http://localhost:3000
```

### 4.4 Chạy production local

```bash
npm run build
npm start
```

Khi truy cập bằng điện thoại trong cùng mạng nội bộ, dùng địa chỉ `Network` do Next.js hiển thị. Camera web cần HTTPS khi deploy chính thức.

---

## 5. Role, position và permission

### 5.1 Role

| Role | Quy tắc |
|---|---|
| `superadmin` | Toàn quyền, bypass permission; mặc định xem Dashboard và là role duy nhất được cấp/gỡ `dashboard.view` cho user |
| `admin` | Quản trị trong phạm vi được cấu hình; mặc định được xem Dashboard nhưng không được cấp/gỡ quyền Dashboard cho user |
| `user` | Chỉ sử dụng chức năng được cấp permission; muốn xem Dashboard phải được Super Admin cấp `dashboard.view` |

### 5.2 Position

| Position | Phạm vi |
|---|---|
| `planning` | Kế hoạch sản xuất |
| `production` | Tạo và quản lý pallet |
| `warehouse` | Scan và lịch sử nhập kho |

Position được dùng để:

- phân nhóm vận hành;
- giới hạn phạm vi quản lý user;
- xác định page mapping mặc định.

### 5.3 Permission hiện hành

| Permission | Chức năng |
|---|---|
| `planning.upload` | Upload và replace Planning Inject |
| `planning.change` | Thay đổi dữ liệu planning được phép |
| `pallet.create` | Tạo pallet, in tem, tìm kiếm, in lại và gộp pallet |
| `pallet.edit` | Sửa hoặc xóa pallet Production |
| `scan.standard` | Scan QR, hủy scan, xác nhận và tạo phiếu nhập kho |
| `receipt.view` | Xem lịch sử, chi tiết và in lại phiếu nhập kho |
| `dashboard.view` | Xem Dashboard sản xuất; chỉ Super Admin được cấp/gỡ permission này cho user |

Permission cũ không còn dùng:

```text
receipt.create
receipt.edit
```

### 5.4 Page mapping mặc định

| Position | Route |
|---|---|
| Planning | `/planning-inject` |
| Production | `/pallet-label` |
| Warehouse | `/scan-qr`, `/warehouse-receipt` |

Dashboard sản xuất là module permission riêng và **không phụ thuộc position mapping**:

```text
/production-dashboard
```

Rule cuối cùng:

- `superadmin`: mặc định được xem;
- `admin`: mặc định được xem;
- `user`: chỉ được xem khi Super Admin cấp `dashboard.view`;
- Admin bộ phận không được cấp hoặc gỡ `dashboard.view` của user.

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

### Chức năng

- Upload file Excel theo sheet dữ liệu quy định.
- Replace kế hoạch hiện tại.
- Hiển thị kế hoạch theo máy.
- Đổi máy khi user có `planning.change`.
- Bỏ qua WO trống hoặc WO bằng `0` khi đưa sang module pallet.

### Trường dữ liệu chính

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

### API chính

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
planning_inject
item_pallet_config
pallet_data
```

### 7.1 Danh sách kế hoạch

- Chỉ lấy dòng có máy, itemcode và WO hợp lệ.
- WO trống hoặc bằng `0` không được hiển thị để tạo pallet.
- Kế hoạch được nhóm theo máy.
- Giao diện hiển thị WO theo dạng ngắn gọn như `1WO`, `2WO`.
- Có tìm kiếm theo WO và itemcode.
- Hiển thị tiến độ đã tạo pallet và đã nhập kho.

### 7.2 Tạo pallet

Điều kiện:

- user có `pallet.create`;
- WO hợp lệ;
- quantity là số nguyên lớn hơn `0`.

Pallet mới:

```text
status = production
effect_to = null
```

ID pallet:

```text
WO-001
WO-002
WO-003
...
```

ID được sinh tại database trong transaction để tránh trùng số khi nhiều user tạo cùng lúc.

### 7.3 Cấu hình quantity mỗi pallet

Bảng:

```text
item_pallet_config
```

Trường chính:

```text
itemcode
quantity_per_pallet
```

### 7.4 PDF tem pallet

- Khổ A4 theo template.
- QR chứa `pallet_id`.
- Font Roboto TTF để hỗ trợ tiếng Việt.
- Dùng `pdf-lib`, `fontkit` và `qrcode`.

### 7.5 Sửa pallet

Chỉ sửa khi:

```text
status = production
effect_to is null
```

Bắt buộc nhập:

- quantity mới;
- lý do sửa.

Versioning:

1. Đóng dòng hiện tại bằng `effect_to`.
2. Tạo dòng mới với cùng `pallet_id`.
3. `old_data_refer` trỏ về dòng cũ.
4. Dòng mới giữ nguyên `working_day` của version gốc.
5. Cập nhật:

```text
has_been_edited = true
edit_count = edit_count cũ + 1
```

RPC hiện hành:

```text
edit_pallet_quantity_tracked
```

### 7.6 Xóa pallet

Chỉ xóa khi pallet còn active và `status = production`.

Xóa là versioned soft delete:

- đóng dòng active bằng `effect_to`;
- tạo dấu vết version;
- lưu `old_data_refer`;
- bắt buộc nhập lý do.

RPC hiện hành:

```text
delete_pallet_record_tracked
```

### 7.7 Gộp pallet

- Chỉ gộp pallet đang `production`.
- Gộp theo WO và quantity.
- Dấu vết pallet nguồn được lưu trong `note`.

---

## 8. Working day

Toàn bộ nghiệp vụ pallet dùng múi giờ:

```text
Asia/Ho_Chi_Minh
```

Ngày làm việc được xác định theo mốc `06:00`:

```text
06:00 hôm nay → trước 06:00 hôm sau
```

Ví dụ:

- Tạo lúc `05:59 ngày 21/07/2026` → `working_day = 20/07/2026`.
- Tạo lúc `06:00 ngày 21/07/2026` → `working_day = 21/07/2026`.

Công thức database:

```sql
(
  timezone('Asia/Ho_Chi_Minh', created_at)
  - interval '6 hours'
)::date
```

Khi sửa pallet, version mới giữ `working_day` của version trước; không tính lại theo thời điểm sửa.

---

## 9. Module 3 — Scan QR và tạo phiếu nhập kho

Route:

```text
/scan-qr
```

Permission:

```text
scan.standard
```

### 9.1 Quyền xem danh sách scan

- User thường chỉ thấy pallet do chính tài khoản đó scan.
- `admin` và `superadmin` thấy toàn bộ pallet đang `pendingWH`.
- Khi xác nhận, hệ thống tạo phiếu nhập kho trực tiếp trong module này.

### 9.2 Scan pallet

Điều kiện:

```text
pallet tồn tại
effect_to is null
status = production
```

Kết quả:

```text
production → pendingWH
scanned_by = auth.uid()
scanned_at = now()
```

RPC:

```text
scan_pallet_to_pending
```

### 9.3 Hủy pallet vừa scan

Chỉ hủy khi:

```text
status = pendingWH
```

Kết quả:

```text
pendingWH → production
has_been_return = true
scanned_by = null
scanned_at = null
```

Lịch sử được ghi vào:

```text
pallet_change_history
```

Các trường chính:

```text
pallet_data_id
pallet_id
change_type = scan_return
scanned_by
scanned_at
cancelled_by
cancelled_at
```

RPC:

```text
cancel_pending_pallet
```

### 9.4 Xác nhận và tạo phiếu

Khi user xác nhận danh sách:

```text
pendingWH → processingWH → WHdone
```

Hệ thống phải:

1. Khóa và kiểm tra toàn bộ pallet.
2. Đảm bảo pallet vẫn thuộc đúng user hoặc đúng phạm vi admin.
3. Tạo một phiếu nhập kho.
4. Gắn số phiếu vào từng pallet.
5. Chuyển pallet sang `WHdone` trong cùng nghiệp vụ transaction.

Sau khi thành công, module Scan xóa danh sách local và hiển thị số phiếu vừa tạo.

---

## 10. Module 4 — Lịch sử phiếu nhập kho

Route:

```text
/warehouse-receipt
```

Permission:

```text
receipt.view
```

Module này **chỉ dùng để xem lịch sử và in lại**, không tạo phiếu mới.

### Chức năng

- Hiển thị phiếu 7 ngày gần nhất.
- Tìm theo ngày phiếu.
- Xem chi tiết pallet của từng phiếu.
- In lại PDF.

Chi tiết phiếu hiển thị:

```text
pallet_id
wo
itemcode
product_name
customer
quantity
```

Số phiếu:

```text
WH-DDMMYY-001
WH-DDMMYY-002
...
```

`receipt_date` dùng cùng rule working day, mốc `06:00`.

Sau `WHdone`:

- không sửa pallet;
- không xóa pallet;
- không return về Production;
- không hủy phiếu để đảo trạng thái;
- chỉ xem và in lại.

---

## 11. Dashboard sản xuất

Route:

```text
/production-dashboard
```

Permission:

```text
dashboard.view
```

Quyền truy cập:

- `superadmin`: mặc định được xem;
- `admin`: mặc định được xem;
- `user`: chỉ được xem khi Super Admin cấp `dashboard.view`;
- chỉ Super Admin được cấp/gỡ `dashboard.view` cho user;
- Dashboard không phụ thuộc `position_page_access`.

Cả page `/production-dashboard`, tab Check FIFO và các API Dashboard đều kiểm tra cùng permission `dashboard.view`, tránh bypass bằng cách gọi route/API trực tiếp.

### 11.1 Dashboard tổng hợp

- Tìm theo một ngày hoặc khoảng ngày làm việc.
- Tổng hợp theo WO hoặc itemcode.
- Hiển thị:
  - Quan order;
  - số pallet đã tạo;
  - quantity đã sản xuất;
  - quantity đã scan;
  - quantity đã nhập kho;
  - progress theo order.
- Mở chi tiết từng pallet bằng icon.
- Mọi pallet đều có nút `Xem` để mở popup lịch sử, kể cả pallet chưa từng edit hoặc return.
- Pallet đã từng sửa hoặc return vẫn hiển thị dấu `!` để cảnh báo nhanh.

### 11.2 Check FIFO

Route:

```text
/production-dashboard/check-fifo
```

Check FIFO dùng cùng permission `dashboard.view` và dùng để tìm pallet đã tồn lâu nhưng chưa đi tới process tiếp theo.

Bộ lọc thời gian:

```text
Theo ngày
Khoảng ngày
Tất cả
```

Bộ lọc process:

- `Sản xuất`: lấy pallet active có `status = production`, tức đã tạo nhưng chưa scan.
- `Scan`: lấy pallet active có `status = pendingWH` hoặc `processingWH`, tức đã scan nhưng chưa hoàn tất nhập kho.
- `WHdone` không thuộc danh sách FIFO vì đã hoàn tất process.
- Frontend bắt buộc phải có ít nhất một process được chọn. Khi cả `Sản xuất` và `Scan` đều bỏ chọn, nút `Kiểm tra FIFO` bị disable và submit bị chặn ngay tại browser.
- Server vẫn giữ lớp chặn dự phòng: nếu URL bị sửa thủ công và không có process thì không chạy query `pallet_data`.

Bảng FIFO hiển thị:

```text
pallet_id
working_day
số ngày delay
scanned_at
itemcode
customer
product_name
Xem tiến độ
```

`Số ngày delay` được tính theo ngày Việt Nam:

```text
ngày hiện tại - working_day
```

Ví dụ `working_day = 08/08/2026`, ngày hiện tại `10/08/2026` thì delay là `2 ngày`.

Danh sách sắp xếp `working_day` tăng dần để pallet cũ nhất nằm trên cùng. `working_day` được dùng thay vì `created_at` vì pallet sau khi edit vẫn phải giữ ngày sản xuất gốc.

#### An toàn query Tất cả

Không được loop tải toàn bộ dữ liệu khi chọn `Tất cả`.

Rule hiện hành:

- mỗi request chỉ tải tối đa `200` pallet để render;
- query lấy thêm đúng `1` dòng để xác định còn trang sau;
- dùng phân trang `Trang trước / Trang sau`;
- bộ lọc vẫn chạy trực tiếp tại database theo `effect_to`, `status` và `working_day`;
- không thực hiện `count(*)` toàn bộ backlog chỉ để render trang FIFO.

Mục tiêu của giới hạn này là tránh tăng đột biến số request Supabase, RAM/CPU server render, kích thước HTML và nguy cơ timeout khi dữ liệu production lớn.

#### Xem tiến độ từ FIFO

Mỗi pallet có button `Xem tiến độ`. Button chỉ mở popup tại client, chưa query database ngay.

Trong popup user chọn một trong hai chế độ:

```text
Theo WO
Theo Item
```

Sau khi chọn, frontend mới gọi:

```text
GET /api/production-dashboard/progress
```

API kiểm tra `dashboard.view` và gọi RPC:

```text
dashboard_progress
```

Kết quả dùng cùng logic tổng hợp với Dashboard:

```text
Quan order
Số pallet
Đã sản xuất
Đã scan
Đã nhập kho
```

- Theo WO: `Quan order` lấy max `quanorder` của WO.
- Theo Item: `Quan order` cộng max `quanorder` theo từng WO của item.
- `Đã sản xuất`: tổng quantity pallet active trong phạm vi.
- `Đã scan`: tổng quantity có status khác `production`.
- `Đã nhập kho`: tổng quantity có status `WHdone`.
- Tiến độ popup dùng cùng phạm vi thời gian đang chọn ở Check FIFO; nếu FIFO chọn `Tất cả` thì progress không giới hạn ngày.

RPC aggregate trực tiếp tại PostgreSQL và chỉ trả các số tổng hợp. Không tải toàn bộ pallet của WO/Item qua API rồi mới cộng ở Vercel, nhằm giảm network, memory và rủi ro query lớn.

### 11.3 Lịch sử pallet

Popup lịch sử được chia thành hai phần:

1. **Flow chính** theo thứ tự workflow:
   - Tạo pallet: người tạo và giờ tạo, lấy từ version đầu tiên của pallet;
   - Scan pallet: người scan và giờ scan của trạng thái hiện tại;
   - Nhập kho: người nhập kho, giờ nhập kho và số phiếu nhập kho; người/giờ nhập kho lấy từ bản ghi `wh_receipt` tương ứng.
2. **Lịch sử chỉnh sửa / return** giữ layout cũ:
   - lịch sử edit dựng từ version chain trong `pallet_data` và `old_data_refer`;
   - lịch sử return lấy từ `pallet_change_history`;
   - pallet chưa từng chỉnh sửa hoặc return vẫn mở được popup và phần này hiển thị trạng thái không có thay đổi.

Flow chính được hiển thị dạng timeline theo thứ tự `Tạo pallet → Scan pallet → Nhập kho`; bước chưa thực hiện được hiển thị là chưa hoàn tất để user dễ nhận biết pallet đang ở đâu trong workflow.

Người thao tác được đổi từ user ID sang `full_name`, `username` hoặc `employee_code` trong bảng `profiles`. Việc đọc profile và thông tin phiếu cho Dashboard dùng service-role ở server sau khi đã xác thực `dashboard.view`.

---

## 12. Trạng thái pallet

| Status | Ý nghĩa |
|---|---|
| `production` | Pallet thuộc Production |
| `pendingWH` | Đã scan, chờ xác nhận |
| `processingWH` | Đang tạo phiếu nhập kho |
| `WHdone` | Đã hoàn tất nhập kho |

Luồng hợp lệ:

```text
production → pendingWH
pendingWH → production
pendingWH → processingWH
processingWH → WHdone
```

Luồng không được phép:

```text
WHdone → production
```

---

## 13. Database chính

### `profiles`

Thông tin tài khoản:

```text
id
username
email
full_name
employee_code
role
position
is_active
```

### `permissions`

Danh mục permission hợp lệ, bao gồm `dashboard.view`.

### `user_permissions`

Permission được cấp riêng cho tài khoản. Với `dashboard.view`, chỉ Super Admin được phép thêm hoặc gỡ bản ghi cho user; Admin bộ phận không được thay đổi quyền này.

### `position_page_access`

Mapping position với route. Dashboard không dùng mapping này để quyết định quyền truy cập.

### `planning_inject`

Kế hoạch sản xuất được import.

### `item_pallet_config`

Cấu hình quantity chuẩn trên mỗi pallet theo item.

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

Check FIFO chỉ đọc các field cần thiết và lọc trực tiếp trên `effect_to`, `status`, `working_day`. Schema hiện tại đã có index riêng cho `working_day` và `status`; phân trang giới hạn lượng dữ liệu trả về trên mỗi request.

### `pallet_change_history`

Hiện dùng để lưu sự kiện `scan_return`.

Lịch sử sửa/xóa pallet được theo dõi bằng version trong `pallet_data`.

### `wh_receipt`

Thông tin phiếu nhập kho:

```text
receipt_id
receipt_date
total_pallet
total_quantity
uid_user
user_id
status
created_at
```

`user_id`/`uid_user` và `created_at` được Dashboard dùng để hiển thị người nhập kho và giờ nhập kho trong flow pallet.

---

## 14. Supabase migration

Thư mục:

```text
supabase/
```

Quy tắc:

- Chỉ chạy migration mới chưa áp dụng.
- Chạy theo thứ tự số file.
- Đọc nội dung file trước khi chạy.
- Không chạy lại migration đã áp dụng trên production.
- Không chạy file clean-install hoặc file có lệnh drop trên production.
- Backup trước migration thay đổi cấu trúc lớn.
- Khi thay đổi RPC đang được API sử dụng, phải giữ đúng tên và signature hoặc cập nhật API trong cùng commit.

Các nhóm migration quan trọng hiện tại:

- phân quyền và page access;
- `dashboard.view` và RLS chỉ cho Super Admin cấp/gỡ quyền Dashboard của user;
- scan owner và tạo phiếu trực tiếp;
- pallet versioning;
- edit/return flags;
- scan return history;
- loại bỏ legacy return trigger;
- working day pallet;
- working day phiếu nhập kho;
- `dashboard_progress` để aggregate tiến độ WO/Item trực tiếp tại PostgreSQL cho Check FIFO.

---

## 15. PWA — cài lên màn hình chính

Ứng dụng hỗ trợ cài lên Android, iPhone/iPad và desktop dưới dạng standalone.

### Thành phần

```text
app/manifest.ts
app/pwa/icon/[size]/route.tsx
app/layout.tsx
```

Manifest:

```text
name = SVN Warehouse
start_url = /dashboard
display = standalone
scope = /
```

Icon được sinh động dưới dạng PNG:

```text
/pwa/icon/180
/pwa/icon/192
/pwa/icon/512
```

### Nguyên tắc bắt buộc online

Dự án **không có service worker** và **không có offline cache**.

Không triển khai:

- cache trang operation;
- cache API;
- scan offline;
- background sync;
- hàng đợi thao tác khi mất mạng.

Khi mất mạng, operation phải thất bại rõ ràng và không được tự lưu để gửi lại sau.

### Cài ứng dụng

Android Chrome:

```text
Menu → Cài đặt ứng dụng / Thêm vào màn hình chính
```

iPhone Safari:

```text
Chia sẻ → Thêm vào Màn hình chính
```

PWA cần deploy qua HTTPS để hoạt động đúng trên thiết bị thật.

---

## 16. Camera QR

Trang scan dùng camera sau với `facingMode: environment`.

Yêu cầu:

- HTTPS trên production;
- user cấp quyền camera;
- trình duyệt hỗ trợ `getUserMedia`;
- có kết nối internet.

Thư viện scan hiện được tải từ CDN `unpkg`. Nếu mạng nội bộ chặn CDN, camera có thể không khởi tạo dù ứng dụng vẫn mở được.

---

## 17. Deploy Vercel

### Biến môi trường cần cấu hình

```env
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY
```

Sau khi thay đổi env, phải redeploy hoặc restart môi trường.

### Checklist deploy

1. Đang ở nhánh `dev`.
2. `git pull origin dev`.
3. `npm install` nếu dependency thay đổi.
4. `npm run build` thành công.
5. Kiểm thử local hoặc Preview Deployment.
6. Kiểm tra Supabase migration đã áp dụng.
7. Kiểm tra manifest và icon PWA.
8. Kiểm thử nghiệp vụ chính.
9. Chỉ sau đó mới merge/deploy production.

---

## 18. Kiểm thử nghiệp vụ tối thiểu

### Tài khoản và permission

1. Đăng nhập `superadmin`, `admin`, `user`.
2. Kiểm tra tài khoản inactive.
3. Cấp và thu hồi permission.
4. Navigation chỉ hiện module được phép.
5. Dashboard: `superadmin` và `admin` nhìn thấy mặc định; `user` không thấy khi chưa có `dashboard.view`, thấy và truy cập được sau khi Super Admin cấp; Admin bộ phận không thể cấp/gỡ quyền này và thao tác lưu các quyền khác không được làm mất `dashboard.view` đã cấp.

### Planning

6. Import planning.
7. Replace dữ liệu cũ.
8. Đổi máy.
9. Kiểm tra WO trống hoặc `0` không vào module pallet.

### Production

10. Tạo pallet và kiểm tra ID không trùng.
11. In PDF tem.
12. Kiểm tra quantity mặc định theo item.
13. Sửa pallet và kiểm tra version, lý do, `edit_count`.
14. Xóa pallet Production.
15. Gộp pallet.
16. Kiểm tra không sửa/xóa được pallet ngoài `production`.

### Working day

17. Tạo pallet trước `06:00`.
18. Tạo pallet từ `06:00` trở đi.
19. Sửa pallet và xác nhận `working_day` không đổi.

### Warehouse

20. User A scan và chỉ thấy danh sách của User A.
21. User B không thấy danh sách của User A.
22. Admin thấy toàn bộ danh sách scan.
23. Hủy scan và kiểm tra pallet về `production`.
24. Kiểm tra `has_been_return` và `pallet_change_history`.
25. Xác nhận danh sách và tạo phiếu.
26. Kiểm tra pallet chuyển `WHdone`.
27. Kiểm tra không thể return hoặc sửa pallet `WHdone`.

### Phiếu nhập kho

28. Xem danh sách 7 ngày.
29. Tìm theo ngày.
30. Xem chi tiết pallet.
31. In lại PDF.
32. Kiểm tra `receipt_date` trước/sau `06:00`.

### Dashboard

33. Tìm theo ngày và khoảng ngày.
34. Đổi giữa tổng hợp WO và item.
35. Kiểm tra số pallet và progress.
36. Mở chi tiết pallet.
37. Mở lịch sử của pallet chưa edit/return và xác nhận popup vẫn hiển thị flow chính.
38. Kiểm tra flow `Tạo pallet → Scan pallet → Nhập kho` hiển thị đúng người và thời gian; bước chưa thực hiện phải thể hiện trạng thái chưa hoàn tất.
39. Với pallet `WHdone`, kiểm tra người nhập kho, giờ nhập kho và số phiếu nhập kho.
40. Kiểm tra dấu `!` cho pallet edit/return và phần lịch sử chỉnh sửa/return giữ đúng dấu vết cũ.
41. Kiểm tra tên người thao tác, không hiển thị raw user ID khi profile hợp lệ.
42. Với user chưa có `dashboard.view`, gọi trực tiếp API Dashboard phải trả `403`.
43. Mở tab `Check FIFO` và kiểm tra `Sản xuất` chỉ hiện `production`; `Scan` chỉ hiện `pendingWH/processingWH`.
44. Bỏ chọn cả `Sản xuất` và `Scan`: frontend phải disable submit/chặn điều hướng; server cũng không query nếu URL bị sửa thủ công.
45. Kiểm tra `Tất cả` không tải toàn bộ backlog mà phân trang tối đa 200 pallet mỗi request.
46. Kiểm tra FIFO sắp pallet cũ nhất trước và `Số ngày delay = ngày hiện tại Việt Nam - working_day`.
47. Chuyển `Trang sau / Trang trước` và xác nhận giữ nguyên bộ lọc ngày/process.
48. Bấm `Xem tiến độ`, chọn `Theo WO`, kiểm tra Quan order / sản xuất / scan / nhập kho khớp Dashboard trong cùng phạm vi ngày.
49. Bấm `Xem tiến độ`, chọn `Theo Item`, kiểm tra Quan order cộng theo từng WO và các quantity khớp Dashboard.
50. Với user không có `dashboard.view`, gọi trực tiếp `/api/production-dashboard/progress` phải trả `403`.

### PWA

51. Mở `/manifest.webmanifest`.
52. Mở `/pwa/icon/192` và `/pwa/icon/512`.
53. Cài app lên màn hình chính.
54. Mở app dạng standalone.
55. Tắt mạng và xác nhận operation không thể tiếp tục.

### Session

56. Đăng xuất.
57. Kiểm tra không quay lại trang bảo vệ bằng browser cache.

---

## 19. Lỗi thường gặp

### Thiếu service-role key

```text
Missing Supabase admin environment variables
```

Kiểm tra:

```env
SUPABASE_SERVICE_ROLE_KEY
```

### PDF không tìm thấy font

```text
ENOENT ... Roboto-Regular.ttf
```

Kiểm tra file font trong:

```text
assets/fonts/
```

Đường dẫn phải dùng `process.cwd()`.

### Unknown font format

Đảm bảo file là TTF hợp lệ và đã đăng ký `fontkit` trước khi embed.

### Trigger tham chiếu cột return cũ

```text
record "new" has no field "returned_at"
```

Kiểm tra migration loại bỏ legacy return trigger.

### Permission key không tồn tại

```text
violates foreign key constraint user_permissions_permission_key_fkey
```

Permission phải tồn tại trong bảng `permissions` trước khi insert vào `user_permissions`.

### PWA icon trả lỗi 500

```text
Expected <div> to have explicit display
```

Mọi `<div>` có nhiều node con trong `ImageResponse` phải có một trong các giá trị:

```text
display: flex
display: contents
display: none
```

---

## 20. Nguyên tắc cho thay đổi sau baseline

- Không chỉnh trực tiếp pallet `WHdone`.
- Không thêm đường chuyển trạng thái ngoài workflow đã chốt nếu chưa review nghiệp vụ.
- Không tái sử dụng `receipt.create` hoặc `receipt.edit`.
- Mọi logic ngày vận hành dùng giờ Việt Nam và mốc `06:00`.
- Khi thêm field versioned, RPC edit phải sao chép field đó sang version mới.
- Khi đổi RPC, phải cập nhật API và tài liệu trong cùng commit.
- Không thêm offline cache cho operation nếu chưa có thiết kế chống trùng và đồng bộ transaction.
- Không sử dụng service-role key ở client.
- `dashboard.view` của user chỉ do Super Admin cấp/gỡ; Admin không được thay đổi quyền này.
- Check FIFO không được dùng query không giới hạn để tải toàn bộ backlog trong một request.
- Progress FIFO phải aggregate tại database; không tải hàng loạt pallet về API chỉ để tính tổng.
- Luôn sửa trên `dev` và kiểm thử trước khi merge production.
- Luôn cập nhật README khi thay đổi nghiệp vụ hoặc database.
