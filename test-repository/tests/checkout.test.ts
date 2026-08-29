import { describe, expect, it } from "vitest";
import { applyVolumeDiscount } from "../src/apply-discount.js";
import { checkout } from "../src/checkout.js";
import {
  qualifiesForVolumeDiscount,
  VOLUME_DISCOUNT_RATE,
  VOLUME_DISCOUNT_THRESHOLD_CENTS,
} from "../src/discount-policy.js";
import type { CartItem } from "../src/types.js";

describe("discount policy", () => {
  it("treats the threshold as inclusive", () => {
    expect(qualifiesForVolumeDiscount(VOLUME_DISCOUNT_THRESHOLD_CENTS)).toBe(
      true,
    );
    expect(
      qualifiesForVolumeDiscount(VOLUME_DISCOUNT_THRESHOLD_CENTS - 1),
    ).toBe(false);
  });
});

describe("applyVolumeDiscount", () => {
  it("leaves subtotals below the threshold unchanged", () => {
    expect(applyVolumeDiscount(9_999)).toBe(9_999);
  });

  it("applies 15% off when subtotal is above the threshold", () => {
    const subtotal = 12_000;
    expect(applyVolumeDiscount(subtotal)).toBe(
      Math.round(subtotal * (1 - VOLUME_DISCOUNT_RATE)),
    );
  });

  it("applies 15% off when subtotal equals the threshold", () => {
    const subtotal = VOLUME_DISCOUNT_THRESHOLD_CENTS;
    expect(applyVolumeDiscount(subtotal)).toBe(
      Math.round(subtotal * (1 - VOLUME_DISCOUNT_RATE)),
    );
  });
});

describe("checkout", () => {
  it("charges tax on the discounted subtotal for a qualifying cart", () => {
    const items: CartItem[] = [
      { sku: "mug", unitPriceCents: 2_500, quantity: 4 },
      { sku: "tea", unitPriceCents: 2_000, quantity: 1 },
    ];

    const result = checkout(items);

    expect(result.subtotalCents).toBe(12_000);
    expect(result.discountedSubtotalCents).toBe(10_200);
    expect(result.totalCents).toBe(11_016);
  });

  it("does not discount a cart just under the threshold", () => {
    const items: CartItem[] = [
      { sku: "mug", unitPriceCents: 2_500, quantity: 3 },
      { sku: "tea", unitPriceCents: 2_499, quantity: 1 },
    ];

    const result = checkout(items);

    expect(result.subtotalCents).toBe(9_999);
    expect(result.discountedSubtotalCents).toBe(9_999);
    expect(result.totalCents).toBe(10_799);
  });

  it("applies the volume discount when the cart totals exactly $100.00", () => {
    const items: CartItem[] = [
      { sku: "bundle", unitPriceCents: 5_000, quantity: 2 },
    ];

    const result = checkout(items);

    expect(result.subtotalCents).toBe(10_000);
    expect(result.discountedSubtotalCents).toBe(8_500);
    expect(result.totalCents).toBe(9_180);
  });
});
