-- Stage 2, unit C — hardening (2026-11-12): verification documents move
-- out of the PUBLIC product-images bucket into a PRIVATE bucket.
--
-- THE PROBLEM
--  Stage 1 stored verification (identity) documents in the public
--  product-images bucket at verification-docs/<uid>-<uuid>.<ext> and the
--  admin queue built a public URL for them — anyone with the URL could
--  view an identity document, no login required.
--
-- WHAT THIS FILE DOES
--  Removes the verification-docs/ branches from the THREE product-images
--  storage policies (INSERT / UPDATE / DELETE) so a direct browser upload
--  can no longer target verification-docs/ in the public bucket. The
--  backend now uploads kind=verification to the private 'verification-docs'
--  bucket instead, and admins view documents through a 5-minute signed
--  URL (GET /api/admin/verifications/:id/document).
--
-- THE PRIVATE BUCKET — DASHBOARD STEPS (bucket creation is not SQL)
--  1. Supabase Dashboard → project prrshenqceqijkfapthl → Storage.
--  2. "New bucket" → name exactly: verification-docs
--  3. Leave "Public bucket" OFF (Private) → Create bucket.
--  4. Do NOT add any storage policy on it afterwards.
--
-- NO POLICIES ON THE PRIVATE BUCKET — DELIBERATE
--  With no storage policies, direct browser access (PostgREST / Storage
--  API with a user JWT) is denied for everyone. Only the service-role key
--  — i.e. the backend, which uploads and mints signed URLs — can touch
--  the bucket. That is the whole point: a leaked path is useless without
--  a fresh admin-minted signed URL.
--
-- ZERO LEGACY DOCUMENTS
--  Stage 1 NEVER went live, so zero verification documents exist in
--  production — there are no legacy files to move. If a verification-docs/
--  object is ever found in product-images, delete it via the Dashboard
--  (Storage → product-images → select → Delete); do NOT serve it.
--
-- FILE ONLY — apply in the Supabase SQL Editor, after
-- 20261116_trust_foundation.sql. Either order vs
-- 20261117_crop_passport.sql works (the files touch different objects).
-- Never run by this stage.
--
-- ROLLBACK
--  Re-create the three policies WITH the verification-docs/ branches
--  (the Stage 1 shape from 20261116_trust_foundation.sql, section 6),
--  delete the private bucket in the Dashboard, and revert the backend +
--  frontend to the Stage 1 upload/public-URL behaviour in the same change.
--  Rolling back the policies alone re-exposes documents publicly, so
--  never roll back the SQL without also reverting the code. Full text:
--    DROP POLICY IF EXISTS "Owners can upload their own product-images." ON storage.objects;
--    CREATE POLICY "Owners can upload their own product-images."
--      ON storage.objects FOR INSERT TO authenticated
--      WITH CHECK (
--        bucket_id = 'product-images'
--        AND (
--          name LIKE 'product-items/' || auth.uid()::text || '-%'
--          OR name LIKE 'profile-' || auth.uid()::text || '-%'
--          OR name LIKE 'verification-docs/' || auth.uid()::text || '-%'
--        )
--      );
--    DROP POLICY IF EXISTS "Owners can update their own product-images." ON storage.objects;
--    CREATE POLICY "Owners can update their own product-images."
--      ON storage.objects FOR UPDATE TO authenticated
--      USING (
--        bucket_id = 'product-images'
--        AND (
--          name LIKE 'product-items/' || auth.uid()::text || '-%'
--          OR name LIKE 'profile-' || auth.uid()::text || '-%'
--          OR name LIKE 'verification-docs/' || auth.uid()::text || '-%'
--        )
--      )
--      WITH CHECK (
--        bucket_id = 'product-images'
--        AND (
--          name LIKE 'product-items/' || auth.uid()::text || '-%'
--          OR name LIKE 'profile-' || auth.uid()::text || '-%'
--          OR name LIKE 'verification-docs/' || auth.uid()::text || '-%'
--        )
--      );
--    DROP POLICY IF EXISTS "Owners can delete their own product-images." ON storage.objects;
--    CREATE POLICY "Owners can delete their own product-images."
--      ON storage.objects FOR DELETE TO authenticated
--      USING (
--        bucket_id = 'product-images'
--        AND (
--          name LIKE 'product-items/' || auth.uid()::text || '-%'
--          OR name LIKE 'profile-' || auth.uid()::text || '-%'
--          OR name LIKE 'verification-docs/' || auth.uid()::text || '-%'
--        )
--      );

-- INSERT: only the owner, only under their own prefix (no verification-docs/).
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
