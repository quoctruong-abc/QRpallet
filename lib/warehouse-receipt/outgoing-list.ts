export const WAREHOUSE_PAGE_SIZE = 100;

export function warehouseSearchTokens(input: string) {
  return normalizeSearch(input).split(/\s+/).filter(Boolean);
}

function normalizeSearch(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replaceAll("đ", "d");
}

export function matchesWarehouseSearch(tokens: string[], fields: (string | null | undefined)[]) {
  if (!tokens.length) return true;
  const haystack = normalizeSearch(fields.join(" "));
  return tokens.every((token) => haystack.includes(token));
}

export async function loadWarehouseRows<T>(filters: Record<string, string>, key: (row: T) => string, signal: AbortSignal) {
  async function fetchPage(offset: number) {
    const params = new URLSearchParams({ ...filters, offset: String(offset) });
    const response = await fetch(`/api/warehouse-receipt/outgoing?${params}`, { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || "Không tải được dữ liệu kho.");
    return { rows: data.rows as T[], total: Number(data.total) };
  }

  const first = await fetchPage(0);
  const rows = new Map(first.rows.map((row) => [key(row), row]));
  // Fetch the other pages once per refresh, not once per filter change.
  for (let start = WAREHOUSE_PAGE_SIZE; start < first.total; start += 4 * WAREHOUSE_PAGE_SIZE) {
    const offsets = Array.from({ length: 4 }, (_, index) => start + index * WAREHOUSE_PAGE_SIZE).filter((offset) => offset < first.total);
    const pages = await Promise.all(offsets.map(fetchPage));
    for (const page of pages) for (const row of page.rows) rows.set(key(row), row);
  }
  return [...rows.values()];
}
