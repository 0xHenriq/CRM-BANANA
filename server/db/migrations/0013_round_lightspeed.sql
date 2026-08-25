ALTER TABLE "clients" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- An archived client is invisible to their own users.
--
-- Read 0002_rls.sql first. This REPLACES clients_select rather than adding a
-- policy beside it: multiple permissive policies on the same command are
-- OR'ed, so a second policy could only ever widen access. The restriction has
-- to go inside the existing one.
--
-- Staff are deliberately unaffected. She has to be able to see an archived
-- client in order to restore it, and a Restore button that cannot read the row
-- it restores is not a feature.
--
-- The archive route also sets portal_enabled = false, so this is the second of
-- two independent gates. That is on purpose: portal_enabled is an ordinary
-- editable field and could be switched back on by any future screen without
-- anyone thinking about archived clients, while this predicate cannot be
-- turned off by accident.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS clients_select ON clients;

CREATE POLICY clients_select ON clients FOR SELECT
  USING (
    app_is_staff()
    OR (
      archived_at IS NULL
      AND id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id())
    )
  );
