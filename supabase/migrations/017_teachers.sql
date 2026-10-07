-- 017: teacher records (profile data); permissions come from the TEACHER role, limits from user_scopes.
create table public.teachers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid,
  employee_code text not null,
  full_name text not null,
  email citext,
  phone text,
  status text not null default 'active' check (status in ('active','inactive')),
  created_by uuid default auth.uid(),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, user_id)
    references public.organization_members (organization_id, user_id)
);
create unique index teachers_org_code_uidx on public.teachers (organization_id, employee_code) where deleted_at is null;
create unique index teachers_org_user_uidx on public.teachers (organization_id, user_id)
  where user_id is not null and deleted_at is null;
