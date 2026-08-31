-- ---------------------------------------------------------------------------
-- Share links: the half that was designed and never built.
--
-- `review_links` has existed since 0000 with a token hash, an expiry, a
-- revocation stamp and a use counter, and it has had zero routes, zero queries
-- and zero rows. 0002_rls.sql left an `app_review_content_id()` that nothing
-- calls and a note saying to extend ONLY the content_* policies "so a review
-- token routed into the files or deals handler still returns zero rows". This
-- migration is that instruction, carried out.
--
-- WHAT WAS PROBED FIRST, because the plan flagged it as unverified:
-- `content_approvals.review_link_id` is ON DELETE SET NULL under
-- CHECK num_nonnulls(actor_id, review_link_id) = 1, so nulling it on a row
-- whose actor_id is already NULL violates the check. Reproduced against
-- bd_portal_test on all three paths:
--
--   DELETE a review_link on its own  -> FAILS with the check violation
--   DELETE its content_item          -> fine (approvals are deleted, not nulled)
--   DELETE its client                -> fine (same)
--
-- So the cascades are safe and no FK needs changing. What is NOT safe is
-- deleting a link directly, which is exactly why there is no DELETE route:
-- revoking sets `revoked_at`, following the POST /clients/:id/archive
-- soft-verb precedent. Anyone adding one later will hit that check.
-- ---------------------------------------------------------------------------

CREATE TYPE "review_scope" AS ENUM('content_item', 'feed');--> statement-breakpoint

