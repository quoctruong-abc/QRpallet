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
| `receipt.view` | Xem tab Receipt, lịch sử/chi tiết/in lại phiếu |
| `view-WH` | Xem Xuất kho / Nhập kho / Đối soát; đề xuất nhập/xuất thủ công |
| `edit-WH` | Kèm `view-WH`: duyệt, ghi nhận và chỉnh sửa kho |
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

### 8.1.1 In tem ngày cũ

- Tab **WO** giữ luồng tra WO, xem pallet, in lại và in bù hiện tại.
- Tab **itemcode** tìm chính xác item (hỗ trợ `*` điền 0 thành 13 ký tự), tra WO
  trong `pallet_data`, hiện bảng tiến độ để chọn. Chi tiết WO luôn lọc thêm item
  đã tìm; phiên bản lịch sử hết hiệu lực chỉ được xem, không in lại trực tiếp.
- Có thể chọn **In theo WO mới** dù item đã có WO. Form này lấy tên sản phẩm từ `item_pallet_config.product_name`, fallback
  `ERP_name`; lấy khách hàng từ cùng cấu hình. Thiếu tên/khách hàng thì báo cập nhật.
- Form mới bắt buộc WO, ngày sản xuất, số lượng trên tem và số lượng đơn hàng.
  Khi rời ô WO, kiểm tra trùng toàn bộ `pallet_data` (không phân biệt hoa/thường,
  trim khoảng trắng đầu/cuối, bao gồm lịch sử xóa/phiên bản cũ và item khác).
  Nút in chỉ mở sau khi WO hợp lệ; sửa WO hoặc kiểm tra lỗi thì khóa lại.
- RPC `create_pallet_from_new_wo` kiểm tra lại WO và cấu hình trong transaction,
  lấy khóa WO chuẩn hóa rồi khóa chung với `create_pallet_record` trước khi ghi.
  Kiểm tra blur không phải đặt chỗ; hai người tạo cùng WO chỉ một người thành công.
  In thêm/in bù WO đã có vẫn theo luồng cũ.
- Migration `20261119120000_new_pallet_wo_guard.sql` thêm kiểm tra/tạo WO mới và sửa
  riêng padding số thứ tự để sau `999` là `1000`, không bị `lpad` cắt thành `100`.
  Guard sẽ từ chối migration nếu không nhận diện được biểu thức counter hiện tại.
- Migration `20261119100000_pallet_itemcode_work_orders.sql` chỉ thêm RPC tra cứu
  tổng hợp trong DB, quyền `pallet.create`; không sửa dữ liệu hay bật scan nhập tồn.
  Chạy `supabase db push` sau khi pull code để tab itemcode có thể tra cứu.
- Kiểm thử API/lookup: `npm run test:pallet-itemcode`.
- Kiểm thử nhiều session: `PALLET_POSTGRES_BIN=/usr/lib/postgresql/17/bin npm run test:pallet-new-wo:postgres`.
  Script tự tạo/hủy cluster cục bộ, không nhận URL database thật; kiểm tra tạo
  trùng, khác hoa/thường, rollback, chạy song song với in WO cũ và timeout khóa.

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

Trong **Cài đặt pallet**, sau khi tìm itemcode sẽ hiện tên sản phẩm (ưu tiên
`product_name`, fallback `ERP_name`) và khách hàng hiện tại. Có thể lưu đồng thời
số lượng pallet chẵn và khách hàng mới vào `item_pallet_config`. Dropdown khách
hàng lấy các tên không trống, đã trim/lọc trùng từ toàn bộ `pallet_data`; giữ được
khách hàng hiện tại nếu tên này chưa có trong lịch sử. Không ghi lại pallet cũ.

Migration `20261119110000_pallet_config_customers.sql` thêm RPC đọc danh sách và
lưu cấu hình với quyền `pallet.create`, kiểm tra khách hàng ở server và giữ thứ
tự khóa chung với các luồng cập nhật danh mục. Không kích hoạt scan nhập tồn.

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

## 11. Module 4 — Quản lý kho

Route:

```text
/warehouse-receipt
```

Ba tab **Xuất kho**, **Nhập kho**, **Đối soát** yêu cầu `view-WH`. Tab **Receipt**
giữ quyền `receipt.view` riêng. Chỉ render và tải dữ liệu của các tab được phép.
Mặc định mở Xuất kho nếu có quyền kho; tài khoản chỉ xem Receipt mở Receipt.
Nhập kho/Xuất kho thủ công cho phép user đề xuất bằng `view-WH`. Supervisor
có thêm `edit-WH` mới ghi nhận tồn hoặc xuất thực tế. Đối soát chưa triển khai.
Tích hợp dữ liệu sau confirm scan sẽ triển khai sau cùng.

Toàn bộ chức năng phiếu nhập kho hiện tại nằm trong tab **Receipt**:

- xem lịch sử;
- tìm theo ngày;
- xem chi tiết;
- in lại PDF;
- tải Excel.

Receipt chỉ tải dữ liệu khi mở tab lần đầu; bộ lọc và kết quả được giữ khi
chuyển sang tab khác rồi quay lại. Quyền Receipt độc lập với hai quyền kho mới.

Không reverse sau `WHdone`.

Receipt ID:

```text
WH-DDMMYY-001
WH-DDMMYY-002
...
```

`receipt_date` dùng cùng cutoff 06:00.

### 11.1 Nhập kho thủ công

