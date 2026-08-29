export const VOLUME_DISCOUNT_THRESHOLD_CENTS = 10_000;

export const VOLUME_DISCOUNT_RATE = 0.15;

export function qualifiesForVolumeDiscount(subtotalCents: number): boolean {
  return subtotalCents >= VOLUME_DISCOUNT_THRESHOLD_CENTS;
}
