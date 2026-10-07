-- 011: configurable hierarchy labels per organization (Program > Branch > Year > Semester, or Class > Section ...).
create table public.academic_levels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code text not null,
  name text not null,
  position int not null check (position >= 1),
  created_by uuid default auth.uid(),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, code),
  unique (organization_id, position)
);
