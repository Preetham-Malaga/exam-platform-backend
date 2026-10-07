-- 013: courses / programs. Composite FK keeps units in the same organization.
create table public.courses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  academic_unit_id uuid,
  code text not null,
  name text not null,
  description text,
  status text not null default 'active' check (status in ('active','inactive')),
  created_by uuid default auth.uid(),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, academic_unit_id) references public.academic_units (organization_id, id)
);
create unique index courses_org_code_uidx on public.courses (organization_id, code) where deleted_at is null;