- Bắt buộc: Ngày nhập kho, Ngày sản xuất, Mã sản phẩm (`itemcode`), Số lượng (số nguyên dương).
- Ngày nhập kho mặc định ngày lịch hiện tại tại `Asia/Ho_Chi_Minh` (không trừ
  cutoff 06:00); có thể sửa theo từng dòng và được giữ trong lúc nhập liên tiếp.
- Không bắt buộc: WO, Ghi chú.
- Nhập mã sản phẩm → Tab sang Số lượng → hoàn tất thông tin bắt buộc → Enter
  để gửi Proposal và quay về ô Mã sản phẩm. Tên/khách hàng tự điền khi rời ô mã.
- Nút Nạp nhập kho lần đầu chỉ hiển thị cho superadmin; xem mục 11.4.
- Mã viết tắt có một dấu `*` được chèn số 0 cho đủ 13 ký tự, ví dụ
  `11011*209` → `1101100000209`. Mã không có `*` được giữ nguyên sau khi trim.
  Frontend và API cùng dùng quy tắc này; mã viết tắt không hợp lệ bị từ chối.
- POST `/api/warehouse-receipt/item-lookup` yêu cầu `view-WH`; tra cứu chung qua
  `item_pallet_config` và fallback từng trường từ `pallet_data`. Tên sản xuất
  ưu tiên trước tên ERP. Khách hàng có thể trống; item chưa khai báo hoặc chưa
  có tên dùng được bị từ chối.
- Form manual có **Gửi Proposal nhập kho**. Nhập mã → Tab sang số lượng →
  hoàn tất thông tin bắt buộc rồi Enter để gửi trực tiếp một dòng vào Proposal.
  Mã/tên/khách hàng được kiểm tra lại tại backend, kể cả khi lookup giao diện
  đang chạy. Không còn danh sách chờ nhập local hoặc bước kiểm tra riêng.
- Mọi tài khoản có `view-WH`, bao gồm supervisor, đều gửi qua
  `/api/warehouse-receipt/incoming-proposals` và `propose_manual_inventory`;
  thao tác này chỉ lưu đề xuất, chưa tạo `inv_incoming` hoặc cộng tồn.
- **Proposal nhập kho** là danh sách dùng chung duy nhất, có người đề xuất.
  Supervisor có `view-WH` + `edit-WH` được sửa/xóa, tick chọn từng dòng (mặc
  định tick all), rồi **Duyệt và nhập kho** qua popup xác nhận. Các dòng chưa
  chọn vẫn chờ duyệt. `approve_incoming_proposals` khóa ID/version và gọi
  `post_manual_inventory` trong cùng transaction; một dòng lỗi rollback cả lần.
- UUID và payload được lưu trước khi gửi, thời hạn 7 ngày, để retry cùng thao
  tác khi mất kết nối. Form chỉ reset sau khi xác nhận gửi thành công. Lỗi dữ
  liệu rõ ràng cho phép sửa nội dung form trước khi gửi lại.
- Bản nháp từ giao diện cũ được giữ lại: một dòng được khôi phục vào form,
  nhiều dòng có nút chuyển sang Proposal hoặc khôi phục từng dòng để sửa
  thông tin trước khi gửi. Lần gửi/nhập cũ chưa rõ kết quả vẫn
  giữ nguyên UUID, payload và loại thao tác, không chuyển một lần nhập kho cũ
  thành đề xuất mới. `/api/warehouse-receipt/incoming` còn phục vụ retry cũ có
  `edit-WH`; giao diện mới chỉ ghi tồn qua bước duyệt Proposal.
- Thời hạn 7 ngày áp dụng cho bản lưu trình duyệt. Proposal đã gửi được lưu
  trong DB tới khi supervisor duyệt/xóa. Bản lưu thay đổi ở tab khác yêu cầu
  tải lại để tránh ghi đè. Thành công xóa phần đã gửi và giữ phần còn lại của
  các bản lưu cũ, nếu có.

Chạy script `supabase/migrations/20261022090000_warehouse_item_catalog.sql`
trước khi dùng tra cứu. Script thêm `product_name`, `customer`, backfill một lần
từ `pallet_data` và tạo RPC `resolve_warehouse_item(text)` chỉ cho service role.
Có thể chạy lại; không ghi đè tên/khách hàng đang có hoặc số lượng chuẩn/pallet.
`quantity_per_pallet` được phép NULL cho item chỉ có thông tin mô tả; màn hình
in tem vẫn coi NULL là chưa cấu hình và yêu cầu bổ sung trước khi in pallet đầy.

### 11.2 Bảng tồn kho theo từng dòng nhập

Script: `supabase/migrations/20261026090000_inventory_incoming.sql`.
Bảng mới `public.inv_incoming` độc lập với `wh_data_pallet`, mỗi dòng là một
nguồn tồn/lô nhập. Form nhập tay đã nối qua RPC ở migration tiếp theo;
confirm scan chưa nối.

