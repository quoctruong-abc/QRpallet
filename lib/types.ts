export type AppRole = "superadmin" | "admin" | "user";
export type Position = "planning" | "production" | "warehouse";

export type PermissionKey =
  | "planning.upload"
  | "planning.change"
  | "pallet.create"
  | "pallet.edit"
  | "scan.standard"
  | "receipt.create"
  | "receipt.edit";

export type Profile = {
  id: string;
  email: string;
  full_name: string;
  employee_code: string | null;
  role: AppRole;
  position: Position | null;
  permissions?: PermissionKey[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type PositionPageMapping = {
  position: Position;
  path: string;
  is_enabled: boolean;
};
