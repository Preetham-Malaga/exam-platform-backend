-- 002: tenant root. id = internal UUID, org_code = human-readable code (ORG-000001).
create sequence public.organization_code_seq start 1;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  org_code text not null unique
    default ('ORG-' || lpad(nextval('public.organization_code_seq')::text, 6, '0')),
  name text not null check (char_length(btrim(name)) between 2 and 200),
  institution_type text not null
    check (institution_type in ('engineering','degree','school','mba','coaching','training')),
  status text not null default 'pending_email'
    check (status in ('pending_email','active','suspended','closed')),
  contact_email citext,
  contact_phone text,
  address text,
  logo_file_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
