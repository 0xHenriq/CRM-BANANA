ALTER TABLE "files" ADD COLUMN "invoice_id" uuid;--> statement-breakpoint
-- CASCADE, not SET NULL, and the difference is a leak.
--
-- Only an UNISSUED invoice can be deleted (the route refuses once issued_on is
-- set), so every deletion is a draft being thrown away. Under SET NULL the
-- attachment survived with invoice_id NULL — which makes it an ORDINARY file,
-- and ordinary files are client-visible. Deleting a draft therefore published
-- its document: the unissued figures the gate below exists to hide, handed
-- over by the one path that removed the thing doing the hiding.
--
-- The document exists because of the invoice, so it goes with it. This does
-- leave its bytes on disk with nothing pointing at them, and that is the
-- deliberate trade this codebase makes everywhere else: a few stray files is
-- the recoverable mistake, publishing her draft figures is not.
ALTER TABLE "files" ADD CONSTRAINT "files_invoice_id_invoices_id_fk"
  FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_invoice_idx" ON "files" ("invoice_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Attaching a PDF to an invoice opens a hole, and this closes it.
--
-- The two tables sit in different visibility classes, which is exactly why
-- this is not just an extra column:
--
--   files    — CLIENT VISIBLE. Any file for a workspace the client can see.
--   invoices — COLUMN GATED. The client sees an invoice only once `issued_on`
--              is set, because a draft is her working copy and may carry a
--              number she has not agreed to charge yet.
--
-- So a file attached to a DRAFT invoice would have appeared in the client's
-- File Folder, downloadable, while the invoice itself was correctly hidden —
-- her unissued figures delivered by the one door nobody was watching.
--
-- The fix composes rather than restating the rule: `invoice_id IN (SELECT id
-- FROM invoices)` is itself filtered by invoices_select, so it inherits the
-- `issued_on` gate automatically and cannot drift from it. Migration 0006 used
-- the same shape for content children. `invoice_id IS NULL` keeps every
-- ordinary file exactly as visible as it was.
--
-- Staff are unaffected: app_is_staff() short-circuits the whole thing.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS files_select ON files;--> statement-breakpoint

CREATE POLICY files_select ON files FOR SELECT
  USING (
    app_is_staff()
    OR (
      client_id IN (SELECT app_client_ids())
      AND (invoice_id IS NULL OR invoice_id IN (SELECT id FROM invoices))
    )
  );
