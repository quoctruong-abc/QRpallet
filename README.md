# QRpallet — SVN Warehouse

Hệ thống nội bộ quản lý kế hoạch sản xuất, tạo tem pallet QR, scan nhập kho, phiếu nhập kho và Dashboard theo dõi tiến độ/lịch sử pallet.

> **Baseline hiện hành: 10/08/2026**  
> README này là tài liệu tham chiếu chính để scan nhanh trạng thái dự án. Khi thay đổi workflow, permission, RPC, database, security hoặc quy trình deploy/go-live thì cập nhật README trong cùng đợt thay đổi.

---

## 1. Phạm vi hệ thống

Luồng nghiệp vụ hiện hành:

```text
Planning Inject
→ Production tạo + in tem pallet
→ Warehouse scan QR
→ Warehouse xác nhận batch scan
→ Hệ thống tạo phiếu nhập kho
→ Pallet chuyển WHdone
→ Xem lịch sử / Dashboard / in lại phiếu
```

Phạm vi hiện tại kết thúc tại `WHdone`.

Hệ thống **chưa quản lý**:

- tồn kho thực tế sau nhập kho;
- xuất kho;
- điều chỉnh tồn;
- hủy/đảo phiếu đã hoàn tất;
- operation offline.

---

## 2. Công nghệ và kiến trúc

- Next.js 16 App Router
- TypeScript + React
- Supabase Auth
- Supabase PostgreSQL + RLS
- PostgreSQL RPC/transaction cho nghiệp vụ quan trọng
- Vercel frontend/backend
- `pdf-lib`, `@pdf-lib/fontkit`, `qrcode` cho PDF
- `read-excel-file` cho Planning Inject
- PWA dạng standalone, bắt buộc online

### Nguyên tắc kiến trúc

- Client không tự cập nhật trạng thái pallet quan trọng bằng direct table DML.
- API/Server Action phải xác thực user và permission ở server.
- Nghiệp vụ nhiều bước dùng RPC/transaction trong database.
- Mỗi `pallet_id` chỉ có một version active với `effect_to is null`.
- Pallet `WHdone` không sửa/xóa/return.
- `SUPABASE_SERVICE_ROLE_KEY` chỉ được dùng server-side.
- Không cache API operation và không có offline queue.
- Các aggregate lớn phải thực hiện ở PostgreSQL; không tải toàn bộ lịch sử về Vercel chỉ để cộng số.

Kiến trúc security mục tiêu:

```text
Internet
→ Vercel / Next.js
→ Auth + Permission + Input Guard
→ Supabase Data API least privilege
→ GRANT whitelist + RLS
→ SECURITY DEFINER RPC permission/ownership guard
→ PostgreSQL transaction
```

> Vercel WAF/Bot Protection/rate limit chưa phải baseline đã cấu hình; xử lý ở bước security/deploy riêng sau.

---

## 3. Branch và quy tắc phát triển

| Branch | Mục đích |
|---|---|
| `main` | Production |
| `dev` | Phát triển và kiểm thử |

### Quy tắc bắt buộc

- Chỉ sửa code trên `dev`.
- Không commit trực tiếp vào `main`.
- Chỉ merge production sau khi build + smoke test thành công.

Lệnh thường dùng:

```bash
git switch dev
git pull origin dev
npm install
npm run build
```

Chạy development:

```bash
npm run dev
```

Chạy production local:

```bash
npm run build
npm start
```

---

## 4. Biến môi trường

