-- Stage 0, unit 6 (H2): storage RLS for the product-images bucket.
-- Before this file the bucket had NO storage policies at all: any
-- authenticated user could write any path (including overwriting another
-- user's product photo) and upload any content type.
-- Uploads now go through the backend endpoint (POST /api/uploads/image),
-- which validates MIME/magic bytes/size server-side and uploads with the
-- service-role key (bypasses RLS). These policies are the second layer:
-- they bind any DIRECT browser upload to the caller's own path prefix.
-- Path shapes in use: product-items/<uid>-<random>.<ext> (product photos)
-- and profile-<uid>-<timestamp>.<ext> (avatars).
-- FILE ONLY — apply in the Supabase SQL Editor; never run by this stage.
-- NOTE: the bucket must stay PUBLIC for getPublicUrl() to serve images;
-- that is a dashboard setting, not a migration. Rollback: drop the four
-- policies below (see docs/ai/ROLLBACK.md, unit 6).

-- INSERT: only the owner, only under their own prefix.
DROP POLICY IF EXISTS "Owners can upload their own product-images." ON storage.objects;
CREATE POLICY "Owners can upload their own product-images."
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'product-images'
    AND (
      name LIKE 'product-items/' || auth.uid()::text || '-%'
      OR name LIKE 'profile-' || auth.uid()::text || '-%'
    )
  );

-- UPDATE: only the owner, and the new row must still be theirs.
DROP POLICY IF EXISTS "Owners can update their own product-images." ON storage.objects;
CREATE POLICY "Owners can update their own product-images."
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'product-images'
    AND (
      name LIKE 'product-items/' || auth.uid()::text || '-%'
      OR name LIKE 'profile-' || auth.uid()::text || '-%'
    )
  )
  WITH CHECK (
    bucket_id = 'product-images'
    AND (
      name LIKE 'product-items/' || auth.uid()::text || '-%'
      OR name LIKE 'profile-' || auth.uid()::text || '-%'
    )
  );

-- DELETE: only the owner.
DROP POLICY IF EXISTS "Owners can delete their own product-images." ON storage.objects;
CREATE POLICY "Owners can delete their own product-images."
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'product-images'
    AND (
      name LIKE 'product-items/' || auth.uid()::text || '-%'
      OR name LIKE 'profile-' || auth.uid()::text || '-%'
    )
  );
