-- 006: roles. organization_id NULL = system role shared by everyone (custom org roles can come later).
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  code text not null,
  name text not null,
  scope text not null default 'organization' check (scope in ('platform','organization')),
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index roles_code_uidx
  on public.roles (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), code);

insert into public.roles (code, name, scope, is_system) values
  ('PLATFORM_SUPER_ADMIN', 'Platform Super Admin', 'platform', true),
  ('ORGANIZATION_OWNER',   'Organization Owner',   'organization', true),
  ('ORGANIZATION_ADMIN',   'Organization Admin',   'organization', true),
  ('TEACHER',              'Teacher',              'organization', true),
  ('STUDENT',              'Student',              'organization', true);
