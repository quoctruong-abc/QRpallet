import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="logo-mark">SVN</div>
        <h1>Đăng nhập hệ thống</h1>
        <p className="muted auth-intro">
          Quản lý kế hoạch, tem pallet, quét QR và nhập kho.
        </p>
        <LoginForm />
      </section>
    </main>
  );
}
