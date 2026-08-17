-- Children of a content item must inherit that item's visibility.
--
-- The original policies on content_assets, content_comments and
-- content_approvals checked only client_id. That is correct for cross-tenant
-- isolation but wrong within a tenant: a client could not see a hidden
-- content_item, yet could read the assets and comments hanging off it.
--
-- Verified before the fix: a client on workspace A read
-- 'secret-pitch-deck.png' and the internal comment "client rejected this
-- angle" from an item whose visible_to_client was false. Exactly the raw
-- Ideas Bank backlog the flag exists to keep private.
--
-- The fix leans on RLS composing with itself: `content_item_id IN (SELECT id
-- FROM content_items)` is evaluated under the caller's own policy on
-- content_items, so the subquery already excludes anything they may not see.
-- No predicate is duplicated, and if the visibility rule on content_items ever
-- changes, these follow automatically.

DROP POLICY content_assets_select ON content_assets;
CREATE POLICY content_assets_select ON content_assets FOR SELECT
  USING (
    app_is_staff()
    OR (
      client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id())
      AND content_item_id IN (SELECT id FROM content_items)
    )
  );

DROP POLICY content_comments_select ON content_comments;
CREATE POLICY content_comments_select ON content_comments FOR SELECT
  USING (
    app_is_staff()
    OR (
      client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id())
      AND content_item_id IN (SELECT id FROM content_items)
    )
  );

DROP POLICY content_comments_insert ON content_comments;
CREATE POLICY content_comments_insert ON content_comments FOR INSERT
  WITH CHECK (
    app_is_staff()
    OR (
      client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id())
      AND content_item_id IN (SELECT id FROM content_items)
    )
  );

DROP POLICY content_approvals_select ON content_approvals;
CREATE POLICY content_approvals_select ON content_approvals FOR SELECT
  USING (
    app_is_staff()
    OR (
      client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id())
      AND content_item_id IN (SELECT id FROM content_items)
    )
  );

-- A client must not be able to approve something they were never shown.
DROP POLICY content_approvals_insert ON content_approvals;
CREATE POLICY content_approvals_insert ON content_approvals FOR INSERT
  WITH CHECK (
    app_is_staff()
    OR (
      client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id())
      AND content_item_id IN (SELECT id FROM content_items)
    )
  );
