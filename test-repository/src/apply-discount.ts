import {
  VOLUME_DISCOUNT_RATE,
  VOLUME_DISCOUNT_THRESHOLD_CENTS,
} from "./discount-policy.js";

export function applyVolumeDiscount(subtotalCents: number): number {
  if (subtotalCents > VOLUME_DISCOUNT_THRESHOLD_CENTS) {
    return Math.round(subtotalCents * (1 - VOLUME_DISCOUNT_RATE));
  }

  return subtotalCents;
}
