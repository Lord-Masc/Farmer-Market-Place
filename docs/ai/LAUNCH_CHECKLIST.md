# Launch Checklist — Farmer Marketplace agritech transformation

> Status: written 2026-11-12, branch `feat/stage11-docs`, base `210eabd`.
> Nothing in this checklist has been executed. Every step that touches
> production needs Rishabh's explicit word at the time it is done.
> Stage 0 is the only stage live. Stages 1, 2, 4, 5, 6, 7, 8, 9, 10 are
> complete on local branches — NOT pushed, NOT live. Stage 3 is BLOCKED.
> Stage 11 theme application happens only after Rishabh picks a theme.

## Go-live order (strict)

```
Stage 0  ✅ LIVE on main since 2026-11-12 18:13 IST (21 commits)
Stage 1  → trust foundation
Stage 2  → Digital Crop Passport
Stage 3  ⛔ BLOCKED — data.gov.in API key (Rishabh's registration)
Stage 4  → Negotiation
Stage 5  → Smart Group Selling
Stage 6  → Logistics & Delivery
Stage 7  → Dispute & Trust Management
Stage 8  → AI Farmer Assistant
Stage 9  → Notifications & Communication
Stage 10 → Admin & Platform Intelligence
Stage 11 → theme application (only after Rishabh's pick) + headers + pentest
```

Rules: never skip a stage, never apply two stages' migrations in one
batch, never push a stage's branch files before its migration is applied
live and verified. Stage 2 and Stage 3 are parallel-safe after Stage 1
(different tables, different surfaces) — but Stage 3 is blocked, so the
live sequence runs 1 → 2 → 4 → 5 → 6 → 7 → 8 → 9 → 10.

## Per-stage steps

Every stage follows the same five steps. Do them in order; stop and
report if any step fails.

1. **Apply the migration live** in the Supabase SQL Editor on project
   `prrshenqceqijkfapthl` (14426, ap-south-1). Confirm the target project
   first — never apply to any other project. Read the migration file
   header for its own pre-checks and apply order.
2. **Create the private bucket** (only where the stage lists one) in the
   Supabase Dashboard: Storage → New bucket → exact name below, Public
   OFF, NO policies. Bucket creation is not SQL — it is a dashboard step.
3. **Push the branch files to main via the browser web-UI.** The GitHub
   App push route 403s on this repo; the browser web-UI is the working
   push route. Never push directly to `main` from a local git push, never
   force-push, never merge without Rishabh's word.
4. **Live-verify** the stage (checks listed per stage below).
5. **Record** the outcome in `docs/ai/HANDOVER.md` and
   `docs/ai/TEST_CHECKLIST.md` with the live verification result.

### Stage 1 — Trust foundation (branch `feat/stage1-trust`)

- Migration (FILE ONLY until applied): `supabase/migrations/20261116_trust_foundation.sql`
  — `profiles.verification_status` + `verified_at`/`verified_by`, role
  CHECK widened to (`buyer`,`farmer`,`admin`), `prevent_trust_escalation`
  trigger, `verification_submissions` table + one-pending-per-farmer
  index, `is_admin()` helper, verification-docs storage policies.
- Bucket: none (Stage 2 creates the private bucket; Stage 1 code uploads
  to the `verification-docs/` prefix inside `product-images` until then —
  see the Stage 2 hardening note in HANDOVER.md).
- First-admin bootstrap (manual, needs Rishabh's own user UUID — never
  guessed): `UPDATE public.profiles SET role = 'admin' WHERE id = '<admin-user-uuid>';`
  in the Supabase SQL Editor, after the migration is applied. Until then
  the system works with zero admins (admin routes 403 for everyone).
- Live-verify: submit a verification as a farmer → status flips to
  Pending; admin queue lists it; approve → farmer shows verified;
  reject with a note → status rejected.

### Stage 2 — Digital Crop Passport (branch `feat/stage2-passport`)

- Migrations (FILE ONLY): `20261117_crop_passport.sql` (`crop_passports`,
  `farmer_stats` view computed only from orders, `orders.completed_at`)
  + `20261117_verification_docs_private.sql` (removes the
  `verification-docs/` branches from the `product-images` policies).
