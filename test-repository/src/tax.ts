export const TAX_RATE = 0.08;

export function applyTax(amountCents: number): number {
  return Math.round(amountCents * (1 + TAX_RATE));
}
