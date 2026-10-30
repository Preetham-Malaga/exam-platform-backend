-- Undo 045. Run by hand, then delete the row '045_batches.sql' from app.migrations.
-- Students lose their batch; batches are deleted.
alter table public.students drop constraint if exists students_batch_fk;
drop index if exists public.students_org_batch_idx;
alter table public.students drop column if exists batch_id;
drop table if exists public.batches;
