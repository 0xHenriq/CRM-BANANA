-- Replies on a to-do.
--
-- Read 0002_rls.sql and 0014_closed_portal_closes_workspace.sql first.
--
-- Why this exists
-- ---------------
-- Sofia, twice: "reply to next steps in this section". The Next Steps panel
-- carries two kinds of row. A post opens its detail dialog, which has had a
-- comment thread since phase 2 — so half the panel could already be talked
-- about. A to-do had a title, a deadline and a Done button, and nothing else:
-- the one panel headed "what happens next" was the one place neither side
-- could say anything about what happens next. "Swap the Nyall photo for the
-- CIC logo" gets answered in WhatsApp, which is the thing this product exists
-- to stop.
--
-- Shaped on content_comments deliberately — same columns, same class, same
-- parent-visibility clause. A second comment table with different rules is how
-- the two threads end up disagreeing about who may read them.
--
-- Class 2 with a parent gate: client-visible, and composed rather than
-- restated. `task_id IN (SELECT id FROM tasks)` is evaluated under the
-- caller's own policy on `tasks`, which carries the `visible_to_client` column
-- gate — so a reply on an INTERNAL to-do is invisible to the client without
-- this file repeating that rule, and it cannot drift from it. Migration 0006
-- established the shape for content children; 0018 used it for invoice
-- attachments.
--
-- The client may INSERT. That is the whole feature: a thread only one side can
-- write to is a notice board, and there is already one of those.
--
-- No UPDATE policy at all. A reply is a thing somebody said; editing it after
-- the other side has read it makes the thread unciteable. Same reasoning as
-- content_approvals and invoice_payments. DELETE is staff-only, so she can
-- remove something posted in error.

CREATE TABLE task_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id text REFERENCES "user"(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX task_comments_task_idx ON task_comments (task_id, created_at);--> statement-breakpoint

ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY task_comments_select ON task_comments FOR SELECT
  USING (
    app_is_staff()
    OR (
      client_id IN (SELECT app_client_ids())
      AND task_id IN (SELECT id FROM tasks)
    )
  );--> statement-breakpoint

CREATE POLICY task_comments_insert ON task_comments FOR INSERT
  WITH CHECK (
    app_is_staff()
    OR (
      client_id IN (SELECT app_client_ids())
      AND task_id IN (SELECT id FROM tasks)
    )
  );--> statement-breakpoint

CREATE POLICY task_comments_delete ON task_comments FOR DELETE
  USING (app_is_staff());--> statement-breakpoint

REVOKE UPDATE ON task_comments FROM bd_app;
