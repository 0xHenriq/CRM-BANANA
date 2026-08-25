-- Row Level Security for invoices and their payments, plus the two sequences
-- that number them.
--
-- Read 0002_rls.sql first. Everything there applies; this file only adds the
-- two new tenant tables and follows the existing classes rather than inventing
-- a new shape.
--
-- No GRANTs are needed: bd_owner carries ALTER DEFAULT PRIVILEGES granting
-- bd_app arwd on relations and rU on sequences, which is why 0003's
-- invitation_grants needed none either.

-- ---------------------------------------------------------------------------
-- Numbering
--
-- Sequences rather than max(number)+1. Two invoices raised in the same second
-- would race on a max() and collide on the unique index; a sequence cannot.
-- Gaps are expected and fine — a sequence is not gapless, and neither is any
-- real invoice book once something is voided.
-- ---------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS invoice_number_seq;
CREATE SEQUENCE IF NOT EXISTS receipt_number_seq;

-- ---------------------------------------------------------------------------
-- invoices — Class 3: client-visible, with a column gate.
--
-- The gate is `issued_on IS NOT NULL`, not the status. A draft is her working
-- copy and the client must never see it; issuance is the act that makes the
-- document real to them. Keying on issuance rather than status also means a
-- later void does not retroactively hide an invoice the client has already
-- received, which would be a worse lie than showing it as void.
-- ---------------------------------------------------------------------------

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY invoices_select ON invoices FOR SELECT
  USING (
    app_is_staff()
    OR (
      issued_on IS NOT NULL
      AND client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id())
    )
  );

CREATE POLICY invoices_write ON invoices FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

-- ---------------------------------------------------------------------------
-- invoice_payments — a receipt.
--
-- Child rows inherit their parent's visibility, exactly as 0006 established
-- for content assets: `invoice_id IN (SELECT id FROM invoices)` is evaluated
-- under the caller's own policy on invoices, so a payment against a draft is
-- invisible without duplicating the issued_on predicate here. If the rule on
-- invoices ever changes, this follows automatically.
--
-- No UPDATE policy, deliberately. A receipt records that money arrived; its
-- amount and date are evidence, not a mutable field, and rewriting one in
-- place would leave the client holding a receipt that no longer matches ours.
-- DELETE is allowed for staff so a mis-keyed payment can be withdrawn — that
-- issues a NEW receipt number when re-recorded and leaves the audit_log trail,
-- which is the honest way to correct a mistake.
-- ---------------------------------------------------------------------------

ALTER TABLE invoice_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY invoice_payments_select ON invoice_payments FOR SELECT
  USING (
    app_is_staff()
    OR (
      client_id IN (SELECT client_id FROM client_access WHERE user_id = app_user_id())
      AND invoice_id IN (SELECT id FROM invoices)
    )
  );

CREATE POLICY invoice_payments_insert ON invoice_payments FOR INSERT
  WITH CHECK (app_is_staff());

CREATE POLICY invoice_payments_delete ON invoice_payments FOR DELETE
  USING (app_is_staff());

REVOKE UPDATE ON invoice_payments FROM bd_app;
