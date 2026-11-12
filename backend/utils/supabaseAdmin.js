'use strict';
// Service-role Supabase client for backend-only writes (storage uploads,
// auth lookups). Bypasses RLS by design — never expose it to the frontend,
// and never use it to serve user-scoped reads that RLS should gate.
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = supabaseAdmin;
