export default function Loading() {
  return (
    <div className="route-loading-page" role="status" aria-live="polite">
      <div className="route-loading-card">
        <span className="route-loading-spinner" aria-hidden="true" />
        <div>
          <strong>Đang tải dữ liệu</strong>
          <p>Vui lòng chờ trong giây lát...</p>
        </div>
      </div>
    </div>
  );
}
