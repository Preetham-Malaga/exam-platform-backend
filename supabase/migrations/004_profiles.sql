-- 004: one profile per Supabase Auth user. is_platform_super_admin marks OUR company staff.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email citext not null,
  full_name text not null default '',
  phone text,
  is_platform_super_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profiles_email_idx on public.profiles (email);