| Nội dung | Cột | Kiểu / quy tắc |
| --- | --- | --- |
| ID | `id` | bigint identity, khóa chính |
| Ngày nhập kho | `received_date` | date, mặc định ngày nghiệp vụ Việt Nam với cutoff 06:00 |
| Ngày sản xuất | `production_date` | date, có thể NULL |
| Mã sản phẩm | `itemcode` | text bắt buộc, lưu mã đầy đủ đã xử lý dấu `*` |
| Tên sản phẩm | `product_name` | text bắt buộc, snapshot khi nhập |
| Tên khách hàng | `customer` | text bắt buộc, snapshot khi nhập |
| WO | `wo` | text, có thể NULL |
| Số lượng nhập | `received_qty` | integer > 0 |
| Số lượng xuất | `issued_qty` | integer, mặc định 0, từ 0 đến số lượng nhập |
| Tồn kho | `balance_qty` | generated stored = nhập − xuất, không sửa trực tiếp |
| Người nhập | `entered_by`, `entered_by_name` | FK profiles + tên chụp tại thời điểm tạo |
| Thời điểm ghi nhận | `created_at` | timestamptz, mặc định now() |
| Liên kết phiếu nhập | `receipt_id` | FK `wh_receipt.receipt_id`, có thể NULL cho nhập tay |
| Ghi chú | `note` | không bắt buộc, lưu chuỗi rỗng khi bỏ trống |
| Cập nhật cuối | `updated_at` | timestamptz, tự cập nhật khi sửa |
| Lần ghi nhận thủ công | `manual_batch_id`, `manual_line_no` | FK batch + số dòng, duy nhất trong mỗi lần ghi nhận |

Trigger lấy tên người nhập từ profile, không nhận tên tùy ý từ client. Khi tài
khoản đổi tên hoặc bị xóa, tên snapshot vẫn được giữ. Backend dùng service role
phải truyền ID profile đã xác thực khi insert; user không ghi trực tiếp bảng.
Authenticated chỉ đọc khi có `view-WH`; anon không được truy cập. Ghi tồn
phải qua RPC có `view-WH` + `edit-WH`.

Index FIFO chỉ gồm dòng tồn > 0: `itemcode`, `coalesce(production_date,
received_date)`, `received_date`, `id`. Ngày sản xuất thiếu vẫn giữ NULL trong
dữ liệu gốc; thứ tự tham chiếu dùng ngày nhập. Một item có thể có nhiều dòng nhập.
Khi xây bảng xuất sau này, mỗi dòng xuất sẽ liên kết `inv_incoming.id` và tổng
xuất phải được cập nhật cùng transaction với các dòng xuất liên quan.

### 11.3 Áp dụng backend nhập tay trên Codespace

Ưu tiên Supabase CLI theo workflow login/link hiện tại. Khi SQL đã chạy trực
tiếp ngoài CLI, cần đối chiếu schema trước khi đánh dấu applied. Có dòng trong
history chưa chứng minh bảng/hàm đã tồn tại. `migration repair` chỉ sửa history,
không thực thi lại nội dung migration.

```bash
cd /workspaces/QRpallet
git switch dev && git pull --ff-only
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase migration list
npx supabase db push --dry-run
```

Thay `YOUR_PROJECT_REF` bằng Project ID của đúng database cần cập nhật. Nếu
Codespace đã link đúng project, có thể bỏ bước link.

Kiểm tra dry-run: thứ tự là `20261026100000_post_manual_inventory.sql`,
`20261105090000_optional_inventory_note.sql`,
`20261105100000_opening_inventory_import.sql` và
`20261105110000_opening_inventory_outflow_and_catalog.sql` cho các bước chưa chạy. Khi
danh sách khớp với schema hiện tại, chạy:

```bash
npx supabase db push
npx supabase migration list
```

Nếu dry-run liệt kê thêm migration cũ hoặc báo lệch history khác, cần đối chiếu
những migration đó với schema thực tế trước; không đánh dấu hàng loạt tất cả
file đã applied. Migration nhập tay tạo batch, khóa chống trùng và RPC; migration
ghi chú cho phép để trống ghi chú ở cả RPC và bảng tồn kho.

#### History có 20261026090000 nhưng bảng inv_incoming chưa tồn tại

Lỗi `relation "public.inv_incoming" does not exist` khi chạy
`20261026100000` có nghĩa prerequisite tạo bảng chưa có trên database đích.
Nếu history đang đánh dấu `20261026090000` applied, bỏ đúng dấu đó rồi áp dụng
SQL thật theo thứ tự; không đánh dấu migration tạo bảng applied thêm lần nữa.

```bash
npx supabase migration repair 20261026090000 --status reverted
npx supabase db push --dry-run
```

Với trạng thái history này, dry-run phải liệt kê lần lượt
`20261026090000_inventory_incoming.sql`,
`20261026100000_post_manual_inventory.sql`,
`20261105090000_optional_inventory_note.sql`,
`20261105100000_opening_inventory_import.sql` và
`20261105110000_opening_inventory_outflow_and_catalog.sql`. Khi danh sách khớp, chạy:

```bash
npx supabase db push
npx supabase migration list
```

`repair --status reverted` ở đây chỉ bỏ dấu trong history, không xóa bảng hay
dữ liệu nghiệp vụ. Không revert migration khác hoặc dùng reset để xử lý lỗi này.

### 11.4 Nạp nhập kho lần đầu

Trong **Quản lý kho → Nhập kho**, superadmin chọn file `.xlsx` (tối đa 4 MB,
20.000 dòng), kiểm tra file và xác nhận nạp. Sheet **Detail** có tiêu đề dòng 5,
dữ liệu từ dòng 6. Các lỗi chỉ rõ dòng Excel; cả file phải hợp lệ trước khi ghi.

| Cột | Quy tắc |
| --- | --- |
| A, F | Bỏ qua |
| B | Ngày nhập, ô ngày Excel hoặc text tháng/ngày/năm |
| C | Ngày sản xuất nếu có, ô ngày Excel hoặc text ngày/tháng/năm; chấp nhận dấu nháy đầu |
| D, E, G | Mã, tên sản phẩm và WO; mã có số 0 đầu nên lưu dưới dạng Text |
| H | Số nhận của lô tồn đầu, không có ngày sản xuất |
| I, J, K | Số nhận bổ sung, tổng số đã xuất và số tồn của dòng Excel |

