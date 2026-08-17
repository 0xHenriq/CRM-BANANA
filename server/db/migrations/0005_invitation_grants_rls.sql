-- invitation_grants carries a client_id, so leaving it unprotected would let
-- any signed-in user enumerate which workspaces have pending invitations.
-- Small, but it is tenant-adjacent data and the default should be closed.
--
-- Staff-only: it is written by the (authenticated) invite endpoint and read
-- only by grant_client_access_from_invitation, which is SECURITY DEFINER and
-- therefore unaffected by this policy.
ALTER TABLE invitation_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY invitation_grants_staff ON invitation_grants FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());