-- A feed link is scoped to a client and has no single item, so the column that
-- was NOT NULL has to admit null — guarded by a CHECK so the two scopes cannot
-- be mixed up. Widened rather than given a second table: content_approvals and
-- content_comments already FK here under `num_nonnulls(...) = 1` checks, and a
-- second table would mean either a second nullable FK on an append-only table
-- or a polymorphic reference RLS cannot follow. Decisively, the validity
-- predicate IS the security rule, and two tables means two copies of it with
-- two chances to drift. The table has no rows, which is why this is the moment.
ALTER TABLE "review_links" ALTER COLUMN "content_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "review_links" ADD COLUMN "scope" "review_scope" DEFAULT 'content_item' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_links" ADD CONSTRAINT "review_links_scope_target" CHECK (
  (scope = 'content_item' AND content_item_id IS NOT NULL)
  OR (scope = 'feed' AND content_item_id IS NULL)
);--> statement-breakpoint
CREATE INDEX "review_links_client_idx" ON "review_links" ("client_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Three GUCs, not one.
--
-- A malformed value returns NULL rather than raising 22P02. The original cast
-- would throw inside a policy, and a policy that throws invites the next
-- person to "fix" the policy — isolation.test.ts makes that argument at
-- length about the other helpers. There is no TRY_CAST in Postgres, so the
-- shape is checked before casting.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_review_content_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$
    SELECT CASE
      WHEN current_setting('app.review_content_id', true)
           ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN current_setting('app.review_content_id', true)::uuid
      ELSE NULL
    END
  $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_review_feed_client_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$
    SELECT CASE
      WHEN current_setting('app.review_feed_client_id', true)
           ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN current_setting('app.review_feed_client_id', true)::uuid
      ELSE NULL
    END
  $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_review_link_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$
    SELECT CASE
      WHEN current_setting('app.review_link_id', true)
           ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN current_setting('app.review_link_id', true)::uuid
      ELSE NULL
    END
  $$;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app_review_content_id() TO bd_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_review_feed_client_id() TO bd_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_review_link_id() TO bd_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Exactly three policies gain exactly one arm each.
--
-- DROP/CREATE rather than a second policy beside them: permissive policies are
-- OR'ed, so a new policy can only ever widen access and the restriction has to
-- live inside the existing one. `content_comments_*` is deliberately NOT
-- touched — a link holder can approve and leave a note on the decision, and
-- that is all. Narrower than 0002's note permits is fine; wider is not.
--
-- `AND visible_to_client` is LOAD-BEARING on both new arms of
-- content_items_select. It is what backs the mint route's refusal to share a
-- raw Ideas Bank row at the database rather than only in the handler.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS content_items_select ON content_items;--> statement-breakpoint
CREATE POLICY content_items_select ON content_items FOR SELECT
  USING (
    app_is_staff()
    OR (visible_to_client AND client_id IN (SELECT app_client_ids()))
    OR (id = app_review_content_id() AND visible_to_client)
    OR (client_id = app_review_feed_client_id() AND visible_to_client)
  );--> statement-breakpoint

DROP POLICY IF EXISTS content_assets_select ON content_assets;--> statement-breakpoint
CREATE POLICY content_assets_select ON content_assets FOR SELECT
  USING (
    app_is_staff()
    OR (
      client_id IN (SELECT app_client_ids())
      AND content_item_id IN (SELECT id FROM content_items)
    )
    /*
     * BOTH terms, and the second is not decoration.
     *
     * Direct equality alone was the first version of this arm and it LEAKED:
     * a token aimed at an item that is not shared with the client could not
     * read the item — content_items_select carries `AND visible_to_client` —
     * but could still read its creative, because nothing on this arm asked.
     * Caught by isolation.test.ts against the fixture's rejected pitch, whose
     * asset is literally called secret-pitch-deck.png.
     *
     * That is migration 0006's bug exactly, arriving through a new door. So
     * this composes the way 0006 did: `IN (SELECT id FROM content_items)` is
     * itself filtered by the policy above, which inherits its
     * `visible_to_client` rather than restating it in a second place that can
     * drift.
     */
    OR (
      content_item_id = app_review_content_id()
      AND content_item_id IN (SELECT id FROM content_items)
    )
    -- The feed arm keeps 0006's self-composing shape, which inherits
    -- `visible_to_client` from the policy above rather than restating it.
    OR (
      client_id = app_review_feed_client_id()
      AND content_item_id IN (SELECT id FROM content_items)
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS content_approvals_select ON content_approvals;--> statement-breakpoint
CREATE POLICY content_approvals_select ON content_approvals FOR SELECT
  USING (
    app_is_staff()
    OR (
      client_id IN (SELECT app_client_ids())
      AND content_item_id IN (SELECT id FROM content_items)
    )
    -- So the page can say "you approved this on 12 August" instead of
    -- offering the buttons again.
    OR review_link_id = app_review_link_id()
  );--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Redeeming a token is also a function, and for the same reason.
--
-- `review_links` is a STAFF-ONLY table: its policy admits `app_is_staff()` and
-- nothing else. A share request has no session at all, so the obvious
-- implementation — UPDATE the row, bump the counter, read the scope back —
-- matches zero rows and every valid link 404s. Found by running it: the mint
-- succeeded, the row was there, and redemption returned "no longer available".
--
-- The wrong fix is a policy arm on review_links keyed to a GUC, because the
-- GUC is set BY redemption; that is circular, and it would also make the table
-- readable to any context that can set the variable. The right one is the
-- shape migration 0004 already settled: a SECURITY DEFINER function with
-- exactly one capability.
--
-- It escalates nothing. The caller must already hold a token whose sha256 is
-- this hash, which is the entire authority a share link confers, and the
-- function returns a row only while the link is live and its client is not
-- archived. `portal_enabled` is deliberately NOT checked — the whole point is
-- a recipient with no portal account.
--
-- The bump is inside the same UPDATE, so a link cannot be redeemed without
-- being counted, and there is no check-then-use window between validating and
-- acting.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION redeem_review_link(
  p_token_hash text,
  p_bump boolean
) RETURNS TABLE (
  id uuid,
  client_id uuid,
  content_item_id uuid,
  scope review_scope,
  use_count integer,
  last_used_at timestamptz,
  -- Returned here rather than selected under the review context, because
  -- `clients` is staff-only and stays that way: the isolation suite asserts a
  -- review context reads nothing from it. The recipient is the client's own
  -- colleague, so their name and brand colour on their own page is what they
  -- expect to see — and it is all they get.
  client_name text,
  client_brand_color text
)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $$
  UPDATE review_links rl
     SET use_count    = rl.use_count + CASE WHEN p_bump THEN 1 ELSE 0 END,
         last_used_at = CASE WHEN p_bump THEN now() ELSE rl.last_used_at END
    FROM clients c
   WHERE c.id = rl.client_id
     AND rl.token_hash = p_token_hash
     AND rl.revoked_at IS NULL
     AND rl.expires_at > now()
     AND c.archived_at IS NULL
  RETURNING rl.id, rl.client_id, rl.content_item_id, rl.scope,
            rl.use_count, rl.last_used_at, c.name, c.brand_color
$$;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION redeem_review_link(text, boolean) TO bd_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Recording a decision is a function, not a policy arm.
--
-- It is not one insert: the status of the content item moves and an activities
-- row is written, and both of those tables are staff-only by design. A policy
-- arm on content_approvals_insert would therefore need an escalation beside it
-- and the escalated half would be untested. Migration 0004 settled this
-- pattern and its comment argues the case: a "system context" that flips
-- app.is_staff is a bypass door, and doors get used.
--
-- So content_approvals_insert gains NO review arm, which turns "a review
-- context cannot insert into content_approvals at all" into a positive
-- property the isolation suite can assert.
--
-- The function re-validates the token ITSELF rather than trusting the GUCs the
-- caller set, so bd_app cannot record a decision for a link whose token it
-- does not hold.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION record_review_decision(
  p_token_hash text,
  p_decision approval_decision,
  p_note text
) RETURNS TABLE (outcome text, new_status content_status)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  link       review_links%ROWTYPE;
  item       content_items%ROWTYPE;
  next_state content_status;
BEGIN
  SELECT rl.* INTO link
    FROM review_links rl
    JOIN clients c ON c.id = rl.client_id
   WHERE rl.token_hash = p_token_hash
     AND rl.revoked_at IS NULL
     AND rl.expires_at > now()
     AND c.archived_at IS NULL;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::content_status;
    RETURN;
  END IF;

  -- A feed link shows nine cells; there is no single thing to approve.
  IF link.scope <> 'content_item' THEN
    RETURN QUERY SELECT 'wrong_scope'::text, NULL::content_status;
    RETURN;
  END IF;

  SELECT ci.* INTO item FROM content_items ci WHERE ci.id = link.content_item_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::content_status;
    RETURN;
  END IF;

  -- Mirrors the signed-in path exactly: approving something nobody has been
  -- shown is not approval.
  IF item.status IN ('idea', 'in_progress') THEN
    RETURN QUERY SELECT 'not_for_review'::text, item.status;
    RETURN;
  END IF;

  -- One decision per link. The table is append-only, so without this a
  -- refreshed tab or a double tap writes a second row that can never be
  -- tidied away.
  IF EXISTS (SELECT 1 FROM content_approvals WHERE review_link_id = link.id) THEN
    RETURN QUERY SELECT 'already_decided'::text, item.status;
    RETURN;
  END IF;

  INSERT INTO content_approvals (client_id, content_item_id, decision, actor_id, review_link_id, note)
  VALUES (link.client_id, item.id, p_decision, NULL, link.id, nullif(btrim(coalesce(p_note, '')), ''));

  next_state := CASE
    WHEN p_decision = 'approved' THEN
      CASE WHEN item.scheduled_at IS NOT NULL THEN 'scheduled'::content_status
           ELSE 'approved'::content_status END
    ELSE 'in_progress'::content_status
  END;

  UPDATE content_items SET status = next_state, updated_at = now() WHERE id = item.id;

  INSERT INTO activities (client_id, entity_type, entity_id, actor_id, kind, body)
  VALUES (
    link.client_id,
    'content_item',
    item.id,
    NULL,
    'status_change',
    CASE WHEN p_decision = 'approved'
      THEN format('"%s" approved via share link%s', item.title,
             CASE WHEN item.scheduled_at IS NOT NULL
                  THEN ' and scheduled for ' || item.scheduled_at::text ELSE '' END)
      ELSE format('Changes requested on "%s" via share link%s', item.title,
             CASE WHEN nullif(btrim(coalesce(p_note, '')), '') IS NOT NULL
                  THEN ': ' || btrim(p_note) ELSE '' END)
    END
  );

  RETURN QUERY SELECT 'ok'::text, next_state;
END;
$$;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION record_review_decision(text, approval_decision, text) TO bd_app;
