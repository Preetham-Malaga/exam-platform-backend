-- 009: role assignment inside one organization.
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null,
  role_id uuid not null references public.roles(id),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id, role_id),
  foreign key (organization_id, user_id)
    references public.organization_members (organization_id, user_id) on delete cascade
);
