# AI Collaboration Workspace

This folder applies the practices from the **AI Collaboration Field Guide** to Farmer Marketplace.

## Start here
1. `../../AGENTS.md` — mandatory rules for AI coding agents.
2. `HANDOVER.md` — current project state and next actions.
3. `ARCHITECTURE.md` — verified system map.
4. `CONSTRAINTS.md` — boundaries and off-limits operations.
5. `FLOW.md` — cross-module execution paths.
6. `DECISIONS.md` — rationale for meaningful decisions.
7. `TEST_CHECKLIST.md` and `ROLLBACK.md` — proof and recovery.
8. `BUG.md` / `FEATURE.md` — task-level investigation records.

## Update discipline
- Update handover at the end of every meaningful AI session.
- Record decisions when a change introduces a lasting trade-off or architectural choice.
- Keep task logs focused: one bug or feature per entry; link the PR/commit.
- Keep architecture and flow documentation aligned with code; mark unverified details explicitly.
- Never record secrets, tokens, personal data, or production credentials here.

## Change protocol
**Plan → inspect → implement one logical change → test → read the diff → document → hand off.**

This documentation setup does not authorize merging PRs, deploying, applying database migrations, or touching production systems.