Dòng chỉ có H kiểm tra K = H − J; nếu không xuất, K trống được hiểu bằng H.
Dòng chỉ có I kiểm tra K = I − J. Khi có cả H và I, kiểm tra K = H + I − J,
tách thành hai lô và phân số xuất vào lô H trước. Database tự tính tồn từng lô.
Nếu dòng chỉ có tồn đầu và cột B trống, chọn **Ngày nhập cho tồn đầu thiếu ngày**
trong hộp thoại. Ngày này không thay thế ngày có sẵn hoặc ngày của dòng nhập I.
Tên sản phẩm và khách hàng ưu tiên từng trường từ `item_pallet_config`, nếu
thiếu thì tìm trong `pallet_data` và bổ sung cấu hình. Nếu vẫn thiếu tên,
dùng cột E; nếu vẫn thiếu khách hàng, để trống. Bản xem trước hiển thị kết quả tra cứu.
Giao dịch ghi toàn bộ file cùng lúc và lưu số dòng Excel để truy vết. Nội dung
tồn kho giống hệt đã nạp sẽ không được ghi lại, kể cả đổi tên file hoặc thứ tự dòng.

Nếu xem trước báo Supabase chưa thấy hàm (ví dụ `PGRST202`), kiểm tra migration
`20261105110000_opening_inventory_outflow_and_catalog.sql` trên đúng project mà
ứng dụng đang dùng. Có thể kiểm tra trực tiếp trong SQL Editor:

```sql
select
  to_regprocedure('public.lookup_opening_inventory_items(text[])') as lookup_rpc,
  to_regprocedure('public.post_opening_inventory(uuid,text,text,jsonb,text)') as import_rpc;
```

Nếu cả hai hàm đã tồn tại, chạy `notify pgrst, 'reload schema';` rồi thử lại.


### 11.5 Xuất kho và tổng hợp tồn kho theo item

Mô hình hiện tại dùng migration `20261105140000_item_stock_summary.sql`, sau
các migration tồn kho/xuất kho trước đó. Trong Codespace đã link đúng Supabase:

```bash
git switch dev && git pull --ff-only
npx supabase login
npx supabase migration list
npx supabase db push --dry-run
# Kiểm tra danh sách migration chờ chạy rồi áp dụng thật:
npx supabase db push
npm run test:delivery
```

**Tổng hợp tồn kho** nằm đầu tab Xuất kho, thu gọn mặc định. Khi mở,
tìm item/tên/khách hàng ngay khi gõ và có thể lọc chỉ item thiếu hàng.
Cột Khách hàng hiển thị riêng. Một dòng cho mỗi item trong `inv_stock_summary`:

| Cột | Ý nghĩa |
| --- | --- |
| `received_qty`, `issued_qty` | Tổng số nhận và đã xuất của các lô nhập |
| `balance_qty` | Tồn thực tế = tổng nhận − tổng đã xuất |
| `on_order_qty` | Toàn bộ số còn phải giao của yêu cầu chưa hủy, kể cả phần vượt tồn |
| `available_qty` | Tồn sau lịch giao = tồn thực tế − On order; có thể âm |
| `shortage_qty` | Phần thiếu = max(On order − tồn thực tế, 0) |
| `updated_at` | Thời điểm tính lại |

Nguồn dữ liệu là `inv_incoming` và `inv_delivery_requests`. Trigger tính lại
chỉ các item bị thay đổi sau INSERT/UPDATE/DELETE, theo tập item của mỗi statement;
sửa itemcode tính cả mã cũ và mới. Nhập tay, nạp tồn đầu, cập nhật lịch giao,
xuất thực tế, hủy/sửa yêu cầu đều cập nhật tổng hợp cùng transaction.
Các giao dịch ghi được khóa thống nhất để tránh ghi đè tổng từ dữ liệu cũ.
Không cho browser sửa trực tiếp bảng tổng hợp.

- Nhận file `.xlsx` tối đa 4 MB/500 dòng hàng, sheet
  `Srithai_Sales_Delivery_Schedule`. Đọc B: ngày giao, I: Purchorder,
  N: Sales ID, Q: No, S: Item, AC: Sales Qty; D/X/AF bổ sung tên khách,
  tên sản phẩm, đơn vị. Chỉ bung giá trị trong đúng vùng merge.
- Bảng kiểm tra file giữ thứ tự dòng Excel. Xác nhận danh sách giao hàng mới
  cập nhật yêu cầu và On order, chưa giữ/chọn lô nhập.
- Khóa nghiệp vụ PO + Sales ID + itemcode + ngày giao chống trùng. UUID nội bộ
  giữ nguyên khi dời lịch. Upload không đổi được bỏ qua; không cộng Sales Qty
  giữa các lần upload; dòng vắng trong file mới không tự bị hủy.
- Cùng PO/Sales ID/item ở ngày khác phải chọn rõ lịch mới hay dời lịch cũ.
  Nhu cầu dự kiến được tính lại theo lựa chọn trước khi gửi và kiểm tra lại
  khi ghi. Cùng một lịch không được cập nhật hai lần trong một đợt nạp.
- Không xét/quy đổi đơn vị Bộ ở giai đoạn này; giữ nguyên Sales Qty.
- **Còn phải giao** thuộc từng yêu cầu. **Thiếu của item** là tổng thiếu của
  tất cả lịch giao của item, không phải lượng được cấp riêng cho SO đó.
