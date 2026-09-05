-- The second half of 0025 — read that file first for the reasoning.
--
-- Split because Postgres refuses to use an enum value in the transaction that
-- added it — and drizzle runs the whole BATCH in one transaction, not one per
-- file, so splitting is necessary but not sufficient.
--
-- The CHECK below therefore compares `scope::text`, not `scope`. Casting to
-- text means the literals stay text and are never coerced to `review_scope`,
-- which is what "using" a new value means to Postgres. Written the obvious way
-- it fails with `unsafe use of new value "moodboard"` and rolls the entire
-- batch back — including 0025, so the values are not there either and the
-- error does not survive to explain itself on a second run.

-- ---------------------------------------------------------------------------
-- A client-scoped link has no single item, whichever view it opens.
-- ---------------------------------------------------------------------------
ALTER TABLE "review_links" DROP CONSTRAINT "review_links_scope_target";--> statement-breakpoint

ALTER TABLE "review_links" ADD CONSTRAINT "review_links_scope_target" CHECK (
  (scope::text = 'content_item' AND content_item_id IS NOT NULL)
  OR (
    scope::text IN ('feed', 'moodboard', 'ideas')
    AND content_item_id IS NULL
  )
);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The function, renamed for what it now answers.
--
-- Created BEFORE the policies move to it and the old one dropped AFTER, or the
-- drop fails on a dependency and the migration leaves the policies half moved.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_review_client_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$
    SELECT CASE
      WHEN current_setting('app.review_feed_client_id', true)
           ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN current_setting('app.review_feed_client_id', true)::uuid
      ELSE NULL
    END
  $$;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app_review_client_id() TO bd_app;--> statement-breakpoint

-- The GUC keeps its old name deliberately. Renaming a session variable means
-- the setter and every policy have to change in the same breath, and a
-- mismatch there fails OPEN-looking: the function returns NULL, the arm never
-- matches, and every share link quietly 404s. The function is what anyone
-- reads; the string is an implementation detail of one setter.

-- ---------------------------------------------------------------------------
-- Both arms rebuilt against the new name. Identical logic — this is a rename,
-- and the isolation suite's share-link tests are what prove it.
-- ---------------------------------------------------------------------------
DROP POLICY content_items_select ON content_items;--> statement-breakpoint
CREATE POLICY content_items_select ON content_items FOR SELECT
  USING (
    app_is_staff()
    OR (visible_to_client AND client_id IN (SELECT app_client_ids()))
    OR (id = app_review_content_id() AND visible_to_client)
    OR (client_id = app_review_client_id() AND visible_to_client)
  );--> statement-breakpoint

DROP POLICY content_assets_select ON content_assets;--> statement-breakpoint
CREATE POLICY content_assets_select ON content_assets FOR SELECT
  USING (
    app_is_staff()
    OR (
      client_id IN (SELECT app_client_ids())
      AND content_item_id IN (SELECT id FROM content_items)
    )
    OR (
      content_item_id = app_review_content_id()
      AND content_item_id IN (SELECT id FROM content_items)
    )
    OR (
      client_id = app_review_client_id()
      AND content_item_id IN (SELECT id FROM content_items)
    )
  );--> statement-breakpoint

DROP FUNCTION IF EXISTS app_review_feed_client_id();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The moodboard, readable by a link that was minted for it.
--
-- No `visible_to_client` term because the table has no such column: a
-- moodboard is client-facing in its entirety, which is why it sits in
-- CLIENT_VISIBLE_TABLES with no column gate. The tenant clause is the whole
-- rule, and it comes from a GUC that redemption alone can set.
--
-- SELECT only. A link holder looks at the board; adding, captioning and
-- deleting stay with the people who have accounts.
-- ---------------------------------------------------------------------------
DROP POLICY moodboard_select ON moodboard_items;--> statement-breakpoint
CREATE POLICY moodboard_select ON moodboard_items FOR SELECT
  USING (
    app_is_staff()
    OR client_id IN (SELECT app_client_ids())
    OR client_id = app_review_client_id()
  );
