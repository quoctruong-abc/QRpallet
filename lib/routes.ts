import type { Position } from "@/lib/types";

export const POSITION_ROUTES: Record<Position, string> = {
  planning: "/planning-inject",
  pallet: "/pallet-label",
  scanner: "/scan-qr",
  warehouse: "/warehouse-receipt",
};

export const POSITION_LABELS: Record<Position, string> = {
  planning: "Planning Inject",
  pallet: "Xuất tem pallet",
  scanner: "Scan QR",
  warehouse: "Xử lý data tạm / Nhập kho",
};
