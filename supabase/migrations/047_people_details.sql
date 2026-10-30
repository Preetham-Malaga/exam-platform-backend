-- 047: the prototype's full student and teacher forms (SPEC.student, SPEC.teacher): date of birth, gender, education
-- background, address, parent / guardian, professional details … kept in one "details" object per person.
-- Only additions: a new column with an empty default on each table. No existing row or value changes.
-- Undo: supabase/rollbacks/047_people_details.down.sql

alter table public.students
  add column details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 8192);
alter table public.teachers
  add column details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 8192);
