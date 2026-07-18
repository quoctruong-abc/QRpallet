# QRpallet — Project Architecture & Maintenance Map

Tài liệu này là **bộ sườn kỹ thuật và nguồn tham chiếu chính** của dự án QRpallet. Mục đích là giúp người phát triển, AI hỗ trợ và người bảo trì có thể nhanh chóng xác định:

- Module nào đang tồn tại.
- Trang, API và bảng dữ liệu nào liên quan.
- Role, position và permission được xử lý như thế nào.
- API nào cần kiểm tra quyền nào.
- Luồng trạng thái pallet và phiếu nhập kho.
- Vị trí cần chỉnh sửa khi nâng cấp chức năng.

> README này không còn dùng làm tài liệu cài đặt môi trường hoặc deploy. Khi thay đổi kiến trúc, quyền, route, API, bảng dữ liệu hoặc workflow, phải cập nhật README trong cùng commit.

---

## 1. Tổng quan hệ thống

QRpallet là ứng dụng Next.js dùng để quản lý:

1. Planning Inject — nhập và chỉnh sửa kế hoạch sản xuất.
2. Pallet Label — tạo, sửa, xóa, gộp và in tem pallet.
3. Scan QR — quét pallet từ Production sang Warehouse.
4. Warehouse Receipt — xử lý nhập kho và tạo phiếu nhập.
5. Admin — quản lý tài khoản, role, position và permission.

### Công nghệ chính

- Frontend/Backend: Next.js App Router.
- Authentication: Supabase Auth.
- Database: Supabase PostgreSQL.
- Authorization: server-side RBAC kết hợp role, position và permission.
- Deploy: Vercel.

---

## 2. Cấu trúc thư mục quan trọng

```text
app/
├── admin/                     # Quản lý tài khoản và phân quyền
├── api/                       # Route handlers phía server
│   ├── planning-inject/       # Import và chỉnh sửa planning
│   ├── pallet-label/          # Tạo, tìm, sửa, xóa và xuất PDF pallet
│   ├── scan-qr/               # Scan, xác nhận và hủy pallet
│   └── warehouse-receipt/     # Tạo, in lại và hủy phiếu nhập kho
├── dashboard/                 # Điều hướng sau đăng nhập
├── login/                     # Đăng nhập
├── planning-inject/           # Module 01
├── pallet-label/              # Module 02
├── scan-qr/                   # Module 03
└── warehouse-receipt/         # Module 04

components/
├── page-shell.tsx             # Header dùng chung và module navigation
└── change-password-dialog.tsx # Popup đổi mật khẩu dùng chung

lib/
├── auth.ts                    # Nguồn logic authorization chính
├── routes.ts                  # Map position, route và permission
├── types.ts                   # Role, position, permission và profile types
├── planning.ts                # Type và helper liên quan planning
└── supabase/
    ├── server.ts              # Supabase client theo phiên đăng nhập
    └── admin.ts               # Service-role client chỉ dùng phía server

supabase/
└── *.sql                      # Schema, function, trigger, RLS và migration
```

### File cần đọc đầu tiên khi sửa hệ thống

1. `lib/types.ts`
2. `lib/routes.ts`
3. `lib/auth.ts`
4. Trang module liên quan trong `app/`
5. API liên quan trong `app/api/`
6. Migration SQL liên quan trong `supabase/`

---

## 3. Mô hình phân quyền

Hệ thống sử dụng ba tầng:

```text
Role → Position → Permission
```

### 3.1 Role

| Role | Ý nghĩa | Quyền tổng quát |
|---|---|---|
| `superadmin` | Quản trị cao nhất | Toàn quyền, bỏ qua kiểm tra permission |
| `admin` | Quản trị theo bộ phận | Có toàn bộ permission thuộc position của mình |
| `user` | Người sử dụng | Chỉ có permission được gán trực tiếp |

### 3.2 Position

| Position | Module chính |
|---|---|
| `planning` | Planning Inject |
| `production` | Pallet Label và Warehouse Receipt |
| `warehouse` | Scan QR |

Giá trị cũ được chuẩn hóa trong `lib/auth.ts`:

- `pallet` → `production`
- `scanner` → `warehouse`

Không thêm position mới chỉ ở giao diện. Khi thêm position phải cập nhật tối thiểu:

