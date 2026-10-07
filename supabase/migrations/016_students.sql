-- 016: student records. user_id stays NULL until the student accepts an invite / has a login.
create table public.students (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid,
  roll_number text not null,
  full_name text not null,
  email citext,
  phone text,
  academic_unit_id uuid,
  status text not null default 'active' check (status in ('active','inactive')),
  created_by uuid default auth.uid(),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, user_id)
    references public.organization_members (organization_id, user_id),
  foreign key (organization_id, academic_unit_id) references public.academic_units (organization_id, id)
);
create unique index students_org_roll_uidx on public.students (organization_id, roll_number) where deleted_at is null;
create unique index students_org_user_uidx on public.students (organization_id, user_id)
  where user_id is not null and deleted_at is null;