- Bucket: create the PRIVATE `verification-docs` bucket (Public OFF, NO
  policies) BEFORE the code goes live. Zero verification documents exist
  live (Stage 1 never went live), so nothing needs moving.
- Live-verify: farmer creates a passport lot; public passport page
  `/farmers/:id` shows it only for verified farmers (missing vs
  unverified farmer → same generic 404/empty state); admin views a
  verification document via the 5-minute signed URL; `farmer_stats` math
  checked against real orders (the view math was hand-checked only, never
  executed on real Postgres).

### Stage 4 — Negotiation (branch `feat/stage4-negotiation`)

- Migration (FILE ONLY): `20261119_negotiation.sql` (`requirements`,
  `offers`, `agreements`, BEFORE UPDATE trigger blocking edits to accepted
  rows). Apply after `20261116` (defines `is_admin()`) and `20261117`.
- Bucket: none.
- Live-verify: buyer posts a requirement → farmer quotes → counter →
  accept creates exactly one order at the locked price (edit the listing
  price after locking; the order must keep the locked price) → competing
  open offers are rejected.

### Stage 5 — Smart Group Selling (branch `feat/stage5-group-selling`)

- Migration (FILE ONLY): `20261120_group_selling.sql` (`group_buys`,
  `group_buy_participants`, `group_settlements`,
  `requirements.group_buy_id`). Apply after `20261116` and `20261119`.
- Bucket: none.
- Live-verify: create a group → join as a second farmer → negotiate as
  one buyer → close → settlement rows sum EXACTLY to the order total
  (largest-remainder split, integer paise). Settlements are what each
  participant OWES toward the pooled order total — no money moves in this
  stage.

### Stage 6 — Logistics & Delivery (branch `feat/stage6-logistics`)

- Migration (FILE ONLY): `20261121_logistics.sql` (`transporters`,
  `shipments`, `shipment_events`; role CHECK widened to include
  `transporter`). Apply after `20261116`.
- Bucket: create the PRIVATE `delivery-proofs` bucket (Public OFF, NO
  policies) BEFORE the code goes live — code answers 503 until then.
- Live-verify: transporter registers → admin approves in the Stage 1
  queue → quote → book → status advances forward-only → buyer sees the
  OTP on the tracking page → verify-OTP with a proof photo releases
  payment and marks the order COMPLETED. Wrong OTP fails and increments
  attempts; 5 failures lock out for 15 minutes.

### Stage 7 — Dispute & Trust Management (branch `feat/stage7-disputes`)

- Migration (FILE ONLY): `20261122_disputes.sql` (`disputes`,
  `dispute_evidence`, `dispute_messages`; `farmer_stats` rewritten with
  real `dispute_rate` + `refund_rate`). Apply after `20261116` and
  `20261117`.
- Bucket: create the PRIVATE `dispute-evidence` bucket (Public OFF, NO
  policies) BEFORE the code goes live — code answers 503 until then.
- Live-verify: file a dispute on an own order → upload evidence →
  message thread → admin resolves (refund / partial_refund / replacement
  / rejected) → exactly one refund row for a refund outcome; SLA check
  (`POST /api/admin/disputes/check-sla`) escalates overdue disputes and
  never auto-resolves.

### Stage 8 — AI Farmer Assistant (branch `feat/stage8-assistant`)

- Migration (FILE ONLY): `20261123_assistant.sql`
  (`assistant_conversations`). Apply after `20261116`.
- Bucket: none. No provider: the LLM adapter is a stub
  (`LLM_NOT_CONFIGURED`, 503) and voice is always 503
  `VOICE_NOT_CONFIGURED` — the provider choice is Rishabh's human
  decision. Do NOT wire a provider key without his word.
- Live-verify: ask a price question with no `mandi_prices` data → the
  answer contains zero digits and `no_data: true`; ask about an own order
  → grounded answer with sources; ask about another user's order → 404.

### Stage 9 — Notifications & Communication (branch `feat/stage9-notifications`)

