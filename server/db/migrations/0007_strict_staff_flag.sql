-- app_is_staff() must accept exactly one value, not everything Postgres
-- considers truthy.
--
-- The previous body was:
--   coalesce(nullif(current_setting('app.is_staff', true), '')::boolean, false)
--
-- Postgres's boolean input accepts 'yes', 'y', 'on', 't', and '1' as true.
-- Verified: setting app.is_staff = 'yes' made app_is_staff() return true and a
-- client-role session read the agency's deal row. Full staff escalation from a
-- string that no part of this codebase intends to be truthy.
--
-- It is not reachable today — withTenant writes a hardcoded 'true'/'false'
-- from a boolean — but it is a loaded gun pointed at any future code path that
-- passes a value through from a header, a query param, or a careless refactor.
--
-- Exact string comparison instead. 'true' is staff; everything else, including
-- 'yes', 'TRUE', '1', '' and unset, is not. There is no coercion left to abuse.

CREATE OR REPLACE FUNCTION app_is_staff() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT current_setting('app.is_staff', true) = 'true' $$;
