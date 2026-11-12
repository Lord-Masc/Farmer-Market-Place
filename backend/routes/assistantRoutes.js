'use strict';
// AI Farmer Assistant (Stage 8, module G). Mounted at /api/assistant.
// Every route requires a verified JWT (requireAuth); the service
// enforces ownership/counterparty per tool.
//
// POST /chat — structured chat. Body { message, conversation_id? }.
//   Returns { conversation_id, intent, entities, answer, sources[],
//   no_data }. The turn is persisted to assistant_conversations
//   (service role) by the service. Rate limit: 30 / 15 min.
// POST /voice — voice input. NO STT provider exists yet, so this
//   always answers 503 VOICE_NOT_CONFIGURED — never a fake
//   transcription. Accepts multipart/audio or JSON { audio_url }:
//   the input shape is validated first (400 on a missing audio
//   shape), then the unconfigured 503. Rate limit: 10 / 15 min.
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { rateLimit } = require('../middleware/security');
const { AppError } = require('../utils/errors');
const assistantService = require('../services/assistantService');

async function chatHandler(req, res, next) {
  try {
    const { message, conversation_id } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'message must be a non-empty string.');
    }
    if (typeof conversation_id !== 'undefined' && conversation_id !== null
      && typeof conversation_id !== 'string') {
      throw new AppError(400, 'VALIDATION_ERROR', 'conversation_id must be a string.');
    }
    const result = await assistantService.chat(req.user.id, message, conversation_id);
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
}

// No speech-to-text provider is configured (Rishabh's decision — see
// llmProvider.js). The shape is checked so a client sending nothing
// gets a 400, and a client sending real audio gets an honest 503.
async function voiceHandler(req, res, next) {
  try {
    const contentType = String((req.headers && req.headers['content-type']) || '').toLowerCase();
    const isAudioShape = contentType.includes('multipart/form-data')
      || contentType.includes('audio/')
      || (req.body && typeof req.body.audio_url === 'string' && req.body.audio_url.trim());
    if (!isAudioShape) {
      throw new AppError(400, 'VALIDATION_ERROR', 'audio input is required (multipart audio or { audio_url }).');
    }
    return res.status(503).json({
      error: 'Voice input is not configured yet. Please type your message instead.',
      code: 'VOICE_NOT_CONFIGURED',
    });
  } catch (err) {
    return next(err);
  }
}

router.post('/chat', rateLimit({ max: 30 }), requireAuth, chatHandler);
router.post('/voice', rateLimit({ max: 10 }), requireAuth, voiceHandler);

module.exports = router;
