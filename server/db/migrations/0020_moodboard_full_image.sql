ALTER TABLE "moodboard_items" ADD COLUMN "full_key" text;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Keep the full-size image, so a moodboard can be looked at.
--
-- A tile stored ONLY the 400px thumbnail: the original was processed and then
-- discarded, because an earlier fix found every upload leaving its full-size
-- copy on disk with nothing pointing at it. That was the right fix for the
-- orphan and the wrong one for the feature — a moodboard is about the visual,
-- and 400px is a thumbnail, not something you can judge a look from. Clicking
-- a tile now opens the real image, which is only possible if the real image is
-- still there.
--
-- Nullable, and it stays nullable: every tile uploaded before this has no
-- original to point at, and inventing one is not possible. The viewer falls
-- back to the tile for those, which is exactly what it showed before.
--
-- The delete path removes BOTH keys. Adding a second key without that is how
-- the original orphan happened, so it is the same change, not a follow-up.
-- ---------------------------------------------------------------------------
