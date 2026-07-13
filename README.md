# SVN Auth + Admin Starter

Starter project cho cấu trúc:

- `/login`: trang mở đầu.
- Admin đăng nhập → `/admin`.
- User thường được chuyển theo `position`:
  - `planning` → `/planning-inject`
  - `pallet` → `/pallet-label`
  - `scanner` → `/scan-qr`
  - `warehouse` → `/warehouse-receipt`
- Admin truy cập được cả 4 module, tạo tài khoản và khóa/mở khóa user.

## 1. Tạo Supabase database

1. Mở Supabase project.
2. Vào **SQL Editor**.
3. Chạy toàn bộ file `supabase/001_auth_profiles.sql`.
4. Vào **Authentication > Users > Add user** để tạo tài khoản admin đầu tiên.
5. Chạy câu lệnh sau trong SQL Editor, thay email thật:

```sql
UPDATE public.profiles
SET role = 'admin', position = NULL, is_active = true
WHERE email = 'admin@your-company.com';
```

## 2. Cấu hình môi trường

Copy `.env.example` thành `.env.local`:

```bash
cp .env.example .env.local
```

Điền 3 biến:

```env
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
```

Lấy key tại **Supabase > Project Settings / Connect / API Keys**.

`SUPABASE_SERVICE_ROLE_KEY` chỉ dùng server để admin tạo tài khoản. Tuyệt đối không đặt tên biến này với tiền tố `NEXT_PUBLIC_` và không đưa vào code phía trình duyệt.

## 3. Chạy trên Codespaces/VSC

```bash
npm install
npm run dev
```

Mở `http://localhost:3000`.

## 4. Deploy Vercel

1. Push project lên GitHub.
2. Import repository trong Vercel.
3. Framework Preset: **Next.js**.
4. Thêm đủ 3 Environment Variables giống `.env.local`.
5. Deploy.

## 5. Nơi gắn 4 giao diện hiện có

- `app/planning-inject/page.tsx`
- `app/pallet-label/page.tsx`
- `app/scan-qr/page.tsx`
- `app/warehouse-receipt/page.tsx`

Mỗi trang đã có kiểm tra quyền server-side. User nhập URL trực tiếp nhưng sai `position` sẽ bị chuyển về page đúng quyền.

## Bảo mật đã thiết lập

- Supabase Auth quản lý mật khẩu; mật khẩu không lưu trong bảng `profiles`.
- `profiles` bật Row Level Security.
- User chỉ đọc được profile của chính mình.
- Route admin kiểm tra role ở server.
- Tạo/khóa user dùng Service Role ở Server Action và luôn kiểm tra admin trước.
- Trigger tạo profile không tin `role` từ metadata, tránh tự nâng quyền.
- Next.js `proxy.ts` làm mới session cookie và chặn truy cập khi chưa đăng nhập.