- **Xuất** nhận số thực xuất và ngày thực xuất. Gợi ý FIFO chỉ đọc tồn hiện tại,
  không giữ lô. Khi xác nhận, hệ thống kiểm tra lại tồn và chọn FIFO theo
  `production_date nulls first, received_date, id`: lô không có ngày sản xuất
  đi trước, rồi tới lô có ngày sản xuất cũ nhất. Không gắn lô khi nạp lịch.
- Khi yêu cầu còn chờ, số thực xuất có thể vượt số còn phải giao nếu tồn
  thực tế đủ. Giữ nguyên số yêu cầu, ghi đủ số thực xuất, chặn số còn phải
  giao ở 0 và đánh dấu Done. Phần xuất vượt không trừ On order của lịch khác.
  Số đã xuất của lô, tiến độ yêu cầu và phiếu xuất được ghi cùng transaction.
  Gửi lại UUID/payload cũ trả kết quả cũ, không trừ thêm.
- Chờ xuất → Xuất một phần → Done theo số đã xuất. Giảm yêu cầu/hủy phần chờ
  giảm On order; không sửa lịch sử đã xuất. Ngày dự kiến và ngày xuất thực tế
  tách riêng. Yêu cầu đã hủy không tự mở lại khi upload cùng khóa.

| Bảng | Vai trò |
| --- | --- |
| `inv_stock_summary` | Tổng tồn và nhu cầu theo item |
| `inv_incoming` | Các lô nhập, ngày sản xuất, số nhận/đã xuất/tồn; không còn reserved_qty |
| `inv_delivery_requests` | Lịch giao, yêu cầu, đã giao, version, trạng thái hủy; không giữ lô |
| `inv_delivery_issues`, `inv_delivery_issue_lines` | Lịch sử xuất thực tế và lô đã lấy |
| `inv_delivery_commands` | Audit và chống ghi trùng thao tác |
| `inv_delivery_reservations_legacy` | Bản đăng ký giữ lô trước chuyển đổi, chỉ admin database tra cứu |

Migration chỉ xây lại tổng hợp và chuyển mô hình đăng ký. Không sửa số đã xuất,
phiếu xuất hoặc chi tiết lô đã xuất. Version yêu cầu được tăng để trình duyệt cũ
không gửi tiếp lệnh chưa thực hiện theo dữ liệu cũ; lệnh đã ghi vẫn retry được
bằng UUID cũ. Dữ liệu giữ lô cũ không còn tham gia tính tồn/On order.

Migration `20261105150000_delivery_system_customer.sql` thêm
`inv_delivery_requests.system_customer_name`. Tên khách hệ thống lấy theo item:
ưu tiên danh mục `item_pallet_config`, sau đó lấy tên khách gần nhất có giá trị
trong `inv_incoming`. Nếu cả hai nguồn trống thì để trống; giữ nguyên tên khách
ERP trong `customer`. Migration bổ sung tên cho lịch đã có, và thay đổi nguồn
tên sẽ đồng bộ cho item liên quan. Danh sách chờ xuất có cột Khách hệ thống
và bộ lọc ngày giao/khách hệ thống; các lựa chọn lấy từ dữ liệu đã tải.
Bảng tổng hợp và danh sách chờ tải các trang một lần mỗi lần làm mới,
sau đó tìm kiếm/lọc tại trình duyệt.

Migration `20261106100000_stock_fifo_overship.sql` áp dụng thứ tự FIFO mới,
cho phép xuất vượt yêu cầu và thêm `list_stock_production_dates`. Nút con mắt
trong bảng tổng hợp tải tồn thực tế theo ngày sản xuất: chỉ đếm lô còn hàng
và xếp nhóm không có ngày sản xuất lên đầu.

Migration `20261106110000_manual_delivery.sql` thêm nhập lịch giao thủ công.
Khung nhập mặc định thu gọn; người dùng điền ngày giao, mã sản phẩm và số lượng.
Tên sản phẩm và khách được tra từ dữ liệu nội bộ. Lịch được đánh dấu **Nhập tay**
với mã tham chiếu riêng, không cần PO/Sales ID, và cập nhật On order như lịch ERP.
Gửi lại cùng mã thao tác không tạo thêm lịch.

Migration `20261106120000_review_delivery_fifo.sql` thêm **Review** trên danh
sách chờ xuất. Review dùng toàn bộ kết quả lọc, gồm các trang chưa hiển thị,
gộp số còn phải giao theo item và gợi ý lượng lấy theo từng ngày sản xuất.
Ô **Nhập tay** chỉ hiện các yêu cầu chờ được nhập thủ công. Review chỉ đọc
tồn thực tế, ưu tiên lô không có ngày sản xuất và báo số còn thiếu.

Migration `20261106130000_bulk_delivery_lots.sql` thêm **Xuất hàng loạt**.
Bảng sử dụng toàn bộ kết quả đã lọc và mặc định chọn lô theo FIFO. Người
dùng có thể bỏ lô hoặc sửa số lượng lấy; khi xác nhận, database kiểm tra lại
tồn từng lô và phân số thực xuất vào các yêu cầu theo ngày giao sớm trước.
Một lần xác nhận ghi toàn bộ phiếu và các lô trong cùng giao dịch; thử lại
cùng mã thao tác không trừ tồn lần nữa. **Review** có thể sao chép bảng dưới
dạng ảnh PNG. Bảng xuất hàng loạt hiển thị mã lô và số lượng sau khi sửa.

