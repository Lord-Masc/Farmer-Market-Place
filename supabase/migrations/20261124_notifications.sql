-- Stage 9, module H — Notifications & Communication (2026-11-12):
-- notifications + notification_preferences.
--
-- WHAT THIS FILE DOES
--  1. notifications: one row per (user, event, channel). id uuid PK,
--     user_id uuid NOT NULL REFERENCES auth.users (the recipient),
--     type text with a CHECK over the 24 event types (the same strings
--     the backend emits — see backend/services/notificationTemplates.js),
--     title / body text (built ONLY from the event payload, never an
--     invented number), payload jsonb (the event data: order / offer /
--     shipment / dispute ids plus the numbers the template rendered),
--     read_at timestamptz NULL (NULL = unread), channel text CHECK
--     (in_app | email | sms), delivery_status text CHECK
--     (pending | sent | failed | deferred) DEFAULT 'pending',
--     dedupe_key text UNIQUE (event_id:user_id:channel — a retried /
--     replayed transition inserts the same key and is treated as
--     already-emitted, never a second row), attempts int DEFAULT 0,
--     next_attempt_at timestamptz NULL (NULL = due now; the worker
--     sets it on defer / retry backoff), created_at timestamptz.
--     In-app rows are 'sent' as soon as they are created (the inbox
--     IS the delivery); email/sms rows start 'pending' and the worker
--     drives them to 'sent' or, after 3 attempts, 'failed' — never
--     silently dropped, never marked 'sent' without a provider.
--  2. notification_preferences: one row per (user, event type).
--     user_id uuid NOT NULL REFERENCES auth.users, event_type text
--     with the same 24-type CHECK, enabled boolean DEFAULT true
--     (an opted-out type emits NO row for that user), channels text[]
--     DEFAULT '{in_app}' (subset of in_app/email/sms — the CHECK
--     enforces it; DEFAULT is in_app only, email/sms only when the
--     user explicitly enables them), language text CHECK (hi | en)
--     DEFAULT 'hi' (Hindi-first, per the Stage 8 precedent),
--     quiet_start / quiet_end time NULL (no quiet hours by default;
--     emit still creates the row — the worker DEFERS delivery during
--     quiet hours and never attempts inside them),
--     UNIQUE(user_id, event_type). A missing row means the defaults
--     (in_app only, enabled, 'hi', no quiet hours).
--  3. RLS: enabled on both tables. A user reads / updates ONLY their
--     own rows (auth.uid() = user_id) — the inbox and the preference
--     editor are user-scoped; the backend writes via the service role
--     (no INSERT policy — only the backend emits). An admin reads all
--     rows via the Stage 1 is_admin() SECURITY DEFINER helper. No anon
--     access: there is no policy for the anon role at all. Deletes go
--     through the backend (service role) only — no DELETE policy.
--
-- DESIGN DECISIONS (recorded here and in the service headers)
--  - NO DELIVERY PROVIDER IS ASSUMED. The email (Brevo) and SMS
--    (httpSMS) adapters are stubs that return PROVIDER_NOT_CONFIGURED
--    — no key, no SDK, no network call. A notification with no
--    configured provider for its channel ends 'failed' after the
--    retry budget with that code in payload.delivery_code.
--  - Opted-out-after-emit: the row stays visible in the inbox (it was
--    emitted); the worker skips the outbound attempt — in_app rows go
--    'sent', email/sms rows go 'failed' with
--    payload.delivery_code = 'OPTED_OUT'.
--  - Quiet hours are UTC wall-clock (Render runs UTC); the worker
--    computes next_attempt_at as the next quiet_end.
--  - A partial refund does NOT emit a 'refunded' notification (the
--    dispute_resolved notification covers it); only a full refund
--    completing through the Stage 0 path emits 'refunded'.
--
-- APPLY ORDER: after 20261116_trust_foundation.sql (it defines
-- is_admin()). FILE ONLY — apply in the Supabase SQL Editor.
-- Rollback: DROP TABLE public.notifications; DROP TABLE public.notification_preferences.

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN (
    'order_created', 'order_confirmed', 'order_declined', 'order_paid',
    'order_shipped', 'order_completed', 'refund_requested', 'refunded',
    'offer_received', 'offer_countered', 'offer_accepted', 'offer_rejected',
    'group_joined', 'group_closed', 'settlement_ready',
    'shipment_booked', 'shipment_status', 'shipment_delivered',
    'dispute_filed', 'dispute_status', 'dispute_resolved',
    'verification_submitted', 'verification_approved', 'verification_rejected'
  )),
  title text NOT NULL,
  body text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  channel text NOT NULL CHECK (channel IN ('in_app', 'email', 'sms')),
  delivery_status text NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'sent', 'failed', 'deferred')),
  dedupe_key text NOT NULL UNIQUE,
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'order_created', 'order_confirmed', 'order_declined', 'order_paid',
    'order_shipped', 'order_completed', 'refund_requested', 'refunded',
    'offer_received', 'offer_countered', 'offer_accepted', 'offer_rejected',
    'group_joined', 'group_closed', 'settlement_ready',
    'shipment_booked', 'shipment_status', 'shipment_delivered',
    'dispute_filed', 'dispute_status', 'dispute_resolved',
    'verification_submitted', 'verification_approved', 'verification_rejected'
  )),
  enabled boolean NOT NULL DEFAULT true,
  channels text[] NOT NULL DEFAULT '{in_app}'
    CHECK (channels <@ ARRAY['in_app', 'email', 'sms']),
  language text NOT NULL DEFAULT 'hi' CHECK (language IN ('hi', 'en')),
  quiet_start time,
  quiet_end time,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_type)
);

-- The worker's due scan (oldest pending/deferred first) and the
-- inbox list (newest first per user).
CREATE INDEX IF NOT EXISTS notifications_delivery_due_idx
  ON public.notifications (delivery_status, created_at);
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON public.notifications (user_id, created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

-- A user reads only their own notifications.
CREATE POLICY "Users read their own notifications"
  ON public.notifications FOR SELECT
  USING (auth.uid() = user_id);

-- A user marks only their own notifications read (read_at).
CREATE POLICY "Users update their own notifications"
  ON public.notifications FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Admins read every notification (support / delivery review) via the
-- Stage 1 is_admin() helper. No INSERT/UPDATE/DELETE for admins
-- through PostgREST — writes go through the backend (service role).
CREATE POLICY "Admins read all notifications"
  ON public.notifications FOR SELECT
  USING (public.is_admin());

-- A user reads only their own preferences.
CREATE POLICY "Users read their own notification preferences"
  ON public.notification_preferences FOR SELECT
  USING (auth.uid() = user_id);

-- A user sets only their own preferences.
CREATE POLICY "Users insert their own notification preferences"
  ON public.notification_preferences FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- A user changes only their own preferences.
CREATE POLICY "Users update their own notification preferences"
  ON public.notification_preferences FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Admins read every preference (support review) via is_admin().
CREATE POLICY "Admins read all notification preferences"
  ON public.notification_preferences FOR SELECT
  USING (public.is_admin());

-- No anon policy: anonymous callers see nothing. No DELETE policy on
-- either table: deletes go through the backend (service role) only.
