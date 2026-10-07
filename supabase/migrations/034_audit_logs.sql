-- PURPOSE: Append-only record of important actions. Never stores passwords.
-- organization_id is nullable ONLY because platform-level actions belong to no organization.

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  action text not null,
  resource text not null,
  resource_id text,
  ip text,
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
