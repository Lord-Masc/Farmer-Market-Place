'use strict';
// Notification delivery worker (Stage 9, module H). Follows the Stage 0
// reconciler's scheduling pattern (server.js cron) — run often, every
// row re-checked from live state, never invent a delivery.
//
// processPending(supabase, adapters, { now, limit }) drives the rows
// emit() left 'pending' (email/sms) plus rows deferred by quiet hours:
//   - Batch: pending/deferred rows, oldest first, limit 50. The due
//     predicate (next_attempt_at NULL or <= now) is IN the query, so
//     the limit applies to due rows only — 50 not-yet-due rows can no
//     longer starve a due row out of the batch. The in-memory `due`
//     filter below stays as a backstop. A deferred row's
//     next_attempt_at is the quiet-end, and it must be picked up again
//     once due. A row whose next_attempt_at is still in the future is
//     skipped, never attempted early.
//   - In-app rows are 'sent' immediately with NO adapter call (the
//     inbox IS the delivery; emit already marks them 'sent', this
//     covers any row left pending by a replay).
//   - Preferences are RE-CHECKED before every attempt: if the user
//     opted out after emit, the row stays visible in the inbox (it was
//     emitted) but the outbound attempt is skipped — in_app rows go
//     'sent', email/sms rows go 'failed' with
//     payload.delivery_code = 'OPTED_OUT'. Nothing is deleted.
//   - Quiet hours (UTC wall-clock — Render runs UTC; the frontend
//     labels them as such): the row goes 'deferred' with
//     next_attempt_at at the next quiet_end, attempts unchanged, and
//     NO delivery is attempted inside them.
//   - Otherwise the channel's adapter is called with the recipient's
//     contact from profiles (email_address for email, phone_number for
//     sms). No contact on file is an honest failure
//     (NO_CONTACT_ON_FILE), not a silent skip.
//   - Adapter failure: attempts + 1, next_attempt_at = now +
//     2^attempts minutes (2, 4, 8 ...). After MAX_DELIVERY_ATTEMPTS
//     (3) the row is 'failed' with the adapter's code in
//     payload.delivery_code — never silently dropped, never 'sent'.
//     A row with no configured provider ends 'failed' with
//     PROVIDER_NOT_CONFIGURED the same way.
// startWorker(intervalMs) runs processPending on a timer with an
// overlap guard; server.js schedules the same work via node-cron.
const supabaseAdmin = require('../utils/supabaseAdmin');
const emailAdapter = require('../services/delivery/emailAdapter');
const smsAdapter = require('../services/delivery/smsAdapter');
const { MAX_DELIVERY_ATTEMPTS } = require('../services/notificationService');

function getDefaultAdapters() {
  return { email: emailAdapter, sms: smsAdapter };
}

// 'HH:MM' (or 'HH:MM:SS' as Postgres time returns) -> minutes past midnight.
function timeToMinutes(value) {
  const parts = String(value).split(':').map(Number);
  return parts[0] * 60 + parts[1];
}

// Quiet hours are a wall-clock window; an overnight window (22:00-07:00)
// wraps midnight. End is exclusive: at quiet_end exactly, delivery resumes.
function isInQuietHours(now, quietStart, quietEnd) {
  if (!quietStart || !quietEnd) return false;
  const start = timeToMinutes(quietStart);
  const end = timeToMinutes(quietEnd);
  const at = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (start <= end) return at >= start && at < end;
  return at >= start || at < end;
}