Migration `20261106140000_bulk_delivery_overship.sql` cho phép xuất vượt
nhu cầu khi lô còn đủ tồn. Hệ thống đáp ứng các yêu cầu được chọn theo thứ
tự giao trước, rồi ghi phần vượt vào yêu cầu cuối của item; số yêu cầu
gốc giữ nguyên. Giao diện cảnh báo số vượt và chỉ ghi các item được tick.
Migration `20261106160000_bulk_delivery_require_stock.sql` chặn xác nhận khi
có item đang tick mà tổng tồn thực tế không đủ số còn phải giao. Người dùng
có thể bỏ tick item thiếu tồn; vẫn được chọn xuất một phần cho item đủ tồn.

Super Admin có thể chọn **Nhập kho → Nạp master data** sau khi áp dụng
migration `20261112100000_warehouse_master_data.sql`. File .xlsx có sheet
`data`, cột A là itemcode, B là tên ERP và F là khối lượng theo đơn vị trong
file. Bước kiểm tra xem trước số mã thêm, cập nhật và không đổi. Mã cũ chỉ
cập nhật `"ERP_name"` và `netweight`; mã mới dùng tên ERP cho `product_name`
và để trống khách hàng, định mức pallet. Cột F trống không ghi đè khối
lượng đã có. Dòng trùng hoàn toàn được gộp; mã trùng khác nội dung chặn cả file.

**Nhập kho → Nạp data ghép cặp** dành cho Super Admin sau migration
`20261112110000_warehouse_item_build_up.sql`. File .xlsx có sheet
`Master Data`, đọc mã mẹ ở cột A và mã con 1/2/3 ở cột C/E/G. Một dòng
cần có mã mẹ và ít nhất một mã con; các vị trí con còn trống lưu là NULL.
Bảng `item_build_up` giữ từng tổ hợp theo đúng vị trí cột, cho phép một mã
mẹ có nhiều bộ mã con và không ghi trùng tổ hợp khi nạp lại.

Migration `20261112120000_warehouse_catalog_editors.sql` thêm hai form
trong **Nhập kho**; sau migration phân quyền WH, hai form này yêu cầu
`view-WH` + `edit-WH`. **Cập nhật itemcode** lưu tên sản phẩm và
khách hàng tùy chọn từ danh sách khách hàng đã có. **Cập nhật ghép cặp**
tra tên từ danh mục; nếu mã mẹ đã có tổ hợp, người dùng chọn tổ hợp cần
thay và xác nhận.

Migration `20261116100000_warehouse_catalog_link_existing_items.sql`
bắt buộc mã mẹ và các mã con đã điền phải có trong `item_pallet_config`.
Tên hiển thị ưu tiên `product_name` rồi `"ERP_name"`; thiếu cả hai sẽ
chặn lưu. Đổi mã mẹ giữ nguyên các mã con đang nhập. Form ghép cặp chỉ
ghi `item_build_up`. Form itemcode có thêm tên ERP và khối lượng tùy chọn.

Migration `20261116110000_delivery_build_up.sql` áp dụng ghép cặp cho lịch
giao thủ công và ERP. Lịch mới tra `item_build_up`: nếu một mã mẹ có nhiều tổ
hợp, người dùng chọn tổ hợp trước khi xác nhận. Mỗi vị trí mã con tính một đơn vị
trên mỗi mã mẹ; mã con lặp được gộp và nhân số lượng theo số lần xuất hiện.
Hệ thống chỉ tách một cấp. `inv_delivery_requests.request_type` phân biệt
`origin`, `parent`, `child`; `parent_request_id` nối dòng con với yêu cầu gốc.
Dòng mẹ lưu ngày giao, PO/Sales ID và số lượng gốc để đối chiếu. Chỉ dòng con
và dòng thường tính On order, kiểm tra thiếu tồn, Review và xuất FIFO. Nạp lại
hoặc dời lịch giữ các mã con đã chốt; các yêu cầu tồn tại trước migration vẫn
là `origin` và không tự tách.

Migration `20261118090000_delivery_component_identity.sql` tra từng mã con
để lấy tên sản phẩm và khách hàng riêng, hiển thị khi chọn tổ hợp trong nhập
thủ công và kiểm tra ERP. Tên ưu tiên `product_name`, rồi `"ERP_name"`;
tra cứu còn lại dùng nguồn database hiện có của nhập lịch thủ công.
Khách của mã con có thể khác mã mẹ và khác các mã con còn lại; nếu không có
thì để trống. Danh sách chờ, bộ lọc khách hàng và Review dùng khách của từng
mã con. Migration sửa thông tin mã con đã tạo, giữ nguyên số lượng và lịch sử xuất.

Migration `20261118100000_parent_delivery_workflow.sql` chuyển danh sách chờ,
Review và Xuất hàng loạt sang mã mẹ. Bộ lọc có thể khớp thông tin mã con nhưng
luôn giữ cả tổ hợp. Review gộp cùng mã mẹ và cùng tổ hợp đã chốt; các tổ hợp
khác nhau của cùng mã mẹ được giữ riêng. Hàng thường tiếp tục dùng mã gốc.
Chọn/bỏ chọn cả nhóm; sửa lô vẫn thao tác theo từng mã con. Backend chặn xuất
nếu thiếu mã con, lượng xuất chia tỷ lệ không bằng nhau hoặc không nguyên,
lịch sử các mã con đã lệch, hoặc tổng tồn không đáp ứng toàn bộ nhu cầu được
chọn. Tồn và từng lô dùng chung được kiểm tra trên tất cả nhóm, kể cả hàng
thường dùng cùng mã con. Khi đổi lựa chọn có thể bấm **Khôi phục FIFO đã chọn**
để phân bổ lại các lô giữa các nhóm.

