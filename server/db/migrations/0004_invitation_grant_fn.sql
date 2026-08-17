-- Applying a client-workspace grant at invitation acceptance.
--
-- Acceptance is necessarily unauthenticated — the whole point is that the
-- invitee has no account yet — so `app_is_staff()` is false and the write
-- policy on client_access correctly refuses the insert. RLS caught this the
-- first time the endpoint ran, which is the system working.
--
-- The wrong fix is a "system context" that sets app.is_staff = true for
-- trusted server code: that is a bypass door, and doors get used. Instead this
-- is a SECURITY DEFINER function with exactly one capability — turn a grant
-- that was already recorded at invitation time into a client_access row.
--
-- It cannot be used to grant arbitrary access: the client ids come from
-- invitation_grants, which only staff can write (that endpoint IS
-- authenticated), and the invitation must exist and be accepted.

CREATE OR REPLACE FUNCTION grant_client_access_from_invitation(
  p_invitation_id text,
  p_user_id text
) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  granted integer := 0;
  inv_email text;
  usr_email text;
BEGIN
  SELECT email INTO inv_email FROM invitation WHERE id = p_invitation_id;
  IF inv_email IS NULL THEN
    RETURN 0;
  END IF;

  -- The account must be the one this invitation was addressed to. Without
  -- this, a leaked invitation id plus any user id would grant that user
  -- access to someone else's workspace.
  SELECT email INTO usr_email FROM "user" WHERE id = p_user_id;
  IF usr_email IS NULL OR lower(usr_email) <> lower(inv_email) THEN
    RETURN 0;
  END IF;

  INSERT INTO client_access (user_id, client_id)
  SELECT p_user_id, ig.client_id
    FROM invitation_grants ig
   WHERE ig.invitation_id = p_invitation_id
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS granted = ROW_COUNT;

  DELETE FROM invitation_grants WHERE invitation_id = p_invitation_id;

  RETURN granted;
END;
$$;

-- Owned by bd_owner, so its body runs outside the policies that (correctly)
-- block bd_app. Execution is granted; ownership is not.
GRANT EXECUTE ON FUNCTION grant_client_access_from_invitation(text, text) TO bd_app;
