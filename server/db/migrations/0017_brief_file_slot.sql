-- ---------------------------------------------------------------------------
-- A "Brief" slot in every existing File Folder.
--
-- She asked for one alongside contract and agreement. Adding it to
-- DEFAULT_FILES only covers workspaces created FROM NOW ON: seeding runs once,
-- when a client's portal is first opened, so every client she already has
-- would never see it.
--
-- Guarded by NOT EXISTS on the name rather than by a timestamp, so re-running
-- this cannot produce a second Brief row — and so a client who somehow already
-- has one keeps the one they have, with whatever is in it.
--
-- `external_url = ''` matches how the other five are seeded: the
-- `files_has_target` CHECK requires a target, and an empty string is how an
-- unfilled slot is spelled here. sort_order 5 puts it after the original five.
-- ---------------------------------------------------------------------------

INSERT INTO files (client_id, name, external_url, sort_order)
SELECT c.id, 'Brief', '', 5
  FROM clients c
 WHERE c.portal_enabled
   AND NOT EXISTS (
     SELECT 1 FROM files f WHERE f.client_id = c.id AND f.name = 'Brief'
   )
   -- Only workspaces that were actually seeded. A client with no files at all
   -- has never had a portal opened, and giving them one lone Brief row would
   -- be a folder with a single mysterious entry in it.
   AND EXISTS (SELECT 1 FROM files f WHERE f.client_id = c.id);
