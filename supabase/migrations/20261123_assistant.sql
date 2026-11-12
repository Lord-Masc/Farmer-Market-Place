-- Stage 8, module G — AI Farmer Assistant (2026-11-12):
-- assistant_conversations — one row per conversation, holding the
-- whole message history as jsonb (appended on every chat call).
--
-- WHAT THIS FILE DOES
--  1. assistant_conversations: id uuid PK, user_id uuid NOT NULL
--     REFERENCES auth.users (the chatter), messages jsonb NOT NULL
--     DEFAULT '[]' (the turn history: { role: 'user' | 'assistant',
--     content, intent, sources, no_data, at } per turn), sources jsonb
--     (the LATEST assistant turn's sources[], mirrored here so a
--     reader can see what the last answer was grounded in without
--     parsing the history), created_at / updated_at timestamptz.
--     A "no data" answer is stored HONESTLY: sources is [] and the
--     assistant turn carries no_data: true — the log never pretends
--     an ungrounded answer had a source. The service must never store
--     an answer whose sources[] is empty for a data-backed intent.
--  2. RLS: enabled. A user reads / inserts / updates ONLY their own
--     rows (auth.uid() = user_id). An admin reads all rows via the
--     Stage 1 is_admin() SECURITY DEFINER helper. No anon access:
--     there is no policy for the anon role at all. Deletes go through
--     the backend (service role) only — no DELETE policy.
--
-- APPLY ORDER: after 20261116_trust_foundation.sql (it defines
-- is_admin()). FILE ONLY — apply in the Supabase SQL Editor.
-- Rollback: DROP TABLE public.assistant_conversations.
-- NOTE: the Stage 3 mandi_prices table does NOT exist yet — nothing
-- here references it.

CREATE TABLE IF NOT EXISTS public.assistant_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  sources jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.assistant_conversations ENABLE ROW LEVEL SECURITY;

-- A user reads only their own conversations.
CREATE POLICY "Users read their own conversations"
  ON public.assistant_conversations FOR SELECT
  USING (auth.uid() = user_id);

-- A user starts only their own conversations.
CREATE POLICY "Users insert their own conversations"
  ON public.assistant_conversations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- A user appends turns only to their own conversations.
CREATE POLICY "Users update their own conversations"
  ON public.assistant_conversations FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Admins read every conversation (support / abuse review) via the
-- Stage 1 is_admin() helper. No INSERT/UPDATE/DELETE for admins
-- through PostgREST — writes go through the backend (service role).
CREATE POLICY "Admins read all conversations"
  ON public.assistant_conversations FOR SELECT
  USING (public.is_admin());

-- No anon policy: anonymous callers see nothing.
