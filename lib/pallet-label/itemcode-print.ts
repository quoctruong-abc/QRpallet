export type ItemcodeWorkOrder = {
  wo: string;
  itemcode: string;
  product_name: string;
  customer: string;
  machine: string;
  quanorder: number | null;
  produced_quantity: number;
  warehouse_quantity: number;
  pallet_count: number;
  last_created_at: string;
};

export type ItemcodeCatalog = {
  itemcode: string;
  product_name: string;
  customer: string;
  quantity_per_pallet: number | null;
};

export function itemcodeCatalog(row: {
  itemcode: string; product_name: string | null; ERP_name: string | null;
  customer: string | null; quantity_per_pallet: number | null;
}): ItemcodeCatalog {
  return {
    itemcode: row.itemcode,
    product_name: row.product_name?.trim() || row.ERP_name?.trim() || "",
    customer: row.customer?.trim() || "",
    quantity_per_pallet: row.quantity_per_pallet,
  };
}
