export function scanStockError(message: string) {
  if (message.includes("SCAN_STOCK_BUSY")) return { status: 503, error: "Kho đang xử lý giao dịch khác. Lần xác nhận này đã được hoàn tác; vui lòng thử lại." };
  if (message.startsWith("SCAN_STOCK_MISSING_NAME:")) return { status: 409, error: `Item ${message.slice("SCAN_STOCK_MISSING_NAME:".length)} thiếu tên sản phẩm. Cập nhật danh mục rồi xác nhận lại. Chưa có dữ liệu nhập kho được ghi.` };
  if (message.includes("SCAN_STOCK_NOT_AUTHORIZED")) return { status: 403, error: "Phiên đăng nhập hoặc người xác nhận không còn hợp lệ. Tải lại trang trước khi tiếp tục." };
  if (message.includes("SCAN_STOCK_")) return { status: 409, error: "Dữ liệu pallet, phiếu nhập và tồn kho chưa khớp. Lần xác nhận đã được hoàn tác; tải lại và kiểm tra trước khi thử lại." };
  return null;
}
