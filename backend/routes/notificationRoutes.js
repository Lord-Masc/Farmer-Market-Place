'use strict';
// Notifications & Communication (Stage 9, module H). Mounted at
// /api/notifications. Every route requires a verified JWT (requireAuth);
// the service enforces user-scoping (own rows only, 404 otherwise).
//
// GET / — the caller's inbox, newest first. Query: unread_only=true,
//   limit (default 20, max 100), offset (default 0). Returns
//   { notifications: [{ id, type, title, body, payload, channel,
//   delivery_status, read_at, created_at }], unread_count }.
//   Rate limit: 60 / 15 min.
// PATCH /:id/read — marks the caller's own row read (sets read_at).
//   Returns 200 { notification }; a foreign or missing id is 404.
//   Rate limit: 60 / 15 min.
// GET /preferences — the preference rows the caller has set (the
//   frontend renders defaults for missing event types: in_app only,
//   enabled, language 'hi', no quiet hours). Rate limit: 60 / 15 min.
// PATCH /preferences — body { preferences: [{ event_type, enabled,
//   channels, language, quiet_start, quiet_end }] }; upserts one row
//   per event type. Channels must be a subset of in_app/email/sms,
//   language hi/en, quiet times HH:MM or null (validated in the
//   service, 422 otherwise). Rate limit: 30 / 15 min.
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { rateLimit } = require('../middleware/security');
const { AppError } = require('../utils/errors');
const notificationService = require('../services/notificationService');

async function listHandler(req, res, next) {
  try {
    const unreadOnly = (req.query || {}).unread_only === 'true';
    const limit = Number.parseInt((req.query || {}).limit, 10) || 20;
    const offset = Number.parseInt((req.query || {}).offset, 10) || 0;
    const result = await notificationService.listNotifications(req.user.id, {
      unreadOnly, limit, offset,
    });
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
}

async function markReadHandler(req, res, next) {
  try {
    const notification = await notificationService.markRead(req.user.id, req.params.id);
    return res.status(200).json({ notification });
  } catch (err) {
    return next(err);
  }
}

async function getPreferencesHandler(req, res, next) {
  try {
    const preferences = await notificationService.getPreferences(req.user.id);
    return res.status(200).json({ preferences });
  } catch (err) {
    return next(err);
  }
}

async function updatePreferencesHandler(req, res, next) {
  try {
    const preferences = (req.body || {}).preferences;
    if (!Array.isArray(preferences)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'preferences must be an array.');
    }
    const saved = await notificationService.upsertPreferences(req.user.id, preferences);
    return res.status(200).json({ preferences: saved });
  } catch (err) {
    return next(err);
  }
}

router.get('/', rateLimit({ max: 60 }), requireAuth, listHandler);
router.patch('/:id/read', rateLimit({ max: 60 }), requireAuth, markReadHandler);
router.get('/preferences', rateLimit({ max: 60 }), requireAuth, getPreferencesHandler);
router.patch('/preferences', rateLimit({ max: 30 }), requireAuth, updatePreferencesHandler);

module.exports = router;
