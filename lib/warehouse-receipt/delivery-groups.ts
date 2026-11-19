import type { BulkDeliveryPreview, DeliveryFifoReview } from "./outgoing";

export type PickAmounts = Record<string, number>;
export type GroupPicks = Map<string, PickAmounts>;
export type DeliveryGroup = DeliveryFifoReview["rows"][number];
export const componentPickKey = (group: DeliveryGroup, itemcode: string) => JSON.stringify([group.group_key, itemcode]);

export function suggestDeliveryGroups(data: BulkDeliveryPreview, included: Set<string>): GroupPicks {
  const available = new Map(Object.values(data.lots).flat().map((lot) => [lot.incoming_id, lot.balance_qty]));
  const picks: GroupPicks = new Map();
  for (const group of data.rows) {
    if (!included.has(group.group_key)) continue;
    for (const component of group.components) {
      let remaining = component.quantity;
      const amounts: PickAmounts = {};
      for (const lot of Object.hasOwn(data.lots, component.itemcode) ? data.lots[component.itemcode] : []) {
        const amount = Math.min(available.get(lot.incoming_id) ?? 0, remaining);
        if (amount > 0) amounts[lot.incoming_id] = amount;
        available.set(lot.incoming_id, (available.get(lot.incoming_id) ?? 0) - amount);
        remaining -= amount;
        if (!remaining) break;
      }
      picks.set(componentPickKey(group, component.itemcode), amounts);
    }
  }
  return picks;
}

export function analyzeDeliveryGroups(data: BulkDeliveryPreview, picks: GroupPicks, included: Set<string>) {
  const demand = new Map<string, number>();
  const used = new Map<string, number>();
  for (const group of data.rows) {
    if (!included.has(group.group_key)) continue;
    for (const component of group.components) {
      demand.set(component.itemcode, (demand.get(component.itemcode) ?? 0) + component.quantity);
      for (const [lot, quantity] of Object.entries(picks.get(componentPickKey(group, component.itemcode)) ?? {})) {
        used.set(lot, (used.get(lot) ?? 0) + quantity);
      }
    }
  }
  const overdrawn = Object.values(data.lots).flat().some((lot) => (used.get(lot.incoming_id) ?? 0) > lot.balance_qty);
  const groups = new Map(data.rows.map((group) => {
    const quantities = group.components.map((component) => Object.values(picks.get(componentPickKey(group, component.itemcode)) ?? {})
      .reduce((sum, amount) => sum + amount, 0) / component.factor);
    const quantity = quantities[0] ?? 0;
    const mismatch = group.request_type === "parent"
      ? group.sync_error || !quantities.length || quantities.some((amount) => !Number.isSafeInteger(amount) || amount <= 0 || amount !== quantity)
      : !Number.isSafeInteger(quantity) || quantity < 0;
    const short = group.components.some((component) => (demand.get(component.itemcode) ?? 0) > component.item_stock_qty);
    return [group.group_key, { quantity, mismatch, short }];
  }));
  const selected = data.rows.filter((group) => included.has(group.group_key));
  return { groups, overdrawn, canProceed: selected.some((group) => (groups.get(group.group_key)?.quantity ?? 0) > 0) && !overdrawn && selected.every((group) => {
    const state = groups.get(group.group_key)!;
    return !state.mismatch && !state.short;
  }) };
}
