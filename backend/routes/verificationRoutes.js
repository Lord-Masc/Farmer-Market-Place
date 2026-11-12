'use strict';
// Farmer verification submission (Stage 1, trust foundation). Mounted at
// /api/verification. requireAuth only — the farmer-role check lives in the
// service (submitVerification), keyed off req.user.id; the body only names
// the document the farmer already uploaded via ?kind=verification.
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const verificationService = require('../services/verificationService');

router.use(requireAuth);

// File a verification. Body: { document_path: 'verification-docs/<uid>-<uuid>.<ext>' }
router.post('/submit', async (req, res, next) => {
  try {
    const row = await verificationService.submitVerification(
      req.user.id,
      req.body && req.body.document_path,
    );
    return res.status(201).json(row);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
