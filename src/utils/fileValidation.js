// Shared validation for user-uploaded images (product photos, avatars).
// Storage accepts images only; anything else is rejected client-side
// before the upload starts so no invalid file reaches the bucket.

export const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Returns a human-readable error message, or null when the file is valid.
export function validateImageFile(file) {
  if (!file) return 'Please choose a file to upload.';
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return 'Please upload an image file (JPEG, PNG or WebP).';
  }
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    return 'Image must be 5 MB or smaller.';
  }
  return null;
}
