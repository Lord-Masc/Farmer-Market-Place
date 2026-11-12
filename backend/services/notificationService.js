'use strict';
// Notification service (Stage 9, module H) — the in-app inbox is the
// core, and it works fully with zero providers.
//
// emit({ eventId, type, userIds, payload, channels?, includeAdmins? })
// fans an event out to one row per (user, channel the user enabled):
//   - Preferences are read at emit time (service role). A missing
//     preference row means the defaults: in_app only, enabled,
//     language 'hi', no quiet hours. An opted-out event type creates
//     NO row for that user. `channels`, when given, is the candidate
//     set; otherwise every channel the user enabled is a candidate.
//   - dedupe_key is eventId:userId:channel with a UNIQUE backstop —
//     a retry/replay of the same event inserts the same key, hits the
//     unique violation, and is treated as already-emitted (zero new
//     rows), never a duplicate.
//   - In-app rows are 'sent' as soon as they are created (the inbox
//     IS the delivery). Email/sms rows start 'pending' for the worker.
//   - Best-effort, like auditLog: emit NEVER throws into the business
//     flow. A missing table, a failed preference read, or a failed
//     insert is logged server-side and swallowed — the transition
//     that emitted the event already succeeded.
// Admin recipients (dispute_filed, verification_submitted): pass
// includeAdmins: true and the service resolves users with
// role='admin' via the service role; zero admins = no admin rows,
// by design (same as Stage 1 — the system works with zero admins).
// A partial refund does NOT emit 'refunded' (the dispute_resolved
// notification covers it); only a full refund completing through the
// Stage 0 path emits it — see escrowService.completeRefundStatuses.
const supabaseAdmin = require('../utils/supabaseAdmin');
const { AppError } = require('../utils/errors');
const { EVENT_TYPES, CHANNELS, buildTemplate } = require('./notificationTemplates');

const DEFAULT_CHANNELS = ['in_app'];
const DEFAULT_LANGUAGE = 'hi';
const MAX_DELIVERY_ATTEMPTS = 3;

function isDuplicateKey(error) {
  return !!error && (error.code === '23505'
    || String(error.message || '').includes('duplicate key'));
}

function publicNotification(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    payload: row.payload,
    channel: row.channel,
    delivery_status: row.delivery_status,
    next_attempt_at: row.next_attempt_at,
    read_at: row.read_at,
    created_at: row.created_at,
  };
}

function publicPreference(row) {
  return {
    event_type: row.event_type,
    enabled: row.enabled,
    channels: row.channels,
    language: row.language,
    quiet_start: row.quiet_start,
    quiet_end: row.quiet_end,
  };
}

async function listAdminIds() {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles').select('id').eq('role', 'admin');
    if (error || !data) return [];
    return data.map((r) => r.id).filter(Boolean);
  } catch (err) {
    console.error('Notification admin lookup failed:', err.message);
    return [];
  }
}

// Preference rows for a set of users, as userId -> Map(eventType -> row).
// A failed read falls back to "no rows" (the defaults) rather than
// dropping the emit — the emit must survive a preferences outage.
async function readPreferences(userIds) {
  const byUser = new Map();
  try {
    const { data, error } = await supabaseAdmin
      .from('notification_preferences').select('*').in('user_id', userIds);
    if (error || !data) return byUser;
    for (const row of data) {
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, new Map());
      byUser.get(row.user_id).set(row.event_type, row);
    }
  } catch (err) {
    console.error('Notification preference read failed:', err.message);
  }
  return byUser;
}

async function emit(args = {}) {
  try {
    const {
      eventId, type, userIds = [], payload = {}, channels, includeAdmins = false,
    } = args;
    if (!eventId || !EVENT_TYPES.includes(type)) return [];
    let recipients = [...new Set((userIds || []).filter(Boolean))];
    if (includeAdmins) {
      recipients = [...new Set([...recipients, ...(await listAdminIds())])];
    }
    if (recipients.length === 0) return [];
    const prefsByUser = await readPreferences(recipients);
    const created = [];
    for (const userId of recipients) {
      const pref = (prefsByUser.get(userId) || new Map()).get(type);
      if (pref && pref.enabled === false) continue;
      const enabledChannels = pref && Array.isArray(pref.channels) && pref.channels.length > 0
        ? pref.channels.filter((c) => CHANNELS.includes(c))
        : DEFAULT_CHANNELS;
      const wanted = channels && channels.length > 0
        ? channels.filter((c) => CHANNELS.includes(c))
        : CHANNELS;
      const language = (pref && pref.language) || DEFAULT_LANGUAGE;
      const { title, body } = buildTemplate(type, language, payload);
      for (const channel of wanted) {
        if (!enabledChannels.includes(channel)) continue;
        const dedupeKey = `${eventId}:${userId}:${channel}`;
        const { error } = await supabaseAdmin.from('notifications').insert({
          user_id: userId,
          type,
          title,
          body,
          payload,
          read_at: null,
          channel,
          delivery_status: channel === 'in_app' ? 'sent' : 'pending',
          dedupe_key: dedupeKey,
          attempts: 0,
          next_attempt_at: null,
        }).select('*');
        if (error) {
          // A replay hits the dedupe_key UNIQUE backstop: already
          // emitted, not an error worth surfacing.
          if (isDuplicateKey(error)) continue;
          console.error('Notification insert failed:', error.message);
          continue;
        }
        created.push({ user_id: userId, type, channel, dedupe_key: dedupeKey });
      }
    }
    return created;
  } catch (err) {
    console.error('Notification emit failed:', err.message);
    return [];
  }
}

