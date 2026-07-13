export type AppRole = "admin" | "user";
export type Position = "planning" | "pallet" | "scanner" | "warehouse";

export type Profile = {
  id: string;
  email: string;
  full_name: string;
  employee_code: string | null;
  role: AppRole;
  position: Position | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};