- `lib/types.ts`
- `lib/routes.ts`
- Admin UI
- SQL constraint hoặc enum liên quan
- README này

### 3.3 Permission hiện tại

| Permission | Chức năng |
|---|---|
| `planning.upload` | Import/replace kế hoạch Excel |
| `planning.change` | Chỉnh sửa planning, hiện tại gồm đổi máy |
| `pallet.create` | Truy cập module pallet, tạo tem, tìm và in lại |
| `pallet.edit` | Sửa/xóa pallet hợp lệ |
| `scan.standard` | Scan, xác nhận và hủy scan |
| `receipt.create` | Tạo phiếu nhập kho |
| `receipt.edit` | Hủy/chỉnh nghiệp vụ phiếu nhập kho |

Permission type được khai báo tại `lib/types.ts`. Khi thêm permission mới phải cập nhật đồng thời:

1. `PermissionKey` trong `lib/types.ts`.
2. `PAGE_PERMISSIONS` và/hoặc `POSITION_PERMISSIONS` trong `lib/routes.ts`.
3. Admin permission matrix.
4. Page guard và API guard.
5. README permission map.

---

## 4. Logic authorization chuẩn

Nguồn logic chính: `lib/auth.ts`.

### 4.1 Nạp profile

`getCurrentProfile()` thực hiện:

1. Lấy user ID từ Supabase Auth claims.
2. Đọc profile từ bảng `profiles`.
3. Đọc permission trực tiếp từ `user_permissions`.
4. Gắn danh sách permission vào `profile.permissions`.

### 4.2 Quy tắc `hasPermission`

```text
superadmin → luôn true
admin      → true nếu permission thuộc POSITION_PERMISSIONS[position]
user       → true nếu permission có trong profile.permissions
```

Không kiểm tra permission bằng cách tự so sánh role trong từng component/API. Luôn dùng helper trong `lib/auth.ts` để tránh lệch logic.

### 4.3 Guard cho page

| Helper | Mục đích |
|---|---|
| `requireProfile()` | Bắt buộc đăng nhập và tài khoản hoạt động |
| `requireRole()` | Bắt buộc role phù hợp |
| `requireAdmin()` | Chỉ `superadmin` hoặc `admin` |
| `requirePosition()` | Bắt buộc đúng position; superadmin được phép |
| `requirePermission()` | Bắt buộc có permission cụ thể |

Page guard dùng `redirect()` và chỉ phù hợp cho Server Component hoặc server flow.

### 4.4 Guard cho API

Mọi API thay đổi dữ liệu phải gọi:

```ts
const authorization = await authorizePermission("permission.key");

if (!authorization.ok) {
  return NextResponse.json(
    { error: authorization.error },
    { status: authorization.status },
  );
}
```

`authorizePermission()` xử lý:

- Chưa đăng nhập → HTTP `401`.
- Tài khoản bị khóa → HTTP `403`.
- Không có quyền → HTTP `403`.
- Hợp lệ → trả về profile đã xác thực.

### 4.5 Supabase client theo phiên và admin client

Có hai loại client:

| Client | Dùng khi nào |
|---|---|
| `createClient()` | Đọc/ghi theo quyền RLS của user đăng nhập |
| `createAdminClient()` | Ghi server-side sau khi API đã kiểm tra authorization |

Quy tắc bắt buộc khi dùng `createAdminClient()`:

1. Chỉ dùng trong server code/API/Server Action.
2. Phải gọi `authorizePermission()` hoặc `requireAdmin()` trước.
3. Không import vào Client Component.
4. Không trả service role key ra browser.
5. Không dùng admin client để thay thế authorization của ứng dụng.

Ví dụ API đổi máy Planning:

```text
POST request
→ authorizePermission("planning.change")
→ validate id + machine
→ createAdminClient()
→ UPDATE planning_inject
→ return result
```

Lý do dùng admin client ở bước cuối: RLS có thể chặn `UPDATE` dù role của ứng dụng hợp lệ. Authorization ứng dụng vẫn được kiểm tra trước khi bypass RLS.

---

## 5. Position, route và permission map

Nguồn cấu hình: `lib/routes.ts`.

### 5.1 Route theo position

