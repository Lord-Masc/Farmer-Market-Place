-- Stage 0 (2026-11-12): backfill delivery deadlines for legacy orders (M4).
-- The deadline is normally set when the payment is marked PAID
-- (payment time + 48h). Legacy PAID/SHIPPED rows never got one.
-- Only rows WITH a payments row are backfilled, to created_at + 48h (the
-- platform's original rule; created_at approximates the payment time for
-- these rows, so the deadline may be up to a few hours early — acceptable
-- for legacy data). A backfilled deadline already past makes the order
-- refund-eligible through the normal past-deadline path, which is the
-- point: a paid order nobody fulfilled should be refunded.
-- Rows WITHOUT a payments row keep NULL and are now protected from
-- auto-refund by the age + payments-row guard in
-- escrowService.autoRefundJob. Those rows need the Razorpay backfill (R3)
-- — a human/dashboard task, not this migration.
UPDATE public.orders o
  SET delivery_deadline = o.created_at + interval '48 hours'
  WHERE o.delivery_deadline IS NULL
    AND o.status IN ('PAID', 'SHIPPED')
    AND EXISTS (SELECT 1 FROM public.payments p WHERE p.order_id = o.id);
