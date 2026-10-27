-- 041: PostgreSQL grants EXECUTE on every new function to PUBLIC by default, and "alter default privileges in schema app revoke ..."
-- (migration 001) does not remove that built-in grant. So the anonymous role could run internal functions in schema app.
-- (They are not reachable through the REST API, which only exposes "public", and most return nothing without a signed-in user,
-- but the principle is least privilege.) Remove it now; the functions signed-in users need keep their explicit grants.
revoke execute on all functions in schema app from public, anon;

-- Used by the invoker-rights triggers validate_user_scope / validate_exam_assignment, which run as the signed-in user.
grant execute on function app.target_in_org(text, uuid, uuid) to authenticated, service_role;
