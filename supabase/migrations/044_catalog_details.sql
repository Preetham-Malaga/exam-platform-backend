-- 044: the prototype's extra course, subject and topic fields (course type, duration, fees; subject type, credits,
-- marks; topic objectives, hours, difficulty …) kept in one "details" object per row.
-- Only additions: a new column with an empty default on each table. No existing row or value changes.
-- Undo: supabase/rollbacks/044_catalog_details.down.sql

alter table public.courses
  add column details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 8192);
alter table public.subjects
  add column details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 8192);
alter table public.topics
  add column details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 8192);