`.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your_publishable_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

Không commit `.env.local`, JWT signing key hoặc service-role key lên GitHub.

---

## 5. Auth, JWT và security rule

### 5.1 Login/session

Login dùng Supabase email/password thông qua username nội bộ được map sang email nội bộ.

Server/proxy kiểm tra JWT bằng:

```text
supabase.auth.getClaims()
```

Không dựa vào decode JWT local để quyết định user.

Rule hiện hành trong `supabase/config.toml`:

```text
JWT expiry                  = 3600 giây (1 giờ)
Refresh token rotation      = ON
Refresh reuse interval      = 10 giây
Anonymous sign-in           = OFF
Public signup               = OFF
Email signup                = OFF
Minimum password length     = 8
```

Business role/permission **không đóng băng trong JWT**. Sau khi xác thực `claims.sub`, hệ thống vẫn đọc trạng thái/permission hiện hành từ database.

Luồng authorization:

```text
JWT hợp lệ
→ claims.sub
→ profiles
→ is_active / role / position
→ user_permissions + mapping
→ RLS / RPC permission check
```

Nếu user bị khóa `profiles.is_active = false`, business permission bị từ chối dù access JWT cũ chưa hết hạn.

### 5.2 Hosted Supabase Auth settings

Repo đã cấu hình local:

```toml
[auth]
enable_signup = false
minimum_password_length = 8

