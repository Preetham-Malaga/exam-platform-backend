-- Undo 044. Run by hand, then delete the row '044_catalog_details.sql' from app.migrations.
-- The extra details typed into the course, subject and topic forms are lost.
alter table public.topics drop column if exists details;
alter table public.subjects drop column if exists details;
alter table public.courses drop column if exists details;
