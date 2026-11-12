'use strict';
/**
 * Security fixes (run-1 audit findings 1, 3, 4, 5, 6 + finding 11 DB part):
 * SQL-content tests for supabase/migrations/20261126_security_fixes.sql.
 *
 * These are SQL-content tests only (same pattern as adminStage10.test.js
 * and notifications.test.js): they read the migration files with
 * fs.readFileSync and assert on the text. There is NO live Postgres in
 * this repo — the migration is parse-checked separately with pglast.
 *
 * Regression-guard note (findings 1 and 4): the historical files that
 * introduced the bad policies — 20261109_security_hardening.sql (original
 * farmer orders UPDATE) and 20261115_price_snapshot_and_status_enum.sql
 * (its re-introduction), and 20261121_logistics.sql (shipments UPDATE) —
 * still contain their CREATE POLICY lines, because old migrations are
 * never edited (forward-fix only). The guard therefore asserts the exact
 * historical set plus that NO migration file applied AFTER 20261126
 * re-creates either policy; 20261126 sorts after all three, so its DROP wins
 * live. A live check must still confirm via pg_policies that neither
 * policy exists after applying 20261126.
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '../../supabase/migrations');
const MIGRATION_FILE = '20261126_security_fixes.sql';

function readMigration(name) {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
}

function migrationNames() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort();
}

// Files applied strictly after 20261126 in filename (= apply) order.
function laterMigrationNames() {
  return migrationNames().filter((n) => n > MIGRATION_FILE);
}

const sql = readMigration(MIGRATION_FILE);

describe('20261126_security_fixes.sql — finding 1 (farmer orders UPDATE policy)', () => {
  test('drops the farmer orders status policy with no replacement', () => {
    // Live check still pending: after applying, pg_policies must show NO
    // UPDATE policy on public.orders for non-service roles.
    expect(sql).toContain(
      'DROP POLICY IF EXISTS "Farmers can update the status of their orders." ON public.orders;',
    );
    expect(sql).not.toContain(
      'CREATE POLICY "Farmers can update the status of their orders."',
    );
  });

  test('regression guard: no migration after 20261126 re-creates the farmer orders policy', () => {
    // Live check still pending: a future migration could re-create the
    // policy; this guard fails the suite if one does.
    const creators = migrationNames().filter((n) =>
      readMigration(n).includes(
        'CREATE POLICY "Farmers can update the status of their orders."',
      ),
    );
    expect(creators).toEqual([
      '20261109_security_hardening.sql',
      '20261115_price_snapshot_and_status_enum.sql',
    ]);
    const laterCreators = laterMigrationNames().filter((n) =>
      readMigration(n).includes(
        'CREATE POLICY "Farmers can update the status of their orders."',
      ),
    );
    expect(laterCreators).toEqual([]);
  });
});

describe('20261126_security_fixes.sql — finding 4 (shipments UPDATE policy)', () => {
  test('drops the assigned-transporter shipments UPDATE policy with no replacement', () => {
    // Live check still pending: after applying, pg_policies must show NO
    // UPDATE policy on public.shipments; shipment writes must go through
    // the backend service role only.
    expect(sql).toContain(
      'DROP POLICY IF EXISTS "The assigned transporter updates their own shipment." ON public.shipments;',
    );
    expect(sql).not.toContain(
      'CREATE POLICY "The assigned transporter updates their own shipment."',
    );
  });

  test('regression guard: no migration after 20261126 re-creates the shipments UPDATE policy', () => {
    // Live check still pending: same guard shape as finding 1 — the only
    // historical creator is 20261121_logistics.sql, superseded by the
    // 20261126 drop in apply order.
    const creators = migrationNames().filter((n) =>
      readMigration(n).includes(
        'CREATE POLICY "The assigned transporter updates their own shipment."',
      ),
    );
    expect(creators).toEqual(['20261121_logistics.sql']);
    const laterCreators = laterMigrationNames().filter((n) =>
      readMigration(n).includes(
        'CREATE POLICY "The assigned transporter updates their own shipment."',
      ),
    );
    expect(laterCreators).toEqual([]);
  });
});

describe('20261126_security_fixes.sql — finding 3 (transporter self-verification trigger)', () => {
  test('trigger function + trigger exist, guard verification_status, allow only postgres/service_role', () => {
    // Live check still pending: after applying, a transporter UPDATE of
    // verification_status via PostgREST must raise, while a service-role
    // admin approve and a transporter vehicle/rates edit must succeed.
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.prevent_transporter_self_verification()',
    );
    expect(sql).toContain('OLD.verification_status IS DISTINCT FROM NEW.verification_status');
    expect(sql).toContain("current_user NOT IN ('postgres', 'service_role')");
    expect(sql).toContain(
      'CREATE TRIGGER prevent_transporter_self_verification',
    );
    expect(sql).toContain('BEFORE UPDATE ON public.transporters');
    expect(sql).toContain(
      'FOR EACH ROW EXECUTE FUNCTION public.prevent_transporter_self_verification()',
    );
  });

  test('the transporters UPDATE policy itself is untouched (vehicle/rates edits stay possible)', () => {
    // Live check still pending: a transporter must still be able to
    // UPDATE their own row's vehicle/rates columns via PostgREST.
    expect(sql).not.toContain(
      'DROP POLICY IF EXISTS "Transporters update their own row."',
    );
    expect(sql).not.toContain(
      'CREATE POLICY "Transporters update their own row."',
    );
    expect(readMigration('20261121_logistics.sql')).toContain(
      'CREATE POLICY "Transporters update their own row."',
    );
  });
});

describe('20261126_security_fixes.sql — finding 5 (dispute_messages author_role spoof)', () => {
  test('rewritten INSERT policy binds author_role to the caller real role and blocks resolved disputes', () => {
    // Live check still pending: after applying, a buyer/farmer PostgREST
    // insert with author_role='admin' must fail, a matching-role insert
    // on an open dispute must succeed, and any insert on a resolved
    // dispute must fail.
    expect(sql).toContain(
      'CREATE POLICY "Dispute parties and admins can post messages."',
    );
    expect(sql).toContain('ON public.dispute_messages FOR INSERT');
    expect(sql).toContain("author_role = 'admin' AND public.is_admin()");
    expect(sql).toContain("author_role = 'buyer'");
    expect(sql).toContain("author_role = 'farmer'");
    expect(sql).toContain('auth.uid() = o.buyer_id');
    expect(sql).toContain('auth.uid() = o.farmer_id');
    expect(sql).toContain("d.status <> 'resolved'");
  });
});

describe('20261126_security_fixes.sql — finding 6 (fabricated resolved dispute)', () => {
  test('rewritten INSERT policy requires filing state: status filed, resolution fields NULL, not escalated', () => {
    // Live check still pending: after applying, a PostgREST insert with
    // status='resolved' or any resolution field set must fail, while a
    // plain filing (status filed, future sla_deadline) must succeed.
    expect(sql).toContain('CREATE POLICY "Counterparties can file disputes."');
    expect(sql).toContain('ON public.disputes FOR INSERT');
    expect(sql).toContain("status = 'filed'");
    expect(sql).toContain('resolution IS NULL');
    expect(sql).toContain('resolution_amount_paise IS NULL');
    expect(sql).toContain('resolved_at IS NULL');
    expect(sql).toContain('resolved_by IS NULL');
    expect(sql).toContain('escalated = false');
    expect(sql).toContain('sla_deadline > now()');
  });
});

describe('20261126_security_fixes.sql — finding 11 DB part (per-user price-alert cap)', () => {
  test('alert-cap trigger exists with the 20-per-user limit', () => {
    // Live check still pending: after applying, a 21st price_alerts
    // insert for one user must raise ALERT_LIMIT_REACHED (check_violation)
    // while the first 20 succeed.
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.enforce_price_alert_cap()',
    );
    expect(sql).toContain(
      "IF (SELECT count(*) FROM public.price_alerts WHERE user_id = NEW.user_id) >= 20 THEN",
    );
    expect(sql).toContain("RAISE EXCEPTION 'ALERT_LIMIT_REACHED'");
    expect(sql).toContain("ERRCODE = 'check_violation'");
    expect(sql).toContain(
      'CREATE TRIGGER enforce_price_alert_cap BEFORE INSERT ON public.price_alerts',
    );
    expect(sql).toContain(
      'FOR EACH ROW EXECUTE FUNCTION public.enforce_price_alert_cap()',
    );
  });
});
