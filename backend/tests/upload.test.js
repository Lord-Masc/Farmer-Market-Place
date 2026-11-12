'use strict';
/**
 * Image-upload validation (Stage 0, H2): the backend endpoint must reject
 * anything that is not really a JPEG/PNG/WebP — the browser's MIME type is
 * attacker-controlled, so the magic bytes decide. SVG/HTML are text and can
 * never match an image signature.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: {}, storage: {} }),
}));

const { validateImageBuffer, MAX_IMAGE_BYTES } = require('../routes/uploadRoutes');

function buf(...bytes) {
  return Buffer.from(bytes);
}

describe('validateImageBuffer', () => {
  test('valid JPEG header passes', () => {
    const r = validateImageBuffer(buf(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10), 'image/jpeg');
    expect(r).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
  });

  test('valid PNG header passes', () => {
    const r = validateImageBuffer(buf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00), 'image/png');
    expect(r).toEqual({ mime: 'image/png', ext: 'png' });
  });

  test('valid WebP header (RIFF....WEBP) passes', () => {
    const r = validateImageBuffer(Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1'), 'image/webp');
    expect(r).toEqual({ mime: 'image/webp', ext: 'webp' });
  });

  test('RIFF without WEBP trailer is rejected', () => {
    expect(() => validateImageBuffer(Buffer.from('RIFF\x24\x00\x00\x00AVI ', 'latin1'), 'image/webp'))
      .toThrow(expect.objectContaining({ status: 422 }));
  });

  test('declared type must match the bytes', () => {
    expect(() => validateImageBuffer(buf(0xff, 0xd8, 0xff), 'image/png'))
      .toThrow(expect.objectContaining({ status: 415 }));
  });

  test('SVG text is rejected even with an image content type', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(() => validateImageBuffer(svg, 'image/svg+xml'))
      .toThrow(expect.objectContaining({ status: 415 }));
    expect(() => validateImageBuffer(svg, 'image/jpeg'))
      .toThrow(expect.objectContaining({ status: 422 }));
  });

  test('HTML text is rejected', () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    expect(() => validateImageBuffer(html, 'text/html'))
      .toThrow(expect.objectContaining({ status: 415 }));
    expect(() => validateImageBuffer(html, 'image/png'))
      .toThrow(expect.objectContaining({ status: 422 }));
  });

  test('empty buffer is rejected', () => {
    expect(() => validateImageBuffer(Buffer.alloc(0), 'image/jpeg'))
      .toThrow(expect.objectContaining({ status: 422 }));
  });

  test('truncated PNG signature is rejected', () => {
    expect(() => validateImageBuffer(buf(0x89, 0x50, 0x4e, 0x47), 'image/png'))
      .toThrow(expect.objectContaining({ status: 422 }));
  });

  test('oversize buffer is rejected with 413', () => {
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
    expect(() => validateImageBuffer(big, 'image/jpeg'))
      .toThrow(expect.objectContaining({ status: 413 }));
  });

  test('exactly 5 MB of valid JPEG passes the size check', () => {
    const exact = Buffer.alloc(MAX_IMAGE_BYTES);
    exact[0] = 0xff; exact[1] = 0xd8; exact[2] = 0xff;
    expect(validateImageBuffer(exact, 'image/jpeg').ext).toBe('jpg');
  });
});