// The next occurrence of quiet_end (UTC) strictly after `now`.
function nextQuietEnd(now, quietEnd) {
  const end = timeToMinutes(quietEnd);
  const candidate = new Date(now);
  candidate.setUTCHours(Math.floor(end / 60), end % 60, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}

function backoffDelayMs(attempts) {
  return Math.pow(2, attempts) * 60 * 1000;
}

async function markRow(supabase, row, fields) {
  const { error } = await supabase
    .from('notifications').update(fields).eq('id', row.id);
  if (error) console.error(`Notification worker update failed for ${row.id}:`, error.message);
}

async function failRow(supabase, row, now, code, counts) {
  const attempts = (row.attempts || 0) + 1;
  if (attempts >= MAX_DELIVERY_ATTEMPTS) {
    await markRow(supabase, row, {
      attempts,
      delivery_status: 'failed',
      payload: { ...(row.payload || {}), delivery_code: code },
    });
    counts.failed += 1;
  } else {
    await markRow(supabase, row, {
      attempts,
      next_attempt_at: new Date(now.getTime() + backoffDelayMs(attempts)).toISOString(),
      payload: { ...(row.payload || {}), delivery_code: code },
    });
  }
}

async function processPending(supabase, adapters, opts = {}) {
  const client = supabase || supabaseAdmin;
  const channelAdapters = { ...getDefaultAdapters(), ...(adapters || {}) };
  const now = opts.now ? new Date(opts.now) : new Date();
  const limit = opts.limit || 50;
  const counts = { processed: 0, sent: 0, failed: 0, deferred: 0, skipped: 0 };
  try {
    const { data: rows, error } = await client
      .from('notifications').select('*')
      .in('delivery_status', ['pending', 'deferred'])
      .or(`next_attempt_at.is.null,next_attempt_at.lte.${now.toISOString()}`)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) {
      console.error('Notification worker fetch failed:', error.message);
      return counts;
    }
    const due = (rows || []).filter(
      (r) => !r.next_attempt_at || new Date(r.next_attempt_at).getTime() <= now.getTime(),
    );
    counts.processed = due.length;
    for (const row of due) {
      try {
        // Re-check preferences: the user may have opted out since emit.
        const { data: prefs } = await client
          .from('notification_preferences').select('*')
          .eq('user_id', row.user_id).eq('event_type', row.type);
        const pref = prefs && prefs[0];
        const optedOut = !!pref && (pref.enabled === false
          || (Array.isArray(pref.channels) && !pref.channels.includes(row.channel)));
        if (optedOut) {
          if (row.channel === 'in_app') {
            await markRow(client, row, { delivery_status: 'sent' });
            counts.sent += 1;
          } else {
            await markRow(client, row, {
              delivery_status: 'failed',
              payload: { ...(row.payload || {}), delivery_code: 'OPTED_OUT' },
            });
            counts.failed += 1;
          }
          continue;
        }

        // Quiet hours: defer, never attempt inside them.
        if (pref && isInQuietHours(now, pref.quiet_start, pref.quiet_end)) {
          await markRow(client, row, {
            delivery_status: 'deferred',
            next_attempt_at: nextQuietEnd(now, pref.quiet_end).toISOString(),
          });
          counts.deferred += 1;
          continue;
        }

        // The inbox IS the delivery for in_app — no adapter call.
        if (row.channel === 'in_app') {
          await markRow(client, row, { delivery_status: 'sent' });
          counts.sent += 1;
          continue;
        }

        const adapter = channelAdapters[row.channel];
        if (!adapter) {
          await failRow(client, row, now, 'PROVIDER_NOT_CONFIGURED', counts);
          continue;
        }

        // The recipient's contact comes from their profile row.
        const { data: profiles } = await client
          .from('profiles').select('email_address,phone_number').eq('id', row.user_id);
        const profile = profiles && profiles[0];
        const to = row.channel === 'email'
          ? (profile && profile.email_address)
          : (profile && profile.phone_number);
        if (!to) {
          await failRow(client, row, now, 'NO_CONTACT_ON_FILE', counts);
          continue;
        }

        let result;
        try {
          result = await adapter.send({ notification: row, to });
        } catch (err) {
          result = { ok: false, code: (err && err.code) || 'ADAPTER_ERROR' };
        }
        if (result && result.ok) {
          await markRow(client, row, {
            attempts: (row.attempts || 0) + 1,
            delivery_status: 'sent',
          });
          counts.sent += 1;
        } else {
          await failRow(client, row, now, (result && result.code) || 'ADAPTER_ERROR', counts);
        }
      } catch (err) {
        console.error(`Notification worker failed for row ${row.id}:`, err.message);
        counts.skipped += 1;
      }
    }
  } catch (err) {
    console.error('Notification worker error:', err.message);
  }
  return counts;
}

function startWorker(intervalMs = 5 * 60 * 1000) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const counts = await processPending();
      console.log('Notification delivery result:', counts);
    } catch (err) {
      console.error('Notification worker error:', err.message);
    } finally {
      running = false;
    }
  }, intervalMs);
  return timer;
}

module.exports = {
  processPending,
  startWorker,
  isInQuietHours,
  nextQuietEnd,
  backoffDelayMs,
  getDefaultAdapters,
};