- Migration (FILE ONLY): `20261124_notifications.sql` (`notifications`,
  `notification_preferences`). Apply after `20261116`.
- Bucket: none. Email (Brevo) + SMS (httpSMS) adapters are stubs
  returning `PROVIDER_NOT_CONFIGURED` — first real email/SMS needs his
  Brevo/httpSMS keys. The in-app inbox works with zero providers.
- Live-verify: place an order → inbox rows appear for buyer + farmer;
  mark one read → badge count drops; quiet-hours preference defers
  delivery (quiet hours are UTC wall-clock — the UI labels them "(UTC)").

### Stage 10 — Admin & Platform Intelligence (branch `feat/stage10-admin`)

- Migration (FILE ONLY): `20261125_admin_views.sql`
  (`admin_stuck_money` + `platform_metrics_daily` views; two nullable
  columns on existing tables: `profiles.suspended_at`,
  `products.status`). Apply after `20261116`.
- Bucket: none.
- Live-verify: `/api/admin/metrics` returns real aggregates (null, never
  0, when no data — `mandi_modal_paise` stays null until Stage 3);
  `/api/admin/reconciliation` lists stuck money by category;
  suspend a test user → their listings hide and every authenticated API
  returns 403 `ACCOUNT_SUSPENDED` (login itself still works) → reinstate
  restores; `/transparency` is public and carries no personal data.

### Stage 11 — Design, mobile, hardening & launch readiness (branch `feat/stage11-launch`)

- No migration. No bucket.
- Theme application: ONLY after Rishabh picks one of the three Hallmark
  themes dealt to him. Never apply a theme to the existing design unasked.
  The live portfolio lesson applies here too: the existing design is his
  pick until he says otherwise.
- `vercel.json` header change (Stage 11 Unit D): Permissions-Policy
  added — `camera=()`, `microphone=(self)`, `geolocation=(self)`.
  Verified from source: microphone is used audio-only by the assistant
  voice recorder (`AssistantChat.jsx`, `getUserMedia({ audio: true })`);
  geolocation is used by both dashboards to set profile lat/lng
  (`BuyerDashboard.jsx`, `FarmerDashboard.jsx`); no camera capture exists
  anywhere (photo uploads are file inputs only). Verify live headers after
  deploy.
- Pentest: run per `docs/ai/PENTEST_SCOPE.md` — ONLY on Rishabh's
  go-ahead. No account, no scan, no spend before that.
- Regression targets (Stage 11 spec, NOT yet run): backend suite green,
  Playwright happy paths on staging (signup → list → order → pay → ship →
  deliver → release; dispute → resolve; group buy → settle), Lighthouse
  mobile ≥ 90 on the transactional pages, axe audit 0 critical.

## Env parity (names only — never values)

Compare the Render dashboard against the repo templates before every
go-live. A name present in one place and missing in the other is a
launch blocker. Values live only in the provider dashboards, never in
the repo.

### Render backend (from `backend/.env.example` + root `.env.example`)

| Variable | Required | Notes |
|---|---|---|
| `PORT` | yes | Backend listens here |
| `SUPABASE_URL` | yes | Must match the live project `prrshenqceqijkfapthl` |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Backend-only; never in the frontend bundle |
| `RAZORPAY_KEY_ID` | yes | Must pair with the secret below |
| `RAZORPAY_KEY_SECRET` | yes | Backend-only |
| `RAZORPAY_WEBHOOK_SECRET` | yes | Set when creating the webhook (payment.captured) |
| `ALLOWED_ORIGINS` | yes | Comma-separated CORS allowlist |
| `FRONTEND_URL` | yes | Used for redirects/links |

### Vercel frontend (from root `.env.example`)

| Variable | Required | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | yes | Same project as the backend |
| `VITE_SUPABASE_ANON_KEY` | yes | Anon key only — never the service-role key |
| `VITE_RAZORPAY_KEY_ID` | yes | Must pair with the backend secret (key-id/secret mismatch breaks checkout signature verification) |
| `VITE_GOOGLE_MAPS_API_KEY` | optional | UNVERIFIED whether set in Vercel; when absent, geocoding silently skips and lat/lng fall back to profile coordinates — maps degraded, not broken |
| `VITE_ESCROW_API_URL` | yes | Must point at the live Render backend URL |

