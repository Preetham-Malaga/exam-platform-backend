-- 043: organizations wait for platform approval, and sign-up stores the prototype's extra fields.
-- Only additions: a new allowed status and nullable columns. No existing row or value changes.
-- Undo: supabase/rollbacks/043_organization_approval.down.sql

-- 1) New status between e-mail verification and active: pending_email -> pending_approval -> active.
alter table public.organizations drop constraint organizations_status_check;
alter table public.organizations add constraint organizations_status_check
  check (status in ('pending_email', 'pending_approval', 'active', 'suspended', 'closed'));

-- 2) Sign-up details (prototype SPEC.signup). contact_phone already exists for the owner's mobile.
alter table public.organizations
  add column city text check (city is null or char_length(btrim(city)) between 2 and 100),
  add column state text check (state is null or char_length(btrim(state)) between 2 and 100),
  add column country text not null default 'India',
  add column heard_from text check (heard_from is null or char_length(heard_from) <= 100),
  add column terms_accepted_at timestamptz,
  add column approved_at timestamptz,
  add column approved_by uuid;

-- 3) E-mail confirmed: the organization now waits for approval instead of becoming active by itself.
create or replace function app.organization_email_confirmed(p_org uuid) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.organizations set status = 'pending_approval' where id = p_org and status = 'pending_email'
$$;

-- 4) A platform admin approves; only an organization that is waiting can be approved.
create or replace function app.approve_organization(p_org uuid, p_actor uuid) returns boolean
language sql security definer set search_path = public, pg_temp as $$
  with done as (
    update public.organizations set status = 'active', approved_at = now(), approved_by = p_actor
    where id = p_org and status in ('pending_email', 'pending_approval')
    returning 1
  )
  select exists (select 1 from done)
$$;

revoke execute on function app.organization_email_confirmed(uuid), app.approve_organization(uuid, uuid)
  from public, anon, authenticated;
grant execute on function app.organization_email_confirmed(uuid), app.approve_organization(uuid, uuid)
  to service_role;