Xuất một phần và xuất vượt vẫn được phép nếu tất cả mã con đồng bộ. Hệ thống
phân bổ số lượng mã mẹ cho các SO theo ngày giao, thời điểm tạo và ID trước,
rồi nhân tỷ lệ cho từng mã con; phần vượt thuộc SO cuối cùng của nhóm.
Ghi toàn bộ trong một transaction, cập nhật tồn, lịch sử mã con và phiên bản
mã mẹ cùng nhau. Tiến độ mã mẹ tính từ lịch sử mã con; không tự sửa các lượt
xuất cũ đã lệch tỷ lệ. Dữ liệu lệch được cảnh báo và chặn xuất tiếp để đối chiếu.
Các RPC cũ không còn cho xuất/hủy riêng mã con; retry của thao tác đã ghi
vẫn trả kết quả cũ để tránh trừ tồn hai lần.

Giao diện giữ bố cục cũ cho mã thường: một dòng chứa tên, khách hàng, số lượng,
ngày sản xuất/FIFO và nút sửa lô. Chỉ mã mẹ mới có bảng mã con và kiểm tra
đồng bộ tổ hợp. Bảng Review copy ảnh vẫn dùng các cột cũ; mã con được trình bày
bên dưới mã mẹ, hàng thường không lặp thêm dòng chi tiết.

Migration `20261118110000_unified_warehouse_item_lookup.sql` thống nhất tra cứu
cho nhập kho manual, xuất kho manual/ERP và cập nhật ghép cặp. Tên ưu tiên
`product_name` → `"ERP_name"` → tên trong `pallet_data`; khách hàng tra độc lập
từ config → pallet data → để trống. Không dùng định mức hoặc khối lượng để
quyết định item có hợp lệ. Fallback từ tên ERP chỉ dùng để hiển thị; fallback
từ pallet data chỉ bổ sung trường còn thiếu, không ghi đè thông tin đã khai báo.

Nhập kho manual chấp nhận khách hàng trống. Lịch xuất yêu cầu item đã có trong
config hoặc pallet data và có tên hợp lệ; tồn kho hay tên trong file ERP không
thay thế việc khai báo item. Bảng kiểm tra ERP vẫn hiện dòng lỗi và lý do từ chối,
khóa xác nhận khi còn lỗi. Backend kiểm tra lại cả mã gốc và mã con của tổ hợp
được chọn, từ chối toàn bộ thao tác nếu có lỗi. Tên/khách ERP gốc được giữ để
đối chiếu. Tổ hợp cũ giữ snapshot mã con, các tổ hợp khác không bị ép dùng chung.

Popup cập nhật ghép cặp rộng hơn, hiển thị itemcode, toàn bộ tên sản phẩm tự
xuống dòng và khách hàng riêng của từng mã. Mã mẹ và các mã con phải tra được
theo logic chung; thay mã mẹ giữ nguyên mã con. Tên/khách có sẵn trong pallet
data được bổ sung vào config khi lưu; không tạo item từ nội dung file lịch ERP.

Migration `20261118120000_active_item_build_up.sql` thêm `item_build_up.active`
và giới hạn mỗi mã mẹ có tối đa một bộ active. Dữ liệu cũ có một bộ duy nhất
được đặt active; mã mẹ có nhiều bộ giữ deactive để người dùng chọn lần đầu.
Xuất manual và ERP tự dùng bộ active, chỉ hiện chọn bộ khi chưa có active.
Một lựa chọn ERP áp dụng chung cho các lịch mới của cùng mã mẹ trong file.
Frontend gửi `needs_activation` và token active tại lúc tra cứu; backend kiểm
tra lại dưới transaction lock, chỉ kích hoạt sau khi tạo lịch thành công.
Thao tác lỗi rollback cả lịch lẫn active. Nếu người khác đã chọn cùng bộ thì
tiếp tục, chọn bộ khác thì báo tra lại. Dùng bộ đã active không cập nhật thừa
dòng ghép cặp; retry đã thành công và dời lịch cũ không đổi mặc định mới.

**Cập nhật ghép cặp** hiện toàn bộ Active/Deactive và chọn mặc định bộ active.
**Thêm bộ mới** hoặc xác nhận lưu một bộ có sẵn sẽ đặt bộ đó active, các bộ
khác cùng mã mẹ deactive. Lịch cũ giữ snapshot mã con. Nạp file ghép cặp vẫn
bổ sung tổ hợp deactive, không tự thay mặc định đã có hay chọn tùy tiện giữa
nhiều bộ; người dùng chốt qua popup cập nhật hoặc tạo lịch đầu tiên.

Migration `20261106150000_outgoing_receipt_history.sql` thêm lịch sử xuất
trong **Receipt → Xuất kho**. Kết quả lọc theo ngày xuất thực tế và gộp theo
ngày xuất / item; chi tiết dựa trên phiếu và lô thực xuất. **Review** hiển thị
các ngày giao của yêu cầu được chọn. Nhập kho thủ công mới bắt buộc có ngày
sản xuất; dữ liệu đã ghi và retry hợp lệ không đổi.

