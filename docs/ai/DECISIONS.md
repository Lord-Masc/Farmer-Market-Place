# Architecture and Engineering Decisions

Record durable decisions with date, context, choice, alternatives, and consequences. Do not log routine edits.

## 2026-11-11 — Keep payment tracking distinct from escrow/payout
- **Context:** The application integrates Razorpay payment verification and internal order/payment states.
- **Decision:** Documentation and UI must not claim that funds are legally held in escrow or automatically released to farmers unless a verified Razorpay Route/linked-account payout integration exists.
- **Alternatives considered:** Treating internal statuses such as `HELD` / `RELEASED` as proof of actual fund custody or settlement.
- **Consequences:** Describe payment verification and order completion accurately; treat split settlement as a separate integration and compliance project.

## 2026-11-11 — Server is authoritative for payment amount and identity
- **Context:** Checkout and payment APIs handle buyer orders.
- **Decision:** Payment identity and payable amount must be derived and validated server-side from the authenticated user and stored order/product data, not trusted from browser-supplied price or identity fields.
- **Consequences:** Any change to payment creation/verification must preserve ownership, order binding, amount checks, and idempotency.

## New decisions
Add entries below using the same structure. Link the related PR or commit.
