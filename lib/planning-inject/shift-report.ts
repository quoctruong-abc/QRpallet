import type { PlanningRow } from "@/lib/planning";

export type ShiftReportPlanRow = Pick<
  PlanningRow,
  "machine" | "wo" | "customer" | "itemcode" | "product_name" | "netweight" | "quanperh" | "color" | "material" | "quanorder"
> & { id: number };

export type ShiftReportPrintMode = "without-background" | "with-background";
export type ShiftReportSelection = { id: number; machine: string; wo: string };

export const SHIFT_REPORT_FIELDS = "id,machine,wo,customer,itemcode,product_name,netweight,quanperh,color,material,quanorder";
export const MAX_SHIFT_REPORT_PAGES = 500;

export function hasShiftReportWO(row: Pick<ShiftReportPlanRow, "machine" | "wo">) {
  return Boolean(row.machine?.trim() && row.wo?.trim() && row.wo.trim() !== "0");
}

export function isShiftReportDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function todayInVietnam() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((value) => value.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function parseShiftReportSelections(value: unknown): ShiftReportSelection[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_SHIFT_REPORT_PAGES) return null;
  const selections: ShiftReportSelection[] = [];
  const machines = new Set<string>();
  const ids = new Set<number>();
  for (const selection of value) {
    if (!selection || typeof selection !== "object") return null;
    const { id, machine, wo } = selection;
    if (
      typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0
      || typeof machine !== "string" || !machine.trim() || machine.length > 200
      || typeof wo !== "string" || !wo.trim() || wo.trim() === "0" || wo.length > 200
      || machines.has(machine.trim()) || ids.has(id)
    ) return null;
    machines.add(machine.trim());
    ids.add(id);
    selections.push({ id, machine: machine.trim(), wo: wo.trim() });
  }
  return selections;
}
