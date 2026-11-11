# AI collaboration rules

Before changing code, read these files in order:
1. `docs/ai/README.md`
2. `docs/ai/HANDOVER.md`
3. `docs/ai/ARCHITECTURE.md`
4. `docs/ai/CONSTRAINTS.md`
5. `docs/ai/FLOW.md`
6. The relevant `BUG.md` or `FEATURE.md`

## Required workflow
- Explain the problem, scope, affected files, risks, and verification plan before implementation.
- Make one logical change per task. Do not expand scope without asking.
- Read relevant code before proposing edits; trace callers and data flow across modules.
- Never click/accept broad permissions blindly. Request only the access needed for the task.
- Preserve existing architecture and dependencies. Ask before adding dependencies or changing database schema.
- Do not touch secrets, production data, payment behavior, auth/RLS, or migrations without explicit scope and a rollback plan.
- Add comments only for non-obvious intent, invariants, security assumptions, or tricky control flow; do not narrate obvious code.
- Run the exact checks in `docs/ai/TEST_CHECKLIST.md`. Report commands and actual results; never claim an unrun check passed.
- Review the complete diff before finishing. Explain every changed file and any residual risk.
- For risky changes, prepare and verify a rollback plan using `docs/ai/ROLLBACK.md`.
- Do not merge, deploy, run production migrations, or modify production data unless explicitly instructed.

## End every session
Update `docs/ai/HANDOVER.md`, the relevant decision/bug/feature log, and `docs/ai/ROLLBACK.md` when applicable. Include a five-line handoff: done, changed, checks, remaining, next action.

## Source of truth
When documentation and implementation disagree, inspect the code and identify the discrepancy. Do not silently guess or rewrite project behavior from documentation alone.
