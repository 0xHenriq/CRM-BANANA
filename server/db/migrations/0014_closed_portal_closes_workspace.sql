-- A closed portal closes the whole workspace, not just its homepage.
--
-- Read 0002_rls.sql and 0013_round_lightspeed.sql first.
--
-- What was wrong
-- --------------
-- `portal_enabled` was checked in exactly one place: canSeePortal(), inside
-- GET /api/portal. Every other client-facing screen resolves its workspace
-- from `client_access` alone, so a client whose portal she had turned off —
-- or whose whole account she had ARCHIVED — kept full read access to their
-- content calendar, ideas bank, feed preview and moodboard by loading those
-- pages directly. The homepage 404'd and nothing else did.
--
-- Verified against bd_portal_test before this migration: with
-- `portal_enabled = false` AND `archived_at = now()` on client A, the client
-- user still read their content_items rows, and their client_access grant —
-- which is what resolveClientId() reads — still resolved.
--
-- 0013 hid the CLIENTS row from an archived client's users, which is why the
-- portal homepage and Next Steps went quiet: both join `clients`. Nothing else
-- does. Every other client-visible policy asks only "is this client_id in your
-- grants", and a grant outlives both the toggle and the archive.
--
-- The fix
-- -------
-- One helper, `app_client_ids()`, replaces the repeated
--   client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id())
-- so the definition of "a workspace this client may use" lives in one place
-- rather than in twelve policies that have to be kept in step by hand.
--
-- It is SECURITY INVOKER (the default), so its own reads of `clients` and
-- `client_access` run under the caller's policies — the archived gate from
-- 0013 therefore applies inside it as well, and `portal_enabled` is checked
-- explicitly because that column is not part of any policy.
--
-- Staff are unaffected: every policy below short-circuits on app_is_staff()
-- before the helper is consulted. She builds and administers a workspace
-- before it is opened, and the client page renders these same panels.
--
-- Deliberate exceptions, stated rather than left to be discovered
-- ---------------------------------------------------------------
--   * `clients` — a client may still read their own client row when the
--     portal is closed (name and branding, nothing else). It is not part of
--     the workspace, and gating it here would make app_client_ids() recurse
--     into the very policy that calls it.
--   * `invoices` / `invoice_payments` — money owed must not vanish because an
--     account was tidied away, and that cuts both ways: a client who still
--     owes for work already delivered keeps the issued invoice and its
--     receipts. Same reasoning as the archive route deliberately leaving
--     /api/invoices alone.
--
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_client_ids() RETURNS setof uuid
  LANGUAGE sql STABLE
  AS $$
    SELECT ca.client_id
      FROM client_access ca
      JOIN clients c ON c.id = ca.client_id
     WHERE ca.user_id = app_user_id()
       AND c.portal_enabled
       AND c.archived_at IS NULL
  $$;

GRANT EXECUTE ON FUNCTION app_client_ids() TO bd_app;

-- ---------------------------------------------------------------------------
-- Class 2: client-visible.
-- ---------------------------------------------------------------------------

DROP POLICY links_select ON links;
CREATE POLICY links_select ON links FOR SELECT
  USING (app_is_staff() OR client_id IN (SELECT app_client_ids()));

DROP POLICY files_select ON files;
CREATE POLICY files_select ON files FOR SELECT
  USING (app_is_staff() OR client_id IN (SELECT app_client_ids()));

DROP POLICY moodboard_select ON moodboard_items;
CREATE POLICY moodboard_select ON moodboard_items FOR SELECT
  USING (app_is_staff() OR client_id IN (SELECT app_client_ids()));

-- The content_* children keep the parent-visibility clause 0006 added; only
-- the tenant clause changes. Both are needed: one says "your workspace, and it
-- is open", the other says "and you were actually shown this item".
DROP POLICY content_assets_select ON content_assets;
CREATE POLICY content_assets_select ON content_assets FOR SELECT
  USING (
    app_is_staff()
    OR (
      client_id IN (SELECT app_client_ids())
      AND content_item_id IN (SELECT id FROM content_items)
    )
  );

DROP POLICY notice_posts_select ON notice_posts;
CREATE POLICY notice_posts_select ON notice_posts FOR SELECT
  USING (app_is_staff() OR client_id IN (SELECT app_client_ids()));

DROP POLICY notice_posts_insert ON notice_posts;
CREATE POLICY notice_posts_insert ON notice_posts FOR INSERT
  WITH CHECK (app_is_staff() OR client_id IN (SELECT app_client_ids()));

DROP POLICY content_comments_select ON content_comments;
CREATE POLICY content_comments_select ON content_comments FOR SELECT
  USING (
    app_is_staff()
    OR (
      client_id IN (SELECT app_client_ids())
      AND content_item_id IN (SELECT id FROM content_items)
    )
  );

DROP POLICY content_comments_insert ON content_comments;
CREATE POLICY content_comments_insert ON content_comments FOR INSERT
  WITH CHECK (
    app_is_staff()
    OR (
      client_id IN (SELECT app_client_ids())
      AND content_item_id IN (SELECT id FROM content_items)
    )
  );

DROP POLICY content_approvals_select ON content_approvals;
CREATE POLICY content_approvals_select ON content_approvals FOR SELECT
  USING (
    app_is_staff()
    OR (
      client_id IN (SELECT app_client_ids())
      AND content_item_id IN (SELECT id FROM content_items)
    )
  );

-- A client cannot approve work in a workspace that has been closed to them.
DROP POLICY content_approvals_insert ON content_approvals;
CREATE POLICY content_approvals_insert ON content_approvals FOR INSERT
  WITH CHECK (
    app_is_staff()
    OR (
      client_id IN (SELECT app_client_ids())
      AND content_item_id IN (SELECT id FROM content_items)
    )
  );

-- ---------------------------------------------------------------------------
-- Class 3: client-visible with a column gate. The per-row flag stays exactly
-- as it was; only the tenant clause changes.
-- ---------------------------------------------------------------------------

DROP POLICY tasks_select ON tasks;
CREATE POLICY tasks_select ON tasks FOR SELECT
  USING (
    app_is_staff()
    OR (visible_to_client AND client_id IN (SELECT app_client_ids()))
  );

DROP POLICY content_items_select ON content_items;
CREATE POLICY content_items_select ON content_items FOR SELECT
  USING (
    app_is_staff()
    OR (visible_to_client AND client_id IN (SELECT app_client_ids()))
  );
