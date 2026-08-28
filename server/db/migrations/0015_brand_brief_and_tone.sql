ALTER TABLE "clients" ADD COLUMN "brief" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "tone_of_voice" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "brand_colors" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The palette carries the colour now, and brand_color mirrors it.
--
-- Sofia asked for five brand colours — two primary, three secondary — where
-- there was one. The obvious shape is a second column beside brand_color, and
-- it is the wrong one: ClientLogo, the portal payload and every initials
-- fallback read brand_color, so two columns holding "the brand colour" is two
-- sources of truth for one fact, and they drift the first time anything writes
-- only one of them.
--
-- So brand_colors is the authority for all five and brand_color is a mirror of
-- slot 1, maintained on the single write path in the PATCH handler. Nothing
-- else may set brand_color — it is deliberately no longer in the PATCH schema.
--
-- Backfilled here so an existing brand colour becomes slot 1 rather than
-- disappearing behind a palette that reads empty.
--
-- Positional, five slots, '' for "not set". Slots are named ROLES (primary 1,
-- primary 2, secondary 1..3), so index identity matters and a short array
-- cannot mean "the first three". An empty array means nothing has been set at
-- all, which is every client today, and the UI reads slot i as
-- `brandColors[i] || fallback`. Empty string rather than NULL elements: a
-- text[] with holes in it types as (string|null)[] everywhere it is touched,
-- for no gain over a sentinel that cannot be confused with a colour.
-- ---------------------------------------------------------------------------

UPDATE clients
   SET brand_colors = ARRAY[brand_color, '', '', '', '']
 WHERE brand_color IS NOT NULL AND brand_color <> '';
