import type { WoReceiptPdfRow } from "./wo-receipt-pdf";

const UNKNOWN_WORKING_DAY = "9999-12-31";

export function sortWoReceiptPallets(pallets: WoReceiptPdfRow[]) {
  const woFirstWorkingDay = new Map<string, string | null>();
  for (const pallet of pallets) {
    const current = woFirstWorkingDay.get(pallet.wo);
    if (!woFirstWorkingDay.has(pallet.wo) || (pallet.working_day && (!current || pallet.working_day < current))) {
      woFirstWorkingDay.set(pallet.wo, pallet.working_day);
    }
  }

  return [...pallets].sort((a, b) => (
    (woFirstWorkingDay.get(a.wo) ?? UNKNOWN_WORKING_DAY).localeCompare(
      woFirstWorkingDay.get(b.wo) ?? UNKNOWN_WORKING_DAY,
    )
    || a.wo.localeCompare(b.wo, "vi")
    || (a.working_day ?? UNKNOWN_WORKING_DAY).localeCompare(b.working_day ?? UNKNOWN_WORKING_DAY)
    || new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    || a.pallet_id.localeCompare(b.pallet_id, "vi")
  ));
}
