-- 010: restricts teachers to assigned courses / academic units / subjects.
create table public.user_scopes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null,
  scope_type text not null check (scope_type in ('course','academic_unit','subject')),
  scope_id uuid not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id, scope_type, scope_id),
  foreign key (organization_id, user_id)
    references public.organization_members (organization_id, user_id) on delete cascade
);
