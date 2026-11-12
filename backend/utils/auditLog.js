'use strict';
// Append-only audit log (Stage 1 wiring for the Stage 0 audit_log table).
// Every escrow state transition and every trust decision writes one row
// via the service-role client (the table has no policies by design — only
// the service role inserts, and rows can never be updated or deleted
// through the API). The write is best effort by design: an audit failure
// must never break the transition it records, so errors are logged
// server-side and swallowed — callers never see them.
const supabaseAdmin = require('./supabaseAdmin');

async function logAudit(actorId, event, details = {}) {
  try {
    const { error } = await supabaseAdmin
      .from('audit_log')
      .insert({ actor_id: actorId || null, event, details });
    if (error) console.error('Audit log insert failed:', error.message);
  } catch (err) {
    console.error('Audit log insert failed:', err.message);
  }
}

module.exports = { logAudit };
