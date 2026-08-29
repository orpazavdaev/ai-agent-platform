# Mini Checkout

Small TypeScript sample used as a stand-in customer repository for CodePilot Agent.

## What it does

`mini-checkout` prices a shopping cart:

1. Sum line items into a subtotal (integer cents).
2. Apply a volume discount when the subtotal qualifies.
3. Apply 8% sales tax to the discounted subtotal.

## Business rules

- Money is stored as integer cents.
- Carts with a subtotal of **$100.00 or more** (`10000` cents) receive a **15%** volume discount.
- Tax is `8%`, applied after the discount, rounded to the nearest cent.

## Layout

```
src/
  types.ts             Cart item type
  cart.ts              Subtotal helper
  discount-policy.ts   Threshold and qualification rule
  apply-discount.ts    Discount application
  tax.ts               Sales tax
  checkout.ts          End-to-end checkout
  index.ts             Public exports
tests/
  checkout.test.ts
```

## Commands

```bash
npm install
npm test
npm run typecheck
```

Requires Node.js 20+.
