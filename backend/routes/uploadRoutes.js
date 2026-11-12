'use strict';
// Image uploads (Stage 0, H2). The browser used to upload straight to the
// Supabase storage bucket, so any authenticated user could push any content
// type to any path. Now the file goes through this endpoint: requireAuth
// first, then server-side MIME + magic-byte + size checks, then the
// service-role client stores it under the caller's own path prefix:
// product-items/<uid>-<uuid>.<ext>, profile-<uid>-<ts>.<ext>, or
// verification-docs/<uid>-<uuid>.<ext> (Stage 1, kind=verification).
// SVG/HTML are rejected by the magic-byte check (they are text, not one of
// the three image signatures) and by the content-type allowlist.
// Body is express.raw() (mounted in server.js, 5 MB limit); no multipart
// dependency is needed because the frontend posts the file as the raw body.
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const supabaseAdmin = require('../utils/supabaseAdmin');
const { AppError } = require('../utils/errors');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Magic-byte signatures: JPEG, PNG, WebP (RIFF....WEBP).
const IMAGE_SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/webp', ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], trailer: [0x57, 0x45, 0x42, 0x50], trailerAt: 8 },
];

// The declared content type proves nothing on its own — the bytes decide.
// Returns { mime, ext } or throws a 415/422 AppError.
function validateImageBuffer(buffer, contentType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AppError(422, 'INVALID_IMAGE', 'No image data received.');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new AppError(413, 'IMAGE_TOO_LARGE', 'Image must be 5 MB or smaller.');
  }
  // Text-based payloads (SVG, HTML, scripts) can never be a photo: reject
  // before the signature check so the error names the real problem. Note
  // image/svg+xml starts with "image/" too — the allowlist must be exact.
  if (contentType && !['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
    throw new AppError(415, 'UNSUPPORTED_IMAGE_TYPE', 'Only JPEG, PNG or WebP images are allowed.');
  }
  for (const sig of IMAGE_SIGNATURES) {
    const head = buffer.subarray(0, sig.bytes.length);
    if (!head.equals(Buffer.from(sig.bytes))) continue;
    if (sig.trailer && !buffer.subarray(sig.trailerAt, sig.trailerAt + 4).equals(Buffer.from(sig.trailer))) continue;
    if (contentType && contentType !== sig.mime) {
      throw new AppError(415, 'UNSUPPORTED_IMAGE_TYPE', 'Declared image type does not match the file contents.');
    }
    return { mime: sig.mime, ext: sig.ext };
  }
  throw new AppError(422, 'INVALID_IMAGE', 'File is not a JPEG, PNG or WebP image.');
}

// POST /api/uploads/image?kind=product|profile|verification
router.post('/image', requireAuth, async (req, res, next) => {
  try {
    const kind = ['product', 'profile', 'verification'].includes(req.query.kind)
      ? req.query.kind
      : 'product';
    const { mime, ext } = validateImageBuffer(req.body, req.headers['content-type']);
    // Path shapes (the storage RLS policies allowlist the same prefixes):
    // product: product-items/<uid>-<uuid>.<ext>
    // profile: profile-<uid>-<timestamp>.<ext>
    // verification: verification-docs/<uid>-<uuid>.<ext>
    const path = kind === 'profile'
      ? `profile-${req.user.id}-${Date.now()}.${ext}`
      : kind === 'verification'
        ? `verification-docs/${req.user.id}-${crypto.randomUUID()}.${ext}`
        : `product-items/${req.user.id}-${crypto.randomUUID()}.${ext}`;

    const { error } = await supabaseAdmin.storage
      .from('product-images')
      .upload(path, req.body, { contentType: mime, upsert: false });
    if (error) throw new AppError(500, 'UPLOAD_FAILED', 'Image upload failed. Please try again.');

    const { data } = supabaseAdmin.storage.from('product-images').getPublicUrl(path);
    return res.status(201).json({ publicUrl: data.publicUrl, path });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports.validateImageBuffer = validateImageBuffer;
module.exports.MAX_IMAGE_BYTES = MAX_IMAGE_BYTES;
