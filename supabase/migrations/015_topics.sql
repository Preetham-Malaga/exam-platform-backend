-- 015: topics inside a subject.
create table public.topics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subject_id uuid not null,
  name text not null,
  position int not null default 0,
  created_by uuid default auth.uid(),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, id),
  unique (organization_id, subject_id, id),
  foreign key (organization_id, subject_id) references public.subjects (organization_id, id)
);
create unique index topics_org_subject_name_uidx
  on public.topics (organization_id, subject_id, lower(name)) where deleted_at is null;
