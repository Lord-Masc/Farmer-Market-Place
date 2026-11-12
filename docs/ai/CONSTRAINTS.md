# AI and Engineering Constraints

These are project-specific guardrails. Ask before crossing any boundary.

## Never do without explicit approval
- Merge or close a PR; push directly to `main`; deploy; apply production migrations; modify production records.
- Read, print, copy, commit, or expose real secrets, access tokens, service-role keys, payment secrets, or user PII.
- Change payment, refund, authentication, authorization, RLS, profile privacy, or stock-reservation behavior outside the explicitly requested scope.
- Delete or rewrite existing migrations; make destructive schema/data changes.
- Add dependencies, introduce a new service/provider, or change hosting architecture.
- Claim live payment, payout, escrow, email, or production behavior was tested when only mocks/unit tests ran.
- Apply a design theme to the live app without Rishabh's pick (Stage 11: Hallmark deals three themes, he picks one — never apply a theme to the existing design unasked).
- Run any end-to-end test against live Supabase or live Razorpay (staging/local only; the live smoke test is Rishabh's, not an agent's).
- Run the Strix pentest (or create a Strix account, register an asset, or spend credits) without Rishabh's explicit go-ahead — see `docs/ai/PENTEST_SCOPE.md`.

## Always preserve
- Server-side validation of buyer identity, order ownership, payment amount, provider signature, captured status, and order/payment binding.
- Idempotency and database uniqueness for payment/refund paths.
- Atomic stock reservation and valid order-state transitions.
- Least-privilege database access and RLS; never expose private profiles through public queries.
- Existing environment variable names and deployment contracts unless a change is specifically planned.
- Tests for changed behavior and explicit reporting of untested external integrations.

## Working style
- One logical change per task; smallest safe diff.
- Explain the plan before edits and list affected files.
- Avoid speculative abstractions and unrelated refactors.
- Add comments for intent/invariants, not obvious statements.
- Review every diff and explain why each file changed.
