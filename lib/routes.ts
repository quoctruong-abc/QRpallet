import type { PermissionKey, Position } from "@/lib/types";

export const POSITION_ROUTES: Record<Position, string[]> = {
  planning: ["/planning-inject", "/warehouse-receipt"],
  production: ["/pallet-label", "/warehouse-receipt"],
  warehouse: ["/scan-qr", "/warehouse-receipt"],
};

export const POSITION_LABELS: Record<Position, string> = {
  planning: "Planning",
  production: "Production",
  warehouse: "Warehouse",
};

export const PAGE_PERMISSIONS: Record<string, PermissionKey[]> = {
  "/planning-inject": ["planning.upload", "planning.change"],
  "/pallet-label": ["pallet.create", "pallet.edit"],
  "/scan-qr": ["scan.standard"],
  "/warehouse-receipt": ["receipt.view"],
};

export const POSITION_PERMISSIONS: Record<Position, PermissionKey[]> = {
  planning: ["planning.upload", "planning.change", "receipt.view"],
  production: ["pallet.create", "pallet.edit", "receipt.view"],
  warehouse: ["scan.standard", "receipt.view"],
};
