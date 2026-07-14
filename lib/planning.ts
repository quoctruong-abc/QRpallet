export type PlanningRow = {
  id?: number;
  machine: string | null;
  itemcode: string | null;
  product_name: string | null;
  customer: string | null;
  wo: string | null;
  netweight: number | null;
  quanperh: number | null;
  quanperday: number | null;
  color: string | null;
  material: string | null;
  package: string | null;
  quanorder: number | null;
  source_file?: string | null;
  imported_at?: string | null;
};
