# Stage 9 Unit A evidence — migration + backend (2026-11-12, branch `feat/stage9-notifications-backend`, HEAD `8eab801`)

## Backend tests: `cd backend && npm test -- --runInBand` → 422/422 pass, 23 suites (baseline 387/387, 21 suites; +35 notification tests in 2 new suites). Run in the unit worktree.
- TDD: both suites were written first and watched RED (26 failed, modules not found) before any implementation, then GREEN. Two test bugs were fixed during the run (a pay replay asserted after completion, where the pay path correctly 409s — moved to while PAID; the mock needed the real `idempotency_keys` UNIQUE backstop for the create replay) — no production code was changed to satisfy a test.
- Hand-checked literals pinned: backoff attempt 1 → now + 2 min, attempt 2 → now + 4 min, attempt 3 → 'failed' (attempts 3, code `PROVIDER_NOT_CONFIGURED`); quiet hours 22:00–07:00, now 2026-11-12T23:30:00Z → 'deferred', `next_attempt_at` exactly 2026-11-13T07:00:00.000Z; escrow lifecycle on one order (total_price 500 = 50000 paise): order_created x2 (buyer + farmer), order_confirmed x1 (buyer), order_paid x1 (farmer), order_shipped x1 (buyer), order_completed x2 (buyer + farmer); replayed pay (while PAID) and replayed create (same idempotency key) add zero rows; second order refund_requested x1 (farmer), refunded x1 (buyer), replays add zero rows.
- The existing 387 tests pass unchanged — the emit wiring is best-effort and never throws into the business flows (verified by the unchanged suites, whose mocks lack the new tables).

## Frontend build: `npm run build` (repo root; `npm install` ran first — node_modules was absent in the fresh worktree) → ✓ built in 2.08s (only the pre-existing chunk-size warning). No frontend files touched.

## Frontend lint: `npm run lint` → 2842 problems (2834 errors, 8 warnings) vs Stage 8 baseline 2551. Rule breakdown: 2810 `no-undef` (the pre-existing eslint-config class — config defines only browser globals), 21 `no-unused-vars` (unchanged from Stage 8 — all pre-existing), 8 `react-hooks/exhaustive-deps`, 1 each `react-refresh/only-export-components`, `no-case-declarations`, `react-hooks/immutability`. Scoped lint on all Stage 9 files (new service/worker/routes/adapters/templates/tests + `server.js`): 299 problems, ALL `no-undef`; zero `no-unused-vars` in Stage 9 files. Stage 9 adds +291 `no-undef` and zero in every other class.

## SQL: `python3 -c "from pglast import parse_sql; ..."` → `20261124_notifications.sql` parse ok, 13 statements. Migration FILE ONLY — never applied live. Apply order: after `20261116` (defines `is_admin()`).

## Secrets: grep over all new/changed files for `api-key|secret|password|token|private-key|bearer` → clean (only the test dummy `'test-secret'` in the test env setup, same pattern as existing suites). `git diff --check` clean. No keys in code, no new dependencies (no SDKs — stubs only).

## Contract (exact shapes, for the frontend — verified by the route tests in `notificationRoutes.test.js`, service mocked):
- `GET /api/notifications?unread_only=true&limit=20&offset=0` → 200 `{ "notifications": [{ "id", "type", "title", "body", "payload", "channel", "delivery_status", "read_at", "created_at" }], "unread_count" }` (newest first; `limit` default 20, max 100; `offset` default 0).
- `PATCH /api/notifications/:id/read` → 200 `{ "notification" }` (sets `read_at`; own row only, 404 otherwise).
- `GET /api/notifications/preferences` → 200 `{ "preferences": [{ "event_type", "enabled", "channels", "language", "quiet_start", "quiet_end" }] }` (rows the user has set; the frontend renders defaults for missing types: in_app only, enabled, language 'hi', no quiet hours).
- `PATCH /api/notifications/preferences` with body `{ "preferences": [{ "event_type", "enabled", "channels", "language", "quiet_start", "quiet_end" }] }` → 200 `{ "preferences" }` (upsert per type; channels ⊆ {in_app, email, sms}, language ∈ {hi, en}, quiet times HH:MM or null; non-array body → 400, bad values → 422).
- All four routes behind `requireAuth` + per-route rate limits inside the router (list/read/get-prefs 60, patch-prefs 30), mounted at `/api/notifications` in `server.js` (no extra mount-level limit).
- Event-type enum (exact strings, used in the migration CHECK, templates, emit calls, preferences): `order_created, order_confirmed, order_declined, order_paid, order_shipped, order_completed, refund_requested, refunded, offer_received, offer_countered, offer_accepted, offer_rejected, group_joined, group_closed, settlement_ready, shipment_booked, shipment_status, shipment_delivered, dispute_filed, dispute_status, dispute_resolved, verification_submitted, verification_approved, verification_rejected`.
- Error shape is the repo's flat `{ error, code }` (via the central error handler).

