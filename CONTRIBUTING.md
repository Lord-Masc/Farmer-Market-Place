# Contributing to AgroConnect (Farmer Marketplace)

## AI / LLM use — read this first

This project welcomes AI-assisted contributions, with honest disclosure:

- **Disclose it.** Every PR that used an AI tool (code generation, review, tests, docs) must say so in the PR description: which tool, and what it produced. A PR that hides AI involvement will be closed.
- **Human accountability.** The contributor owns the change. AI output must be read, understood, and verified by the contributor before it is submitted — "the AI wrote it" is never an excuse for a broken or insecure change.
- **No evasion.** Do not rewrite AI-generated code to look human, do not strip AI markers to dodge detection, and do not claim AI-written work as hand-written.
- **Verify, don't trust.** AI suggestions about payments, auth, RLS, migrations, or security must be checked against the actual code and the test suite, not accepted on the tool's word.

## How to contribute

1. **Start from `main`.** Branch from `origin/main`, one logical change per branch. Never push directly to `main`.
2. **Read the house rules first:** `AGENTS.md` and `docs/ai/README.md`, then `docs/ai/HANDOVER.md`, `ARCHITECTURE.md`, `CONSTRAINTS.md`, `FLOW.md`. They are binding.
3. **Plan before code.** Explain the problem, scope, affected files, risks, and verification plan before implementing. One logical change per task; do not expand scope without asking.
4. **Preserve the architecture.** React + Vite frontend, Express backend, Supabase (Auth + Postgres + RLS). Ask before adding a dependency or changing the database schema.
5. **Tests are part of the change.** New or changed behaviour ships with tests (backend Jest; frontend flows get a Playwright smoke check where one exists). Never weaken, skip, or delete a failing test to get green. Never replace real functionality with a mock or hardcoded fallback.
6. **Run the checks** in `docs/ai/TEST_CHECKLIST.md` and report the exact commands and results in the PR:
   - `npm run build` (frontend production build)
   - `npm run lint` (report pre-existing failures separately)
   - `cd backend && npm test -- --runInBand`
7. **Migrations.** Never edit an applied migration. Add a new one in `supabase/migrations/` with the next date prefix, in order. Migrations are files only — never run them against production without explicit approval, a backup, and a rollback plan (see `docs/ai/ROLLBACK.md`).
8. **No secrets, ever.** Never commit `.env` files, API keys, tokens, or service-role keys. `.env` is gitignored; CI runs a secret scan (gitleaks) and blocks `.env`/key patterns. If you find a secret in history, report its location only — never the value — and do not attempt rotation yourself.
9. **Payments and trust.** Do not describe internal payment states (`HELD`/`RELEASED`) as legal escrow or automatic farmer payouts — no settlement integration exists. Do not claim a live payment, payout, or escrow behaviour was tested when only mocks or unit tests ran.
10. **No fake data in production paths.** No fabricated people, prices, deals, or reviews in the UI. Demo data belongs only in explicitly labelled dev/demo environments.
11. **Do not merge, deploy, run production migrations, or modify production data** unless explicitly instructed. PRs are reviewed; merges and deploys are the maintainer's call.

## Pull requests

- Use the PR template. Fill in every section; "n/a" with a reason beats a blank.
- Small, reviewable PRs. A PR touching more than ~5 files needs a reason.
- Link the related issue or `docs/ai/BUG.md` / `FEATURE.md` entry.
- The PR description must state: what changed, why, what was tested (exact commands + pass/fail counts), and any residual risk.

## Code of conduct

Be respectful. This project serves real farmers and buyers — a broken payment or a fake price is not an abstract bug. If you are unsure whether a change is safe, ask before shipping it.
