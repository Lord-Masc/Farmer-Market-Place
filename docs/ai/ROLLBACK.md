# Rollback and Recovery Plan

Create a task-specific rollback plan before risky changes. This file is a checklist, not permission to execute rollback.

## Code rollback
1. Identify the last known-good commit SHA and the exact commits/files being reverted.
2. Prefer a focused revert commit over force-pushing or rewriting shared history.
3. Check dependent commits and migrations before reverting application code.
4. Re-run the relevant build, tests, and security checks after revert.
5. Verify the intended branch and PR state; never push to `main` unless explicitly authorized.

## Database rollback
- Treat applied migrations as potentially irreversible.
- Before applying a migration, confirm the target Supabase project, backup/PITR availability, migration order, data impact, and a tested recovery plan.
- Prefer a forward-fix migration when dropping/reversing schema could destroy data.
- Do not execute production SQL or migrations without explicit approval.
- Record migration name, execution time, target environment, operator, and verification result without recording credentials.

## Payment and inventory incidents
- Stop retries or further state transitions only through an approved operational procedure.
- Preserve gateway IDs, internal order IDs, and audit evidence; never manually fabricate payment states.
- Reconcile Razorpay captured/refunded state with the internal ledger before any repair.
- For stock discrepancies, compare order history and transactional reservation records before adjusting inventory.

## Task-specific rollback record
- **Change / PR:**
- **Last known-good SHA:**
- **Files / migrations affected:**
- **Recovery steps:**
- **Data-loss risks:**
- **Post-rollback checks:**
- **Approval / execution record:**
