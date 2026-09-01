ALTER TABLE "invoice_payments" ADD COLUMN "external_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_payments_external_id_key"
  ON "invoice_payments" ("external_id") WHERE "external_id" IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Stripe pays the same way she does, and cannot pay twice.
--
-- `external_id` holds the Stripe Checkout Session id for a card payment, and
-- NULL for everything she records by hand — a bank transfer has no external
-- identity and should not be forced to invent one.
--
-- The unique index is the whole point. Stripe RETRIES a webhook until it gets
-- a 2xx: a slow response, a deploy mid-delivery, or a network blip all produce
-- the same event twice, and without this the second delivery writes a second
-- payment row. On a £300 invoice that reads as £600 received, which is a
-- reconciliation problem that surfaces weeks later at the bank.
--
-- Partial, so it constrains only the rows that HAVE an external id. A plain
-- unique index would allow exactly one hand-entered payment across the whole
-- agency, because they all share NULL — and in Postgres a plain unique index
-- does permit many NULLs, so this would have "worked" while quietly meaning
-- something else. Saying WHERE makes the intent legible rather than incidental.
--
-- Idempotency is enforced HERE and not in application code on purpose: the
-- webhook can run twice concurrently, and two transactions that both check
-- "does this session exist" before either inserts will both find nothing.
-- Only the database can settle that race.
-- ---------------------------------------------------------------------------