| Position | Route |
|---|---|
| `planning` | `/planning-inject` |
| `production` | `/pallet-label`, `/warehouse-receipt` |
| `warehouse` | `/scan-qr` |

`superadmin` có thể truy cập mọi route.

### 5.2 Permission theo position

| Position | Permission mặc định cho admin |
|---|---|
| `planning` | `planning.upload`, `planning.change` |
| `production` | `pallet.create`, `pallet.edit`, `receipt.create`, `receipt.edit` |
| `warehouse` | `scan.standard` |

Admin không cần record riêng trong `user_permissions`; permission của admin được suy ra từ position.

### 5.3 Header navigation

`components/page-shell.tsx` hiển thị module icon theo `hasPermission()`:

| Module | Route | Permission dùng để hiện icon |
|---|---|---|
| Planning Inject | `/planning-inject` | `planning.upload` |
| Pallet Label | `/pallet-label` | `pallet.create` |
| Scan QR | `/scan-qr` | `scan.standard` |
| Warehouse Receipt | `/warehouse-receipt` | `receipt.create` |

Lưu ý: icon chỉ là UI convenience. Page và API vẫn phải tự kiểm tra quyền server-side.

---

## 6. Module map

## 6.1 Module 01 — Planning Inject

### Page

```text
app/planning-inject/page.tsx
```

### Permission UI

| Thành phần | Permission |
|---|---|
| Khu vực `IMPORT EXCEL` | `planning.upload` |
| Cột/nút `Đổi máy` | `planning.change` |

### Chức năng

- Import Excel và replace kế hoạch hiện tại.
- Hiển thị preview planning.
- Danh sách máy lấy từ các giá trị `machine` hiện có.
- Đổi trường `machine` của từng dòng qua popup.

### API map

| API | Method | Permission | Ghi chú |
|---|---|---|---|
| `/api/planning-inject/import` | POST | `planning.upload` | Replace/import dữ liệu kế hoạch |
| `/api/planning-inject/change-machine` | POST | `planning.change` | Dùng admin client sau authorization |

### Database

Bảng chính: `planning_inject`.

Các field nghiệp vụ chính:

```text
id
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
source_file
imported_at
```

---

## 6.2 Module 02 — Pallet Label

### Page

```text
app/pallet-label/page.tsx
```

### Permission UI

| Chức năng | Permission |
|---|---|
| Truy cập/tìm pallet/tạo tem/in lại | `pallet.create` |
| Sửa và xóa pallet | `pallet.edit` |

### Quy tắc nghiệp vụ

- Chỉ lấy kế hoạch có WO khác `0` và không trống.
- Pallet mới có trạng thái `production`.
- Sửa/xóa chỉ khả dụng với pallet còn hiệu lực và trạng thái phù hợp.
- Edit không ghi đè lịch sử một cách mù quáng; dùng `effect_to` và `note` để lưu dấu vết theo logic hiện tại.

### API nhóm

```text
app/api/pallet-label/
```

Nhóm chức năng cần được kiểm tra khi nâng cấp:

- Create pallet.
- Search/list pallet.
- Edit pallet.
- Delete pallet.
- Reprint/PDF.
- Merge WO.

### Database

- `planning_inject`
- `item_qty_per_pallet`
- `pallet_data`

Field quan trọng của `pallet_data`:

```text
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
```

---

## 6.3 Module 03 — Scan QR

### Page

```text
app/scan-qr/page.tsx
```

### Permission

```text
scan.standard
```

### Workflow

```text
production
→ pendingWH
→ processingWH
```

Hủy scan hợp lệ sẽ đưa pallet về:

```text
production
```

### API nhóm

```text
app/api/scan-qr/
```

Các action chính:

- Scan pallet.
- Kiểm tra trùng/trạng thái.
- Xác nhận danh sách scan.
- Hủy từng pallet.

### Database

- `pallet_data`
- `temp_scan` nếu flow hiện tại còn sử dụng bảng tạm

---

## 6.4 Module 04 — Warehouse Receipt

### Page

```text
app/warehouse-receipt/page.tsx
```

### Permission

| Chức năng | Permission |
|---|---|
| Tạo phiếu nhập kho | `receipt.create` |
| Hủy/chỉnh nghiệp vụ phiếu | `receipt.edit` |

