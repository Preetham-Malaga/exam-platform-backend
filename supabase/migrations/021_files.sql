-- 021: metadata for files in Supabase Storage. Path must start with organizations/<org id>/ .
create table public.files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bucket text not null default 'org-files',
  path text not null,
  kind text not null check (kind in ('logo','question','student','certificate')),
  mime_type text,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  uploaded_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (bucket, path),
  check (path like ('organizations/' || organization_id::text || '/%'))
);
