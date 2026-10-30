-- Undo 046. Run by hand, then delete the row '046_learning.sql' from app.migrations.
-- Live classes, recordings and materials are deleted.
drop table if exists public.recordings;
drop table if exists public.materials;
drop table if exists public.live_classes;
delete from public.role_permissions
  where permission_id in (select id from public.permissions where code in ('learning.read', 'learning.manage'));
delete from public.permissions where code in ('learning.read', 'learning.manage');
