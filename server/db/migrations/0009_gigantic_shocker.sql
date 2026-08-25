CREATE TYPE "public"."payment_status" AS ENUM('none', 'awaiting', 'paid');--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "payment_status" "payment_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "payment_due" date;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "paid_at" date;