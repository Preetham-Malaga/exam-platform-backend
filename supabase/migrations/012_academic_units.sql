-- 012: actual nodes of the hierarchy (e.g. "B.Tech", "CSE", "Year 2"). parent_id builds the tree.
create table public.academic_units (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  level_id uuid not null,
  parent_id uuid,
  code text not null,
  name text not null,
  status text not null default 'active' check (status in ('active','inactive')),
  created_by uuid default auth.uid(),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, id),
  unique (organization_id, code),
  check (parent_id is null or parent_id <> id),
  foreign key (organization_id, level_id) references public.academic_levels (organization_id, id),
  foreign key (organization_id, parent_id) references public.academic_units (organization_id, id)
);
