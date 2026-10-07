-- 003: per-organization settings, branding and onboarding progress.
create table public.organization_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  branding jsonb not null default '{}'::jsonb,
  timezone text not null default 'Asia/Kolkata',
  onboarding_current_step int not null default 1 check (onboarding_current_step between 1 and 10),
  onboarding_completed_steps int[] not null default '{}',
  onboarding_skipped_steps int[] not null default '{}',
  onboarding_completed_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