async function getPreferences(userId) {
  const { data, error } = await supabaseAdmin
    .from('notification_preferences').select('*').eq('user_id', userId);
  if (error) throw error;
  return (data || []).map(publicPreference);
}

function validatePreferenceRow(row) {
  if (!row || typeof row !== 'object') {
    throw new AppError(422, 'VALIDATION_ERROR', 'Each preference must be an object.');
  }
  if (!EVENT_TYPES.includes(row.event_type)) {
    throw new AppError(422, 'VALIDATION_ERROR', 'event_type must be a known notification type.');
  }
  if (row.enabled !== undefined && typeof row.enabled !== 'boolean') {
    throw new AppError(422, 'VALIDATION_ERROR', 'enabled must be a boolean.');
  }
  if (!Array.isArray(row.channels) || row.channels.length === 0
    || row.channels.some((c) => !CHANNELS.includes(c))) {
    throw new AppError(422, 'VALIDATION_ERROR', 'channels must be a non-empty subset of in_app, email, sms.');
  }
  if (row.language !== undefined && !['hi', 'en'].includes(row.language)) {
    throw new AppError(422, 'VALIDATION_ERROR', 'language must be hi or en.');
  }
  const timeRe = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  for (const key of ['quiet_start', 'quiet_end']) {
    if (row[key] !== undefined && row[key] !== null && !timeRe.test(row[key])) {
      throw new AppError(422, 'VALIDATION_ERROR', `${key} must be HH:MM or null.`);
    }
  }
}

async function upsertPreferences(userId, rows) {
  if (!Array.isArray(rows)) {
    throw new AppError(422, 'VALIDATION_ERROR', 'preferences must be an array.');
  }
  const saved = [];
  for (const row of rows) {
    validatePreferenceRow(row);
    const fields = {
      user_id: userId,
      event_type: row.event_type,
      enabled: row.enabled !== undefined ? row.enabled : true,
      channels: row.channels,
      language: row.language || DEFAULT_LANGUAGE,
      quiet_start: row.quiet_start === undefined ? null : row.quiet_start,
      quiet_end: row.quiet_end === undefined ? null : row.quiet_end,
    };
    const { data: existing, error: readError } = await supabaseAdmin
      .from('notification_preferences').select('*')
      .eq('user_id', userId).eq('event_type', row.event_type);
    if (readError) throw readError;
    if (existing && existing.length > 0) {
      const { data: updated, error: updateError } = await supabaseAdmin
        .from('notification_preferences').update(fields)
        .eq('user_id', userId).eq('event_type', row.event_type).select('*');
      if (updateError) throw updateError;
      saved.push(publicPreference(updated[0]));
    } else {
      const { data: inserted, error: insertError } = await supabaseAdmin
        .from('notification_preferences').insert(fields).select('*');
      if (insertError) throw insertError;
      saved.push(publicPreference(inserted[0]));
    }
  }
  return saved;
}

async function markRead(userId, id) {
  const { data, error } = await supabaseAdmin
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', id).eq('user_id', userId).select('*');
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found.');
  }
  return publicNotification(data[0]);
}

async function listNotifications(userId, { unreadOnly = false, limit = 20, offset = 0 } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const start = Math.max(Number(offset) || 0, 0);
  let query = supabaseAdmin
    .from('notifications').select('*').eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (unreadOnly) query = query.is('read_at', null);
  const { data, error } = await query.range(start, start + pageSize - 1);
  if (error) throw error;
  const { data: unread, error: unreadError } = await supabaseAdmin
    .from('notifications').select('id').eq('user_id', userId).is('read_at', null);
  if (unreadError) throw unreadError;
  return {
    notifications: (data || []).map(publicNotification),
    unread_count: (unread || []).length,
  };
}

module.exports = {
  emit,
  getPreferences,
  upsertPreferences,
  markRead,
  listNotifications,
  listAdminIds,
  MAX_DELIVERY_ATTEMPTS,
};