Migration `20261118130000_parent_outgoing_receipt_layout.sql` chỉ cập nhật
truy vấn đọc cho bố cục **Receipt → Xuất kho**. Mã thường tiếp tục gộp theo
ngày xuất / item. Với mã mẹ, mỗi yêu cầu có dòng thông tin riêng (mã mẹ,
PO/Sales ID hoặc mã nhập tay, ngày giao, số yêu cầu); bảng con ngay bên dưới
hiển thị tên, khách hàng, số thực xuất và người xuất của từng mã con.
Icon mắt mở popup rộng với cùng bố cục mẹ–con và các lần xuất/lô thực tế.
Các lần xuất được phân trang 50 dòng. Dữ liệu lấy từ yêu cầu và lịch sử đã
lưu, không quy đổi số xuất mã mẹ, không tra bộ active và không thay đổi FIFO,
quy trình xác nhận, số liệu tồn hoặc dữ liệu xuất kho.

API/RPC kho yêu cầu tài khoản hoạt động có `view-WH`; API/RPC lịch sử Receipt
giữ `receipt.view`. `list_stock_summary`,
`list_delivery` trả 100 dòng/trang; `preview_delivery_fifo` trả gợi ý không ghi.
Chi tiết lịch sử hiển thị tối đa 500 lần xuất; dữ liệu đầy đủ vẫn lưu trong DB.
Đồng bộ confirm scan đã có phần chuẩn bị, chưa kích hoạt; xem mục bên dưới.

### Chuẩn bị nối confirm scan vào tồn kho — CHƯA BẬT

Trước go-live có bộ [kiểm tra và reset dữ liệu kho thử](supabase/operations/WAREHOUSE_CLEANUP.md):
11 bảng ledger được xử lý cùng transaction, giữ master/production/receipt cũ,
chặn sau kích hoạt hoặc có nguồn scan. Các file chỉ nằm ở `supabase/operations`,
không chạy qua migration và không tự phân biệt test với dữ liệu thật.

Migration `20261119090000_prepare_scan_stock_bridge.sql` chỉ thêm source scan,
unique ID nguồn và các hàm nội bộ/read-only recovery. Nó không gắn trigger,
không sửa RPC confirm và không nhập lại pallet WHdone cũ. App mới vẫn chạy khi
chưa cài preparation; recovery RPC chưa tồn tại thì giữ xử lý cũ.

SQL kích hoạt giữ tại `supabase/activation_pending/activate_scan_stock.sql`,
ngoài thư mục migrations và có acknowledgement chặn chạy nhầm. Chỉ chuyển file
vào migrations bằng timestamp mới khi user yêu cầu bật. Chi tiết preflight,
cutover tồn đầu, rủi ro và test đa session ở
[`supabase/activation_pending/README.md`](supabase/activation_pending/README.md).

Khi bật, statement trigger ghi một dòng inv_incoming cho mỗi pallet mới WHdone,
receipt constraint trigger kiểm tra đủ count/quantity tại COMMIT; lỗi rollback
cả confirm. Summary dùng cơ chế hiện có. Scan không qua Proposal và không yêu
cầu edit-WH. Recovery chỉ đọc trả lại receipt của đúng người/tập pallet sau khi
mất HTTP response, không tự backfill stock cho receipt cũ.

Migration `20261118140000_warehouse_permissions.sql` đăng ký hai quyền kho,
đổi guard API/RPC/RLS (kể cả các hàm private được delegate) và giữ Receipt riêng.
Không tự sao chép quyền từ `receipt.view`. **Admin Warehouse mặc định có cả
`view-WH` và `edit-WH`**, áp dụng cho tài khoản hiện có và tạo mới, đồng bộ ở app,
proxy và RPC database qua migration `20261119130000_warehouse_admin_default_permissions.sql`.
User kho vẫn cần cấp quyền rõ ràng. Admin Warehouse được cấp/thu hồi hai quyền
cho user cùng position, không quản lý admin khác hoặc user bộ phận khác;
Super Admin được cấp cho mọi tài khoản được mapping. Admin Planning/Production
không mặc định có quyền kho; các quyền Super Admin cấp riêng vẫn được giữ.
Chọn `edit-WH` trong Admin tự chọn kèm `view-WH`; bỏ `view-WH` bỏ cả `edit-WH`.

`view-WH` cho manual nhập/xuất, tồn kho và Review. `edit-WH` bổ sung nạp ERP,
xuất hàng loạt, hủy phần chờ, cập nhật item/ghép cặp, sửa/xóa và duyệt nhập kho.
Nạp tồn đầu, master data và file ghép cặp vẫn dành riêng Super Admin.
Xuất kho manual tạo lịch chờ/On order bằng `view-WH`; chỉ supervisor có
`edit-WH` xuất hàng loạt mới trừ tồn, theo FIFO và đồng bộ mã con như trước.

Migration `20261118150000_incoming_supervisor_approval.sql` tạo
`inv_incoming_proposals` (payload gốc và người đề xuất để retry) cùng
`inv_incoming_proposal_lines` (dòng pending/posted/cancelled, version và liên kết
batch/dòng nhập sau duyệt). Không cấp direct DML cho authenticated. Danh sách
chờ duyệt phân trang 100 dòng; checkbox duyệt áp dụng trên trang đang xem.
Duyệt một phần giữ lại các dòng khác. UUID, actor và danh sách ID/version đã
chọn được đối chiếu khi retry, đảm bảo không cộng tồn trùng và không tái tạo
các đề xuất đã sửa/xóa/duyệt. Supervisor được chụp vào người nhập thực tế;
người đề xuất vẫn được giữ riêng trong đề xuất.

`npm run test:delivery` dùng PostgreSQL cục bộ qua PGlite, không kết nối Supabase
thật. Kiểm tra cả chuyển đổi từ dữ liệu đã có, giữ nguyên lịch sử, On order vượt
tồn, FIFO lúc xác nhận, retry, sửa/hủy, trigger cập nhật theo item và quyền truy cập.

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