### Workflow

```text
processingWH
→ WHdone
```

Khi tạo phiếu:

1. Tạo record `wh_receipt`.
2. Gắn `wh_receipt` vào pallet.
3. Chuyển pallet sang `WHdone`.

Khi hủy phiếu, logic phải phục hồi trạng thái pallet theo quy tắc nghiệp vụ đang áp dụng và không để record mồ côi.

### API nhóm

```text
app/api/warehouse-receipt/
```

Các action chính:

- Lấy pallet `processingWH`.
- Preview tổng hợp.
- Tạo phiếu.
- Xuất PDF.
- Tìm/in lại phiếu.
- Hủy phiếu.

### Database

- `pallet_data`
- `wh_receipt`

Field chính của `wh_receipt`:

```text
receipt_id
date
total_pallet
total_quantity
uid_user
```

---

## 6.5 Admin — Account & Permission Management

### Page

```text
app/admin/page.tsx
```

### Role rules

#### Superadmin

- Xem toàn bộ tài khoản.
- Tạo tài khoản với role và position tùy chọn.
- Chỉnh role, position, trạng thái và permission.
- Quản lý page/position mapping nếu tính năng này đang bật.

#### Admin

- Chỉ quản lý tài khoản thuộc position của mình.
- Chỉ tạo role `user` cho position của mình.
- Không cấp role admin/superadmin.
- Chỉ chỉnh permission thuộc position của mình.

#### User

- Không có quyền mặc định.
- Permission phải được cấp rõ ràng trong `user_permissions`.

### Database

- `profiles`
- `user_permissions`
- `position_page_access` nếu chức năng position/page mapping đang được dùng

---

## 7. Workflow trạng thái pallet

Nguồn trạng thái nghiệp vụ thống nhất:

```text
production
   │
   ├── Scan hợp lệ
   ▼
pendingWH
   │
   ├── Warehouse xác nhận danh sách scan
   ▼
processingWH
   │
   ├── Tạo phiếu nhập kho
   ▼
WHdone
```

Luồng hoàn tác:

```text
pendingWH    → production
processingWH → production hoặc trạng thái được quy định bởi action hủy
WHdone       → chỉ thay đổi qua nghiệp vụ hủy phiếu có kiểm soát
```

Không cập nhật trạng thái trực tiếp từ Client Component. Mọi chuyển trạng thái phải đi qua API có:

1. Authentication.
2. Permission check.
3. Validation trạng thái hiện tại.
4. Update database.
5. Response rõ ràng.

---

## 8. Database ownership map

| Bảng | Module sở hữu chính | Module đọc phụ |
|---|---|---|
| `profiles` | Admin/Auth | Tất cả module để xác định user |
| `user_permissions` | Admin/Auth | `lib/auth.ts` |
| `position_page_access` | Admin/Auth | Navigation/access mapping nếu bật |
| `planning_inject` | Planning | Pallet Label |
| `item_qty_per_pallet` | Pallet Label | — |
| `pallet_data` | Pallet Label | Scan QR, Warehouse Receipt |
| `temp_scan` | Scan QR | Warehouse Receipt nếu flow dùng bảng tạm |
| `wh_receipt` | Warehouse Receipt | Reprint/history |

Khi đổi schema:

- Tạo migration SQL mới, không sửa migration đã chạy trên production nếu có thể tránh.
- Cập nhật type TypeScript tương ứng.
- Cập nhật select/insert/update API.
- Cập nhật README database map.

---

## 9. API authorization map

Bảng này là checklist bắt buộc khi review API.

| Nhóm API/action | Permission tối thiểu |
|---|---|
| Import planning | `planning.upload` |
| Đổi máy planning | `planning.change` |
| Tạo/gộp/in lại/tìm pallet | `pallet.create` |
| Sửa/xóa pallet | `pallet.edit` |
| Scan/xác nhận/hủy scan | `scan.standard` |
| Tạo phiếu/PDF/tìm phiếu | `receipt.create` |
| Hủy/chỉnh phiếu | `receipt.edit` |
| Tạo user/quản lý user | `superadmin` hoặc `admin`, kèm giới hạn position |

### Quy tắc review API

Mỗi API ghi dữ liệu phải trả lời được các câu hỏi:

