import { applyVolumeDiscount } from "./apply-discount.js";
import { cartSubtotalCents } from "./cart.js";
import { applyTax } from "./tax.js";
import type { CartItem } from "./types.js";

export type CheckoutResult = {
  subtotalCents: number;
  discountedSubtotalCents: number;
  totalCents: number;
};

export function checkout(items: CartItem[]): CheckoutResult {
  const subtotalCents = cartSubtotalCents(items);
  const discountedSubtotalCents = applyVolumeDiscount(subtotalCents);
  const totalCents = applyTax(discountedSubtotalCents);

  return {
    subtotalCents,
    discountedSubtotalCents,
    totalCents,
  };
}
