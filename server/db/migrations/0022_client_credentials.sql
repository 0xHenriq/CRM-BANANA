-- The password hub.
--
-- Read 0002_rls.sql and 0014_closed_portal_closes_workspace.sql first.
--
-- Why this exists
-- ---------------
-- Sofia: "can we put a section for password hub - client can fill in social
-- media passwords". An agency cannot post to a client's Instagram without the
-- login, and today those arrive by WhatsApp message and live there forever —
-- in a chat backup, on two phones, searchable by anyone who picks one up. A
-- box inside the portal the client already signs into is strictly better than
-- the status quo, and the status quo is the thing being replaced.
--
-- What is stored, and how
-- -----------------------
-- The secret is ENCRYPTED BEFORE IT REACHES POSTGRES, with AES-256-GCM and a
-- key that lives only in the environment (CREDENTIALS_SECRET). This column
-- therefore holds ciphertext, and that is not decoration:
--
--   * `backup.sh` writes a nightly pg_dump to disk and this repository's own
--     rules say to copy it to a laptop. A plaintext password column would put
--     every client's social logins in a file sitting in ~/Documents.
--   * bd_owner and anyone with psql can read every row. RLS binds bd_app, not
--     the owner, and migrations run as the owner.
--   * A SELECT that leaks — the class of bug this whole schema is arranged to
--     prevent — leaks ciphertext rather than credentials.
--
-- The key is NOT BETTER_AUTH_SECRET. Rotating that logs everyone out, which is
-- a recoverable inconvenience; rotating it must not also destroy every stored
-- password, which is not recoverable at all. Without CREDENTIALS_SECRET the
-- routes refuse to store or reveal anything and say so — the same shape as
-- Stripe's missing keys, and for the same reason: refusing is honest, and
-- storing plaintext "for now" is how plaintext becomes permanent.
--
-- Class 2: client-visible, and client-WRITABLE. That is the feature — she
-- asked for the client to fill these in themselves, and a box only she can
-- type into would still leave the password arriving by message first.
--
-- No reveal without asking for it. The list returns a masked hint; the
-- plaintext comes from its own endpoint, and every reveal writes an audit row.

CREATE TABLE client_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- Which account: 'Instagram', 'TikTok', 'Meta Business Suite'.
  label text NOT NULL,
  -- The handle or email that goes in the first box of that login screen.
  username text,
  -- AES-256-GCM ciphertext, or NULL where only a handle has been filled in.
  secret_cipher text,
  notes text,
  sort_order integer NOT NULL DEFAULT 0,
  updated_by text REFERENCES "user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX client_credentials_client_sort_idx
  ON client_credentials (client_id, sort_order);--> statement-breakpoint

ALTER TABLE client_credentials ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY client_credentials_select ON client_credentials FOR SELECT
  USING (app_is_staff() OR client_id IN (SELECT app_client_ids()));--> statement-breakpoint

CREATE POLICY client_credentials_insert ON client_credentials FOR INSERT
  WITH CHECK (app_is_staff() OR client_id IN (SELECT app_client_ids()));--> statement-breakpoint

-- Both arms, on both sides of the update.
--
-- Belt and braces, and stated as such rather than as the only thing holding:
-- Postgres also applies client_credentials_select to the NEW row of an UPDATE,
-- so moving a row into another workspace is refused even with WITH CHECK
-- (true). Verified by mutation against bd_portal_test — weakening either gate
-- alone still refuses the move; weakening both lets it through, which is what
-- makes the test for it non-vacuous. The arm stays because a rule that depends
-- on a subtlety of how UPDATE composes with SELECT policies is a rule nobody
-- reading this file would know was there.
CREATE POLICY client_credentials_update ON client_credentials FOR UPDATE
  USING (app_is_staff() OR client_id IN (SELECT app_client_ids()))
  WITH CHECK (app_is_staff() OR client_id IN (SELECT app_client_ids()));--> statement-breakpoint

-- The client may delete their own. They typed it in; a hub they can add to and
-- not correct fills up with dead logins nobody dares remove.
CREATE POLICY client_credentials_delete ON client_credentials FOR DELETE
  USING (app_is_staff() OR client_id IN (SELECT app_client_ids()));
