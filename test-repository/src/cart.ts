import type { CartItem } from "./types.js";

export function cartSubtotalCents(items: CartItem[]): number {
  return items.reduce(
    (sum, item) => sum + item.unitPriceCents * item.quantity,
    0,
  );
}
