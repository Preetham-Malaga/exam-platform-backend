-- 039: role definitions are changed only by the platform (backend system connection), never through a user session.
-- RLS already had no write policy on roles; this removes the table privilege too (defence in depth, clearer errors).
revoke insert, update, delete on public.roles from authenticated;
