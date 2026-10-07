-- PURPOSE: Subscription plans offered by the platform (global catalog).

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  price_monthly numeric(10, 2) not null default 0 check (price_monthly >= 0),
  trial_days int not null default 0 check (trial_days >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.plans (code, name, price_monthly, trial_days) values
  ('trial', 'Free Trial', 0, 14),
  ('standard', 'Standard', 0, 0);
