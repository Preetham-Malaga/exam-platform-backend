-- Undo 043. Run by hand, then delete the row '043_organization_approval.sql' from app.migrations.
-- Organizations still waiting for approval become active again (the behaviour before 043).
update public.organizations set status = 'active' where status = 'pending_approval';

drop function if exists app.approve_organization(uuid, uuid);
drop function if exists app.organization_email_confirmed(uuid);

alter table public.organizations
  drop column if exists approved_by,
  drop column if exists approved_at,
  drop column if exists terms_accepted_at,
  drop column if exists heard_from,
  drop column if exists country,
  drop column if exists state,
  drop column if exists city;

alter table public.organizations drop constraint organizations_status_check;
alter table public.organizations add constraint organizations_status_check
  check (status in ('pending_email', 'active', 'suspended', 'closed'));
