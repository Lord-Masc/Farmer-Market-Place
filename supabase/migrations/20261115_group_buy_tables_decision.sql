-- Stage 0, group-buy decision (Rishabh's word 2026-11-12): DROP the orphaned
-- group-buy tables. They have no feature behind them: the only caller,
-- src/services/groupService.js, was already deleted upstream (commit
-- f7b3a9b), the GroupBuying placeholder page was deleted in Stage 0 unit 5,
-- and no code in the repo reads these tables.
-- SAFETY GUARD: if either table holds any rows, the migration FAILS instead
-- of deleting data — check the live tables first and only apply when empty.
-- Dropping the tables also drops their RLS policies (20261109 §6).
-- FILE ONLY — apply in the Supabase SQL Editor; never run by this stage.
-- Rollback: re-create both tables from 20261108_base_schema.sql plus the
-- 20261109 §6 policies (see docs/ai/ROLLBACK.md).

DO $$
DECLARE
  buys_count bigint;
  parts_count bigint;
BEGIN
  SELECT count(*) INTO buys_count FROM public.group_buys;
  SELECT count(*) INTO parts_count FROM public.group_buy_participants;
  IF buys_count > 0 OR parts_count > 0 THEN
    RAISE EXCEPTION 'group-buy tables are not empty (group_buys=%, group_buy_participants=%) — refusing to drop', buys_count, parts_count;
  END IF;
END $$;

DROP TABLE IF EXISTS public.group_buy_participants;
DROP TABLE IF EXISTS public.group_buys;