[auth.email]
enable_signup = false
```

Với project Supabase hiện tại, `npx supabase config push` yêu cầu paid tier. Vì vậy khi chạy hosted project phải kiểm tra/chỉnh thủ công trong Supabase Dashboard:

```text
Authentication
→ Settings / General Configuration
→ Allow new users to sign up = OFF
→ Minimum password length = 8
```

Admin vẫn tạo user bằng server-side `auth.admin.createUser()`; việc tắt public signup không chặn luồng Admin tạo tài khoản.

### 5.3 Data API hardening

Baseline sau migration `20260810163500_harden_data_api_surface.sql`:

- `anon` không có quyền business trên schema `public`;
- authenticated không có direct `INSERT/UPDATE/DELETE` trên public tables;
- future public table/function/sequence mặc định fail-closed, phải `GRANT` rõ ràng;
- `wh_receipt` không cho authenticated direct SELECT;
- `pallet_change_history` chỉ đọc khi RLS xác nhận `dashboard.view`;
- `pallet_data` direct SELECT bị giới hạn theo permission/RLS;
- authenticated chỉ EXECUTE các RPC/helper đã whitelist;
- service-role chỉ dùng server-side.

Tài liệu audit chi tiết:

```text
docs/supabase-data-api-security.md
```

### 5.4 Business RPC whitelist hiện hành

RLS/auth helpers:

```text
current_profile_position()
current_profile_role()
has_permission(text)
```

Business RPC:

```text
replace_planning_inject(jsonb,text)
create_pallet_record(text,text,text,text,numeric,text,integer,text)
edit_pallet_quantity_tracked(text,integer,text)
delete_pallet_record_tracked(text,text)
scan_pallet_to_pending(text)
cancel_pending_pallet(text)
create_warehouse_receipt_from_scan(text[])
dashboard_progress(text,text,date,date)
dashboard_summary(date,date)
dashboard_check_item(text)
```

Trigger/helper nội bộ không được authenticated gọi trực tiếp.

### 5.5 Error handling

Các route Scan và Dashboard đã harden lỗi database kỹ thuật thành message chung:

```text
Không thể tải dữ liệu. Vui lòng thử lại.
```

Raw PostgreSQL/Supabase error chỉ log server-side. Business error có chủ đích như pallet không tồn tại, sai status, sai owner, batch quá 200 vẫn được map thành message phù hợp.

> Chưa sweep generic DB error cho toàn repo; Planning/Pallet/Receipt/Admin cần audit riêng nếu muốn hoàn tất P1 toàn hệ thống.

---

## 6. Role, position và permission

### Role

| Role | Quy tắc |
|---|---|
| `superadmin` | Toàn quyền; mặc định xem Dashboard; role duy nhất được cấp/gỡ `dashboard.view` cho user |
| `admin` | Quản trị trong phạm vi được cấu hình; mặc định xem Dashboard |
| `user` | Chỉ dùng permission được cấp |

### Position

| Position | Phạm vi |
|---|---|
| `planning` | Kế hoạch sản xuất |
| `production` | Tạo/quản lý pallet |
| `warehouse` | Scan và lịch sử nhập kho |

### Permission

| Permission | Chức năng |
|---|---|
| `planning.upload` | Upload/replace Planning Inject |
| `planning.change` | Thay đổi planning được phép |
| `pallet.create` | Tạo pallet, in tem, tìm kiếm, in lại, gộp |
| `pallet.edit` | Sửa/xóa pallet Production |
| `scan.standard` | Scan, cancel scan, confirm batch + tạo phiếu |
| `receipt.view` | Xem lịch sử/chi tiết/in lại phiếu |
| `dashboard.view` | Dashboard + Check FIFO + Check item |

Permission cũ không còn dùng:

```text
receipt.create
receipt.edit
```

Page mapping mặc định:

| Position | Route |
|---|---|
| Planning | `/planning-inject` |
| Production | `/pallet-label` |
| Warehouse | `/scan-qr`, `/warehouse-receipt` |

Dashboard là module permission riêng:

```text
/production-dashboard
/production-dashboard/check-fifo
/production-dashboard/check-item
```

---

## 7. Module 1 — Planning Inject

Route:

```text
/planning-inject
```

Bảng:

```text
planning_inject
```

Chức năng:

- import Excel theo sheet quy định;
- replace planning hiện tại;
- hiển thị theo máy;
- đổi máy khi có `planning.change`;
- WO trống hoặc bằng `0` không được đưa sang module pallet.

Trường chính:

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

API:

| API | Permission |
|---|---|
| `/api/planning-inject/import` | `planning.upload` |
| `/api/planning-inject/change-machine` | `planning.change` |

---

## 8. Module 2 — Xuất tem pallet

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

### 8.1 Danh sách WO

- chỉ lấy WO khác `0` và không trống;
- nhóm theo máy;
- hiển thị dạng `1WO`, `2WO`;
- tìm theo WO/itemcode;
- list pallet gần nhất phục vụ thao tác nhanh;
- chức năng sửa/xóa chỉ cho pallet active `production`.

### 8.2 Tạo pallet

Pallet mới:

```text
status = production
effect_to = null
```

Pallet ID:

```text
WO-001
WO-002
WO-003
...
```

ID được sinh trong database transaction để tránh collision khi nhiều user thao tác.

### 8.3 Quantity chuẩn mỗi pallet

Bảng:

```text
item_pallet_config
```

Field:

```text
itemcode
quantity_per_pallet
```

### 8.4 Edit pallet

Chỉ khi:

```text
status = production
effect_to is null
```

Bắt buộc reason.

Versioning:

1. đóng version cũ bằng `effect_to`;
2. tạo version mới cùng `pallet_id`;
3. `old_data_refer` trỏ version trước;
4. giữ nguyên `working_day` gốc;
5. cập nhật edit tracking.

RPC:

```text
edit_pallet_quantity_tracked
```

### 8.5 Delete pallet

Delete là terminal soft-delete/versioned event:

- chỉ active `production`;
- reason bắt buộc;
- đóng active row;
- tạo terminal delete version với `note = delete: ...`;
- không còn active version của pallet.

RPC:

```text
delete_pallet_record_tracked
```

Dashboard vẫn nhận biết pallet đã delete để giữ context WO/order và cảnh báo history, nhưng pallet delete không được cộng vào KPI active.

### 8.6 PDF tem

- QR chứa `pallet_id`;
- template PDF trong project;
- Roboto TTF hỗ trợ tiếng Việt;
- `pdf-lib` + `fontkit` + `qrcode`.

---

## 9. Working day

Timezone:

```text
Asia/Ho_Chi_Minh
```

Cutoff:

```text
06:00 hôm nay → trước 06:00 hôm sau
```

Ví dụ:

```text
05:59 21/07/2026 → working_day = 20/07/2026
06:00 21/07/2026 → working_day = 21/07/2026
```

Database logic:

```sql
(
  timezone('Asia/Ho_Chi_Minh', created_at)
  - interval '6 hours'
)::date
```

Version edit/delete phải giữ `working_day` của pallet gốc.

---

## 10. Module 3 — Scan QR + tạo phiếu

Route:

```text
/scan-qr
```

Permission:

```text
scan.standard
```

### 10.1 Scan

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

### 10.2 Giới hạn batch 200 pallet

Scan batch tối đa:

```text
200 pallet
```

Guard có cả frontend và database:

- từ `150` pallet frontend hiển thị indicator/cảnh báo `x/200`;
- `200` pallet: chặn mở camera/scan thêm;
- DB dùng advisory lock + count `pendingWH` theo scanner để chặn request thứ 201;
- confirm API/RPC cũng chỉ nhận tối đa 200 pallet;
- duplicate pallet ID trong confirm bị reject.

User thường chỉ thấy pending pallet của chính mình. Admin/superadmin có thể thấy toàn bộ pending list, nhưng UI vẫn giới hạn batch hiển thị/thao tác tối đa 200.

### 10.3 Cancel scan

```text
pendingWH → production
scanned_by = null
scanned_at = null
has_been_return = true
```

Ghi history vào:

```text
pallet_change_history
```

RPC:

```text
cancel_pending_pallet
```

Normal user chỉ cancel pallet do mình scan; admin/superadmin được xử lý theo quyền admin.

### 10.4 Confirm batch + tạo phiếu

Workflow:

```text
pendingWH → processingWH → WHdone
```

Trong cùng transaction:

1. validate batch/owner/status;
2. khóa các pallet;
3. tạo receipt;
4. gắn receipt cho pallet;
5. chuyển `WHdone`.

RPC:

```text
create_warehouse_receipt_from_scan
```

---

## 11. Module 4 — Lịch sử phiếu nhập kho

Route:

```text
/warehouse-receipt
```

Permission:

```text
receipt.view
```

Module này chỉ:

- xem lịch sử;
- tìm theo ngày;
- xem chi tiết;
- in lại PDF.

Không reverse sau `WHdone`.

Receipt ID:

```text
WH-DDMMYY-001
WH-DDMMYY-002
...
```

`receipt_date` dùng cùng cutoff 06:00.

---

## 12. Dashboard sản xuất

Permission cho toàn bộ các tab/API:

```text
dashboard.view
```

Tabs:

```text
Dashboard | Check FIFO | Check item
```

### 12.1 Dashboard chính

Route:

```text
/production-dashboard
```

Filter:

- một ngày;
- khoảng ngày;
- view theo WO;
- view theo Item.

#### Pagination theo 7 ngày

Main table không phân trang theo số dòng. Mỗi page là:

```text
7 ngày lịch liên tiếp trong range user chọn
```

Ví dụ range `01/08 → 31/08`:

```text
Page 1: 01/08 → 07/08
Page 2: 08/08 → 14/08
...
```

Rule:

- `TOTAL` trong table chỉ tính 7 ngày đang hiển thị;
- popup chi tiết từ Dashboard cũng chỉ query đúng 7 ngày của page;
- query pallet theo batch `1000` dòng để tránh PostgREST max-row truncation;
- pagination link dùng `prefetch={false}` để tránh egress không cần thiết.

#### Summary toàn range

Top summary **không thay đổi khi chuyển page**.

RPC:

```text
dashboard_summary(date,date)
```

Summary toàn range gồm:

```text
Quan order
Pallet active
Đã sản xuất
Đã scan
Đã nhập kho
```

Aggregate chạy tại PostgreSQL, không tải cả range về Vercel để cộng.

#### Deleted pallet

Dashboard load cả:

```text
active rows: effect_to is null
terminal delete rows: effect_to is not null AND note like delete:%
```

Deleted pallet:

- giữ context WO/item/order/history;
- có warning `!`;
- không cộng vào active pallet count;
- không cộng Produced/Scanned/Warehouse.

### 12.2 Check FIFO

Route:

```text
/production-dashboard/check-fifo
```

Dùng tìm pallet chưa đi tới process tiếp theo.

Filter thời gian:

```text
Theo ngày
Khoảng ngày
Tất cả
```

Process:

```text
Sản xuất → status = production
Scan → status = pendingWH hoặc processingWH
```

`WHdone` không thuộc FIFO.

An toàn query `Tất cả`:

- tối đa 200 pallet/page;
- lấy thêm 1 row để biết còn page sau;
- không load toàn backlog;
- không `count(*)` toàn backlog chỉ để render UI;
- sort `working_day` tăng dần, pallet cũ nhất trước.

Số ngày delay:

```text
ngày hiện tại Việt Nam - working_day
```

Button `Xem tiến độ` gọi API/RPC aggregate theo WO hoặc Item:

```text
dashboard_progress
```

### 12.3 Check item

Route:

```text
/production-dashboard/check-item
```

Mục tiêu: tra toàn bộ lịch sử của **một itemcode** mà không phải tải toàn bộ pallet nhiều tháng/năm về Vercel.

UI chỉ có một ô search:

```text
itemcode
```

RPC:

```text
dashboard_check_item(text)
```

Database:

1. tìm toàn bộ data của item;
2. giữ active row + terminal delete context;
3. group trực tiếp theo `WO`;
4. trả mỗi WO một dòng aggregate.

Summary đặt phía trên:

```text
Itemcode
Product name
Customer
Quan order
Pallet active
Đã sản xuất
Đã scan
Đã nhập kho
```

Bảng phía dưới group theo WO:

```text
WO
Quan order
Số pallet
Đã sản xuất
Đã scan
Đã nhập kho
Chi tiết
```

Mỗi WO vẫn có `Xem pallet`. Popup sử dụng cùng component/history flow với Dashboard.

RPC trả thêm:

```text
first_working_day
last_working_day
```

để popup chi tiết chỉ query khoảng thời gian item thực sự tồn tại thay vì dùng date range giả rất lớn.

### 12.4 Popup pallet và history

Mỗi pallet có:

```text
Pallet ID
WO
Itemcode
Quantity
Status
Working day
Created at
WH receipt
History
```

Flow chính:

```text
Tạo pallet
→ Scan pallet
→ Nhập kho
```

History riêng:

```text
EDIT
RETURN
DELETE
```

Actor được resolve sang `full_name`, username/employee code khi có profile.

---

## 13. Trạng thái pallet

| Status | Ý nghĩa |
|---|---|
| `production` | Production |
| `pendingWH` | Đã scan, chờ confirm |
| `processingWH` | Đang xử lý tạo phiếu |
| `WHdone` | Hoàn tất nhập kho |

Luồng hợp lệ:

```text
production → pendingWH
pendingWH → production
pendingWH → processingWH
processingWH → WHdone
```

Không cho phép:

```text
WHdone → production
```

---

## 14. Database chính

### `profiles`

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

Danh mục permission hợp lệ.

### `user_permissions`

Permission cấp riêng cho user.

### `position_page_access`

Mapping position ↔ route.

### `planning_inject`

Planning được import.

### `item_pallet_config`

Quantity chuẩn/pallet theo item.

### `pallet_data`

Dữ liệu pallet + version chain.

Field quan trọng:

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

Hiện chủ yếu lưu event `scan_return`.

Edit/delete được audit bằng version chain trong `pallet_data`.

### `wh_receipt`

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

---

## 15. Supabase migrations

Thư mục:

```text
supabase/migrations/
```

Rule:

- chỉ chạy migration chưa applied;
- luôn đọc file trước `db push`;
- không chạy lại destructive migration trên production;
- backup trước thay đổi lớn;
- đổi RPC signature thì phải đổi API cùng commit;
- future object phải explicit GRANT vì Data API baseline là fail-closed.

Các migration mới cần nhớ:

```text
20260810144500_harden_business_rpcs.sql
20260810155000_dashboard_summary_rpc.sql
20260810162000_scan_batch_guard.sql
20260810163500_harden_data_api_surface.sql
20260810165500_dashboard_check_item_rpc.sql
```

Ý nghĩa:

- harden permission/ownership business RPC;
- aggregate summary toàn range Dashboard;
- scan/confirm max 200 pallet;
- thu hẹp direct Supabase Data API exposure;
- Check item aggregate toàn lịch sử theo WO.

Kiểm tra migration:

```bash
npx supabase migration list
npx supabase db push --dry-run
npx supabase db push
```

> `db push` chỉ áp dụng database migration. Auth config như disable signup/password policy không phải database migration.

---

## 16. PWA và Camera

App hỗ trợ standalone trên mobile/desktop.

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

Không có service worker/offline cache/background sync.

Camera Scan QR:

- dùng camera sau `facingMode: environment`;
- production cần HTTPS;
- user phải cấp camera permission;
- cần internet;
- thư viện scan hiện tải từ CDN `unpkg`, nên mạng nội bộ chặn CDN có thể làm camera không khởi tạo.

---

## 17. Deploy Vercel

Env cần có:

```env
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY
```

Checklist:

1. `git switch dev`
2. `git pull origin dev`
3. `npm install` nếu dependency đổi
4. `npm run build`
5. test Preview/local
6. kiểm tra migration remote
7. smoke test nghiệp vụ
8. chỉ sau đó merge/deploy production

---

## 18. Smoke test tối thiểu

### Auth/permission

- login superadmin/admin/user;
- inactive user bị chặn;
- public signup bị tắt trên hosted Supabase;
- password tạo/reset tối thiểu 8 ký tự;
- user không permission gọi direct protected API phải bị chặn.

### Planning/Production

- import/replace planning;
- WO `0`/trống không sang pallet;
- tạo pallet không trùng ID;
- edit version + reason + working day giữ nguyên;
- delete terminal version;
- không edit/delete ngoài `production`;
- PDF/QR hoạt động.

### Scan/Warehouse

- user chỉ thấy own pending scans;
- admin thấy pending theo rule hiện hành;
- indicator xuất hiện từ 150 pallet;
- pallet thứ 201 bị chặn cả frontend và DB;
- cancel trả `production` + history;
- confirm tối đa 200 pallet;
- receipt thành công → `WHdone`;
- `WHdone` không reverse.

### Dashboard

- summary toàn range không đổi khi chuyển page;
- table page đúng 7 ngày;
- TOTAL chỉ tính page;
- WO/Item aggregate đúng;
- deleted pallet giữ warning/context nhưng không cộng KPI;
- popup flow/history đúng;
- Check FIFO max 200/page;
- Check item search item toàn lịch sử, group theo WO và popup pallet hoạt động.

### Security

- `anon` không đọc business public tables;
- authenticated direct DML public tables bị chặn;
- `wh_receipt` direct SELECT bị chặn;
- non-dashboard user không đọc `pallet_change_history`;
- approved RPC hoạt động;
- non-whitelisted helper RPC bị từ chối.

---

## 19. Go-live — xóa data test, giữ Super Admin

**Không dùng `supabase db reset` trên hosted production.**  
**Không tạo migration để xóa test data.**

Mục tiêu trước go-live:

```text
Giữ schema + migrations + RLS + RPC + permission config
Giữ duy nhất Super Admin thật
Xóa business data test
Xóa Auth user test
```

### 19.1 Backup trước khi xóa

Tạo backup/database dump trước cutover theo công cụ Supabase CLI phù hợp với project hiện tại và lưu file ngoài môi trường tạm thời.

### 19.2 Kiểm tra số record business

Supabase SQL Editor:

```sql
select 'planning_inject' as table_name, count(*) from public.planning_inject
union all
select 'pallet_data', count(*) from public.pallet_data
union all
select 'pallet_change_history', count(*) from public.pallet_change_history
union all
select 'wh_receipt', count(*) from public.wh_receipt;
```

### 19.3 Xóa business test data

Chạy một lần trong SQL Editor:

```sql
begin;

