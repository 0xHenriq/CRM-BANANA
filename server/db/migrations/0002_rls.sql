-- Row Level Security.
--
-- This file, not the application code, is what keeps one client from reading
-- another's data. Application-level scoping is a second layer; a forgotten
-- `where` clause here fails closed instead of leaking.
--
-- Read the design notes before editing:
--
--   * `current_setting('app.user_id')` RAISES when the setting is absent — it
--     does not return NULL. Every read goes through the helpers below, which
--     pass missing_ok = true, so an unset variable degrades to NULL and every
--     policy yields zero rows. Fail closed.
--
--   * FORCE ROW LEVEL SECURITY is deliberately NOT used. It would apply
--     policies to bd_owner too, breaking migrations and seeds for no real
--     gain: the app connects as bd_app, which is a non-owner with
--     rolbypassrls = false, so policies already bind. The protection against
--     someone pointing the app at bd_owner is a boot-time assertion in
--     server/db/guard.ts plus a test — both of which fail loudly, where FORCE
--     would only have failed confusingly.
--
--   * Session variables are applied with SET LOCAL semantics inside a
--     transaction (see withTenant), which is what makes this safe under
--     connection pooling.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_user_id() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '') $$;

CREATE OR REPLACE FUNCTION app_is_staff() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(nullif(current_setting('app.is_staff', true), '')::boolean, false) $$;

-- Reserved for v1.2 magic-link review. A review request has no signed-in user,
-- so app_user_id() is NULL and every client-visible policy below matches
-- nothing. When that feature lands, extend ONLY the four content_* policies
-- with `OR ... = app_review_content_id()` — and nothing else, so a review token
-- routed into the files or deals handler still returns zero rows.
CREATE OR REPLACE FUNCTION app_review_content_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.review_content_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION app_user_id() TO bd_app;
GRANT EXECUTE ON FUNCTION app_is_staff() TO bd_app;
GRANT EXECUTE ON FUNCTION app_review_content_id() TO bd_app;

-- ---------------------------------------------------------------------------
-- client_access — the root of the visibility graph
--
-- Every other policy subqueries this table, so its own policy must let a
-- client-role user read their OWN rows, or the subquery returns empty and the
-- portal shows nothing. The comparison is direct (user_id = app_user_id()),
-- never via a helper that reads client_access, so there is no recursion.
-- ---------------------------------------------------------------------------

ALTER TABLE client_access ENABLE ROW LEVEL SECURITY;

CREATE POLICY client_access_select ON client_access FOR SELECT
  USING (app_is_staff() OR user_id = app_user_id());

CREATE POLICY client_access_write ON client_access FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

-- ---------------------------------------------------------------------------
-- clients — a client may read the workspace record itself (name, branding),
-- but never write it, and never see clients they have no grant for.
-- ---------------------------------------------------------------------------

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY clients_select ON clients FOR SELECT
  USING (
    app_is_staff()
    OR id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id())
  );

CREATE POLICY clients_write ON clients FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

-- ---------------------------------------------------------------------------
-- Class 1: staff-only.
--
-- A `client_id`-only policy would have let a client read their OWN deals row —
-- exposing what she charges them, the stage, and her expected close date.
-- Same tenant, wrong audience. This is the case a generic policy passes.
-- ---------------------------------------------------------------------------

ALTER TABLE contacts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals        ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities   ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY contacts_staff ON contacts FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY deals_staff ON deals FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY activities_staff ON activities FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY audit_log_staff ON audit_log FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY review_links_staff ON review_links FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

-- ---------------------------------------------------------------------------
-- Class 2: client-visible.
--
-- Readable by staff and by users granted access to that client. Writes are
-- staff-only EXCEPT the three collaborative tables further down — the whole
-- point of the portal is that the client can talk back.
-- ---------------------------------------------------------------------------

ALTER TABLE links             ENABLE ROW LEVEL SECURITY;
ALTER TABLE files             ENABLE ROW LEVEL SECURITY;
ALTER TABLE moodboard_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_assets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE notice_posts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_comments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY links_select ON links FOR SELECT
  USING (app_is_staff() OR client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id()));
CREATE POLICY links_write ON links FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY files_select ON files FOR SELECT
  USING (app_is_staff() OR client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id()));
CREATE POLICY files_write ON files FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY moodboard_select ON moodboard_items FOR SELECT
  USING (app_is_staff() OR client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id()));
CREATE POLICY moodboard_write ON moodboard_items FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

-- Assets inherit their item's audience. content_items is column-gated below,
-- so an asset hanging off an invisible item is still reachable here — the
-- application must not surface assets for items it did not itself return.
-- v1.2's review-link work is the natural place to tighten this to a join.
CREATE POLICY content_assets_select ON content_assets FOR SELECT
  USING (app_is_staff() OR client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id()));
CREATE POLICY content_assets_write ON content_assets FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

-- Collaborative: clients may read and add, but only to their own workspace.
-- The WITH CHECK is what stops a client posting into someone else's board.
CREATE POLICY notice_posts_select ON notice_posts FOR SELECT
  USING (app_is_staff() OR client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id()));
CREATE POLICY notice_posts_insert ON notice_posts FOR INSERT
  WITH CHECK (app_is_staff() OR client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id()));
CREATE POLICY notice_posts_modify ON notice_posts FOR UPDATE
  USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY notice_posts_delete ON notice_posts FOR DELETE
  USING (app_is_staff());

CREATE POLICY content_comments_select ON content_comments FOR SELECT
  USING (app_is_staff() OR client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id()));
CREATE POLICY content_comments_insert ON content_comments FOR INSERT
  WITH CHECK (app_is_staff() OR client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id()));
CREATE POLICY content_comments_modify ON content_comments FOR UPDATE
  USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY content_comments_delete ON content_comments FOR DELETE
  USING (app_is_staff());

-- Approvals are append-only for EVERYONE, staff included: there is no UPDATE
-- or DELETE policy, so those operations match nothing and affect zero rows.
-- An approval is a record of what happened, not a mutable status field.
CREATE POLICY content_approvals_select ON content_approvals FOR SELECT
  USING (app_is_staff() OR client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id()));
CREATE POLICY content_approvals_insert ON content_approvals FOR INSERT
  WITH CHECK (app_is_staff() OR client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id()));

REVOKE UPDATE, DELETE ON content_approvals FROM bd_app;

-- ---------------------------------------------------------------------------
-- Class 3: client-visible with a column gate.
--
-- Same tenant check, plus a per-row visibility flag. Without it, granting
-- portal access would expose her internal to-dos and the raw Ideas Bank —
-- rejected pitches included.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY tasks_select ON tasks FOR SELECT
  USING (
    app_is_staff()
    OR (
      visible_to_client
      AND client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id())
    )
  );
CREATE POLICY tasks_write ON tasks FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY content_items_select ON content_items FOR SELECT
  USING (
    app_is_staff()
    OR (
      visible_to_client
      AND client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id())
    )
  );
CREATE POLICY content_items_write ON content_items FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

-- ---------------------------------------------------------------------------
-- Deliberately NOT protected by RLS:
--
--   user, session, account, verification, organization, member, invitation
--     Better Auth owns these and needs unrestricted access to authenticate a
--     request — which happens before any tenant context exists.
--   system_meta
--     Boot marker, no tenant data.
-- ---------------------------------------------------------------------------
