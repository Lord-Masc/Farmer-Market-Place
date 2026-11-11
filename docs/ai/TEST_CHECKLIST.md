# Test and Verification Checklist

A change is not done until the relevant commands have actually run and results are recorded.

## Standard local checks
Run from repository root:
- [ ] Install frontend dependencies: `npm install` (only when needed).
- [ ] Production frontend build: `npm run build`.
- [ ] Frontend lint: `npm run lint` (report existing/unrelated failures separately).
- [ ] Install backend dependencies: `cd backend && npm install` (only when needed).
- [ ] Backend tests: `cd backend && npm test -- --runInBand`.

## Change-specific checks
- [ ] Add/update tests for changed behavior.
- [ ] Payment changes: verify ownership, amount derivation, signature comparison, captured status, order binding, duplicate/retry behavior, and failure paths.
- [ ] Order/stock changes: verify approval, insufficient stock, concurrent requests, and rollback/atomicity.
- [ ] Auth/profile changes: verify buyer/farmer roles, RLS, public/private data boundaries, and signup/login paths.
- [ ] SQL changes: inspect migration order, syntax, grants, RLS, constraints, indexes, trigger behavior, and rollback/recovery implications.
- [ ] API changes: verify frontend/backend request and response contracts, CORS, env vars, and error handling.
- [ ] CI/deployment: inspect actual GitHub Actions and Vercel/Render statuses; do not infer from local success.

## Evidence format
For each check record:
- Exact command or check name.
- Environment and commit SHA.
- Actual pass/fail/blocked result.
- Relevant output or failure summary.
- What remains unverified.

Never mark a check passed unless it was executed. Mocked tests do not establish live Razorpay or Supabase integration success.
