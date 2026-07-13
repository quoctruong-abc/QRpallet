export function LogoutButton() {
  return (
    <form action="/auth/signout" method="post">
      <button className="button button-secondary" type="submit">
        Đăng xuất
      </button>
    </form>
  );
}