## Design decisions recorded in code (migration header + service/worker headers)
- NO DELIVERY PROVIDER IS ASSUMED. Adapters are interface + stubs only: Brevo (email, the ready hook) and httpSMS (sms, key pending on his side) both return `{ ok: false, code: 'PROVIDER_NOT_CONFIGURED' }` — never a fake "sent", no key, no SDK, no network call.
- The in-app inbox is the core and works with zero providers. Default preference is in_app only; email/sms only when the user explicitly enables them. Emit checks preferences at emit time; the worker re-checks before every attempt.
- Dedupe: `notifications.dedupe_key` UNIQUE, value `event_id:user_id:channel`; a replay hits the unique violation and is treated as already-emitted.
- Quiet hours: emit still creates the row; the worker DEFERS delivery (`deferred`, `next_attempt_at` = next quiet-end) and never attempts inside them. Quiet hours are UTC wall-clock (Render runs UTC); the frontend should label them as such.
- Delivery retries: failed attempt → attempts+1, `next_attempt_at` = now + 2^attempts minutes; after 3 attempts → 'failed' with the adapter's code in `payload.delivery_code`. No provider → 'failed' with `PROVIDER_NOT_CONFIGURED`, never 'sent'. In-app rows are 'sent' at emit.
- Opted-out-after-emit: the row stays visible in the inbox (it was emitted); the worker skips the outbound attempt — in_app rows go 'sent', email/sms rows go 'failed' with `payload.delivery_code = 'OPTED_OUT'`. Nothing is deleted.
- Templates: Hindi-first (default 'hi'); every title/body is built ONLY from the payload — a no-data template contains no digits (asserted for all 24 types × both languages).
- The worker fetches pending AND deferred rows whose `next_attempt_at` is due (due-ness filtered in the worker, not the query — a deferred row must be picked up again once its quiet-end passes).
- A partial refund does NOT emit 'refunded' (the dispute_resolved notification covers it); only a full refund completing through the Stage 0 path emits 'refunded'.
- A refund requested by the auto-refund cron (system enqueue, no buyer actor) DOES emit refund_requested to the farmer — a system enqueue is still a refund the farmer must know about. The audit log still records only manual requests.
- A dispute resolved with a refund outcome emits refund_requested + refunded alongside dispute_resolved — each is a true event.
- The worker runs on a 5-minute cron in `server.js` (same pattern as the Stage 0 reconcilers); `startWorker(intervalMs)` is also exported for programmatic use. `processPending` accepts `{ now, limit }` (limit default 50) for tests.
- The roadmap file `docs/transformation-assessment-2026-11-12.md` is absent from this worktree, so Stage 9 scope was taken from the task brief + the roadmap copy at `~/workspace/farmer-marketplace-clone/docs/transformation-assessment-2026-11-12.md` (§ Stage 9) — it matches the brief exactly.

## Flags (for the coordinator)
- Quiet hours are UTC wall-clock, not the user's local time — Unit B must label them as UTC (or the coordinator must decide to store a timezone per user; no timezone column exists yet).
- `GET /api/notifications` returns `unread_count` for the whole inbox, not just the page — the bell badge reads that field.
- Notification payloads carry only ids + the numbers the template rendered (`total_price`, `price`, `quantity`, `unit`, `crop`, `status`, `outcome`, `category`, `note`); the frontend should not expect product names or user names in the payload.
- Booking a shipment emits BOTH `shipment_booked` and `order_shipped` (the book path ships through escrow); OTP delivery emits BOTH `shipment_delivered` and `order_completed`; a negotiation acceptance emits `offer_accepted` AND `order_created` (the acceptance creates a real order) AND `offer_rejected` per competing offer. These are all true events, not duplicates — the inbox will show them as separate rows.

## NOT verified
- Migration never applied to a real Postgres (RLS asserted only by SQL-content tests, stated explicitly in the tests); no end-to-end notification flow against a live backend; no live browser check (frontend is Unit B). The worker has never run against a real provider (both adapters are stubs by design — first real email/sms delivery needs his Brevo/httpSMS keys).
