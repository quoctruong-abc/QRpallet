import type { SupabaseClient } from "@supabase/supabase-js";

export function palletQuantity(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const quantity = Number(value);
  return Number.isInteger(quantity) && quantity > 0 && quantity <= 2147483647 ? quantity : null;
}

// The catalog can exceed PostgREST's row cap. Fetch only the current plan's
// exact keys in small batches; the itemcode PK limits each response to 100 rows.
export async function loadPalletQuantities(client: Pick<SupabaseClient, "from">, itemcodes: string[]) {
  const codes = [...new Set(itemcodes.map(code => code.trim()).filter(Boolean))];
  const batches = Array.from({ length: Math.ceil(codes.length / 100) }, (_, i) => codes.slice(i * 100, i * 100 + 100));
  const results = await Promise.all(batches.map(batch => client.from("item_pallet_config")
    .select("itemcode,quantity_per_pallet").in("itemcode", batch)));
  const quantities = new Map<string, number | null>();
  const error = results.find(result => result.error)?.error ?? null;
  if (!error) for (const result of results) for (const row of result.data ?? []) {
    quantities.set(String(row.itemcode).trim(), palletQuantity(row.quantity_per_pallet));
  }
  return { quantities, error };
}