truncate table
  public.pallet_change_history,
  public.pallet_data,
  public.wh_receipt,
  public.planning_inject
restart identity;

commit;
```

Sau đó chạy lại query count và xác nhận 4 bảng = `0`.

Không truncate:

```text
profiles
permissions
user_permissions
position_page_access
item_pallet_config
```

`item_pallet_config` chỉ xóa nếu xác nhận toàn bộ dữ liệu trong đó cũng là test; nếu là master data thật thì giữ.

### 19.4 Xóa user test

Dùng:

```text
Supabase Dashboard
→ Authentication
→ Users
```

Xóa từng tài khoản test và **giữ đúng Super Admin thật**.

Không dùng SQL thủ công để delete `auth.users` nếu không cần thiết.

Verify:

```sql
select id, username, full_name, role, position, is_active
from public.profiles
order by created_at;
```

Kết quả mong muốn trước khi tạo account production:

```text
profiles = 1 Super Admin active
business tables = 0
permissions = giữ nguyên
position_page_access = giữ nguyên
item_pallet_config = giữ nếu là master data thật
```

Sau đó:

```text
Super Admin login
→ tạo Admin thật
→ tạo User thật
→ import Planning thật
→ bắt đầu production
```

---

## 20. Lỗi thường gặp

### Missing service-role key

```text
Missing Supabase admin environment variables
```

Kiểm tra:

```env
SUPABASE_SERVICE_ROLE_KEY
```

### PDF font

```text
ENOENT ... Roboto-Regular.ttf
Unknown font format
```

Kiểm tra font TTF thật trong:

```text
assets/fonts/
```

và dùng `process.cwd()` khi resolve path.

### Legacy trigger

```text
record "new" has no field "returned_at"
```

Kiểm tra migration loại bỏ legacy return trigger.

### Permission key FK

```text
violates foreign key constraint user_permissions_permission_key_fkey
```

Permission phải tồn tại trong `permissions` trước khi insert `user_permissions`.

### `supabase config push` yêu cầu paid tier

Project hiện tại không dùng CLI config push cho Auth config. Chỉnh hosted Auth setting thủ công trong Supabase Dashboard và giữ `supabase/config.toml` làm baseline local/repo.

---

## 21. Nguyên tắc thay đổi sau baseline

- Không chỉnh trực tiếp pallet `WHdone`.
- Không thêm state transition ngoài workflow đã chốt nếu chưa review nghiệp vụ.
- Không tái sử dụng `receipt.create`/`receipt.edit`.
- Mọi ngày vận hành dùng timezone Việt Nam + cutoff 06:00.
- Field versioned mới phải được copy đúng qua edit/delete version.
- Không dùng service-role ở client.
- Không mở lại direct authenticated DML chỉ để tiện frontend.
- SECURITY DEFINER RPC mới phải tự kiểm tra auth/permission/ownership và explicit GRANT.
- Check FIFO không query toàn backlog trong một request.
- Dashboard range aggregate/Check item phải aggregate tại PostgreSQL.
- Scan batch không vượt 200 pallet.
- Không thêm offline operation nếu chưa có thiết kế chống duplicate/sync transaction.
- Không dùng destructive reset migration để chuẩn bị go-live.
- Luôn sửa trên `dev`, build/test trước khi merge `main`.
- Luôn cập nhật README khi workflow/database/security thay đổi.
