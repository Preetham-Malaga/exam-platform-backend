-- Undo 047. Run by hand, then delete the row '047_people_details.sql' from app.migrations.
-- The extra student and teacher details are lost.
alter table public.teachers drop column if exists details;
alter table public.students drop column if exists details;
