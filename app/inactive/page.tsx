export default function InactivePage() {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>Không thể truy cập</h1>
        <p className="muted">
          Tài khoản đang bị khóa hoặc chưa được gán position. Vui lòng liên hệ admin.
        </p>
        <form action="/auth/signout" method="post">
          <button className="button button-primary full-width" type="submit">
            Quay lại đăng nhập
          </button>
        </form>
      </section>
    </main>
  );
}