## Webhook secret check

- Razorpay dashboard: webhook is Active, `payment.captured` only, ID
  `TzGnpuW2LrdSjY`, secret on Render as `RAZORPAY_WEBHOOK_SECRET`,
  backend redeployed 2026-11-12 18:25 IST, `/health` ok.
- Still unproven: end-to-end HMAC verification needs the first real test
  `payment.captured` delivery — that is Rishabh's smoke test (below), not
  a pre-launch assumption. If the first delivery fails, stop the go-live
  sequence and fix the webhook before pushing further stages.

## data.gov.in key (Stage 3 — blocked)

- Stage 3 (FairPrice Intelligence) is BLOCKED until Rishabh registers for
  a data.gov.in API key himself (human registration — no agent can do it
  for him).
- Until it lands: `mandi_prices` has no rows, the assistant answers "no
  data" for prices (never a number), `mandi_modal_paise` is null, and the
  FairPrice anchor returns null. Nothing in Stages 4–11 depends on Stage 3
  being live — the go-live order skips it (1 → 2 → 4 → 5 → …).

## gitleaks CI check

- `.github/workflows/ci.yml` has a `gitleaks` job (pinned CLI 8.28.0,
  `--no-git`, working tree only) plus the `verify` job (frontend build +
  backend tests).
- The workflow runs on push to `main` and on pull requests. It has NOT
  run on GitHub yet — it runs on the next push/PR.
- `--no-git` is deliberate: git history still holds the dead compromised
  keys from 2026-11-08 (history purge was SKIPPED on Rishabh's word after
  he rotated them), so a history scan would fail forever on old commits.
  The job guards NEW content only.
- Pre-launch check: confirm the `verify` + `gitleaks` jobs are green on
  the first push that carries a stage live. If gitleaks fails, the push
  introduced a secret — stop and remove it before proceeding.

## Rollback plan

Per `docs/ai/ROLLBACK.md`. The standing rules:

- Code rollback: focused `git revert` of the stage's commits (local
  branches are never force-pushed); re-run backend tests + frontend build
  after reverting.
- Applied migrations are potentially irreversible — rollback is a
  FORWARD-FIX migration only, never an edit to the applied file. Every
  stage has a rollback entry in ROLLBACK.md (or one must be written
  before its migration is applied live).
- Before applying any migration live: confirm the target project,
  backup/PITR availability, migration order, data impact, and a tested
  recovery plan. Export the affected tables first where the rollback entry
  says the data would be destroyed (passport lots, requirements/offers/
  agreements, groups/settlements, shipments, disputes, conversations).
- Unit D (docs-only) rollback: revert the docs commits; `vercel.json`
  header rollback = restore the previous header set (see ROLLBACK.md).
- Never execute a production rollback without Rishabh's explicit approval.

## Smoke test (Rishabh's — not ours to run)

Rishabh runs this on the live site after each stage goes live (or once
after the full sequence — his call). Agents do NOT run live smoke tests
against production Supabase/Razorpay.

1. Log in on https://farmer-market-place-six.vercel.app.
2. Place one order end-to-end (list → order → pay → ship → deliver →
   release) and confirm the order reaches COMPLETED with the payment
   RELEASED.
3. Confirm one real webhook delivery proves HMAC (a `payment.captured`
   event arriving at `POST /api/razorpay/webhook` and marking the order
   paid without the browser callback).
4. Report the result; if any step fails, stop the go-live sequence.

## Pre-launch gates (all must be true before the first Stage 1 push)

- [ ] Stage 1 migration file + first-admin UUID in hand (UUID from Rishabh, never guessed)
- [ ] Render + Vercel env parity checked (table above, names only)
- [ ] Webhook secret check done (Active, payment.captured only)
- [ ] gitleaks + verify jobs green on the push
- [ ] Rollback entries exist in ROLLBACK.md for every stage being pushed
- [ ] Rishabh's word to go live for that stage
