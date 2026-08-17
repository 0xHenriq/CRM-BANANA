CREATE TABLE "invitation_grants" (
	"invitation_id" text NOT NULL,
	"client_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invitation_grants" ADD CONSTRAINT "invitation_grants_invitation_id_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_grants" ADD CONSTRAINT "invitation_grants_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_grants_pk" ON "invitation_grants" USING btree ("invitation_id","client_id");