1. API yêu cầu permission nào?
2. Permission có được kiểm tra ở server không?
3. Superadmin/admin/user có đi qua cùng helper không?
4. Payload có được validate không?
5. Record hiện tại có được kiểm tra trạng thái trước update không?
6. Dùng user client hay admin client?
7. Nếu dùng admin client, authorization đã xảy ra trước chưa?
8. Có tránh ghi đè lịch sử không?
9. Error status có đúng `400/401/403/404/409/500` không?

---

## 10. Quy tắc phát triển và bảo trì

### Khi thêm chức năng mới

1. Xác định module sở hữu.
2. Xác định permission mới hay dùng permission hiện có.
3. Thêm page/API guard server-side.
4. Chỉ sau đó mới ẩn/hiện UI theo quyền.
5. Xác định bảng dữ liệu và trạng thái bị ảnh hưởng.
6. Viết migration nếu đổi schema.
7. Cập nhật README map.

### Khi sửa giao diện

- Không xem việc ẩn button là bảo mật.
- API phải tiếp tục chặn người không có quyền.
- Table rộng phải cuộn trong container, không kéo lệch toàn bộ page.
- Popup dùng portal nếu nằm trong header hoặc ancestor có stacking context.

### Khi sửa quyền

Không thêm điều kiện rời rạc như:

```ts
profile.role === "superadmin" || profile.role === "admin"
```

trong nhiều file nếu mục tiêu thực tế là permission. Ưu tiên:

```ts
hasPermission(profile, "permission.key")
```

hoặc:

```ts
await authorizePermission("permission.key")
```

### Khi dùng service role

- Chỉ dùng trong server.
- Luôn authorize trước.
- Không log key.
- Không đưa admin client xuống browser.

---

## 11. Branch và release flow

Luồng hiện tại:

```text
dev → demo → main
```

| Branch | Mục đích |
|---|---|
| `dev` | Phát triển và cập nhật code |
| `demo` | Vercel Preview để review |
| `main` | Vercel Production |

Quy trình:

1. Thực hiện thay đổi trên `dev`.
2. Merge `dev` vào `demo`.
3. Review trên Vercel Preview.
4. Khi đạt yêu cầu, merge `demo` vào `main`.
5. Kiểm tra Production deployment.

---

## 12. Checklist trước khi merge production

### Authorization

- [ ] Page guard đúng.
- [ ] API guard đúng.
- [ ] Superadmin hoạt động.
- [ ] Admin chỉ thao tác trong position của mình.
- [ ] User chỉ thao tác permission được cấp.
- [ ] Tài khoản khóa bị chặn.

### Data

- [ ] Không phá workflow trạng thái pallet.
- [ ] Không tạo duplicate pallet/receipt ngoài ý muốn.
- [ ] API validate payload.
- [ ] Hủy nghiệp vụ phục hồi trạng thái đúng.
- [ ] PDF/reprint lấy đúng record.

### UI

- [ ] Header hiện đúng module theo quyền.
- [ ] Button chỉ hiện theo permission.
- [ ] Table không kéo lệch layout.
- [ ] Popup hoạt động trên desktop/mobile.
- [ ] Error hiển thị đủ rõ.

### Documentation

- [ ] README đã cập nhật route/API/permission/schema mới.
- [ ] Migration SQL đã được thêm nếu cần.
- [ ] Không còn tài liệu mô tả logic cũ.

---

## 13. Quy tắc giữ README luôn đúng

README phải được cập nhật trong cùng commit khi có một trong các thay đổi sau:

- Thêm/xóa/đổi tên role.
- Thêm/xóa/đổi tên position.
- Thêm/xóa permission.
- Thay đổi module route.
- Thêm API ghi dữ liệu.
- Thay đổi authorization helper.
- Thêm bảng hoặc field nghiệp vụ quan trọng.
- Thay đổi workflow trạng thái.
- Thay đổi branch/release flow.

Nếu code và README mâu thuẫn, cần đọc các file theo thứ tự:

```text
lib/types.ts
→ lib/routes.ts
→ lib/auth.ts
→ app/<module>/page.tsx
→ app/api/<module>/...
→ supabase/*.sql
```

Sau khi xác nhận code thực tế, cập nhật README để khôi phục README thành nguồn map chính của dự án.
