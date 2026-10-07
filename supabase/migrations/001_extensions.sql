-- 001: extensions and the private "app" schema (helper + business functions live here).
create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists pg_trgm;

create schema if not exists app;
grant usage on schema app to anon, authenticated, service_role;
-- Functions in "app" are NOT callable by everyone by default; each migration grants what it needs.
alter default privileges in schema app revoke execute on functions from public;
