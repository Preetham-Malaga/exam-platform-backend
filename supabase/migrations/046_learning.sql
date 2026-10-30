-- 046: Learning (prototype Live Classes, Recorded Classes, Materials). Staff schedule classes and share videos and
-- materials with a batch; students see only what belongs to their own batch. Video and material files are links
-- (Zoom / Meet / Teams, YouTube / Vimeo / Drive); uploads to storage come later.
-- Only additions: three new tables and two new permissions. No existing row or value changes.
-- Undo: supabase/rollbacks/046_learning.down.sql

insert into public.permissions (code, description) values
  ('learning.read', 'View live classes, recordings and materials'),
  ('learning.manage', 'Schedule live classes, add recordings and materials');
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in ('learning.read', 'learning.manage')
where r.code in ('ORGANIZATION_OWNER', 'ORGANIZATION_ADMIN', 'TEACHER');
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code = 'learning.read'
where r.code = 'STUDENT';

create table public.live_classes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  course_id uuid,
  subject_id uuid,
  topic_id uuid,
  batch_id uuid not null,
  teacher_id uuid,
  agenda text check (agenda is null or char_length(agenda) <= 1000),
  starts_at timestamptz not null,
  duration_minutes int not null check (duration_minutes between 5 and 600),
  platform text not null default 'Google Meet' check (platform in ('Zoom', 'Google Meet', 'Microsoft Teams', 'Other')),
  meeting_link text not null check (meeting_link ~ '^https?://' and char_length(meeting_link) <= 500),
  meeting_id text check (meeting_id is null or char_length(meeting_id) <= 60),
  passcode text check (passcode is null or char_length(passcode) <= 60),
  will_record boolean not null default false,
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  created_by uuid default auth.uid() references auth.users (id),
  updated_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, course_id) references public.courses (organization_id, id),
  foreign key (organization_id, subject_id) references public.subjects (organization_id, id),
  foreign key (organization_id, batch_id) references public.batches (organization_id, id),
  foreign key (organization_id, teacher_id) references public.teachers (organization_id, id)
);
create index live_classes_org_start_idx on public.live_classes (organization_id, starts_at) where deleted_at is null;

create table public.recordings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  course_id uuid,
  subject_id uuid,
  topic_id uuid,
  batch_id uuid not null,
  teacher_id uuid,
  source text not null default 'YouTube' check (source in ('YouTube', 'Vimeo', 'Google Drive', 'Other link')),
  video_url text not null check (video_url ~ '^https?://' and char_length(video_url) <= 500),
  duration text check (duration is null or char_length(duration) <= 20),
  live_class_id uuid,
  description text check (description is null or char_length(description) <= 2000),
  available_from date,
  available_until date,
  allow_download boolean not null default false,
  status text not null default 'published' check (status in ('draft', 'published')),
  created_by uuid default auth.uid() references auth.users (id),
  updated_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, id),
  check (available_until is null or available_from is null or available_until >= available_from),
  foreign key (organization_id, course_id) references public.courses (organization_id, id),
  foreign key (organization_id, subject_id) references public.subjects (organization_id, id),
  foreign key (organization_id, batch_id) references public.batches (organization_id, id),
  foreign key (organization_id, teacher_id) references public.teachers (organization_id, id),
  foreign key (organization_id, live_class_id) references public.live_classes (organization_id, id)
);

create table public.materials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  material_type text not null default 'Notes'
    check (material_type in ('Notes', 'Slides', 'Question paper', 'Assignment', 'Syllabus', 'Reference', 'Other')),
  course_id uuid,
  subject_id uuid,
  topic_id uuid,
  batch_id uuid not null,
  link_url text not null check (link_url ~ '^https?://' and char_length(link_url) <= 500),
  description text check (description is null or char_length(description) <= 1000),
  available_from date,
  allow_download boolean not null default true,
  status text not null default 'published' check (status in ('draft', 'published')),
  created_by uuid default auth.uid() references auth.users (id),
  updated_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, course_id) references public.courses (organization_id, id),
  foreign key (organization_id, subject_id) references public.subjects (organization_id, id),
  foreign key (organization_id, batch_id) references public.batches (organization_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['live_classes', 'recordings', 'materials'] loop
    execute format('create trigger trg_set_updated_at before update on public.%I for each row execute function app.set_updated_at()', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke truncate, references, trigger on table public.%I from authenticated', t);
    execute format('alter table public.%I enable row level security', t);
    -- Staff with learning.manage see everything in their organization; a student sees what belongs to their batch
    -- (published, and for classes not cancelled).
    execute format($p$create policy %1$s_select on public.%1$I for select to authenticated using (
      app.has_permission(organization_id, 'learning.manage')
      or (app.has_permission(organization_id, 'learning.read') and exists (
            select 1 from public.students s where s.organization_id = %1$I.organization_id
              and s.user_id = auth.uid() and s.deleted_at is null and s.batch_id = %1$I.batch_id)
          and %2$s))$p$, t,
      case when t = 'live_classes' then $c$status = 'scheduled'$c$ else $c$status = 'published'$c$ end);
    execute format($p$create policy %1$s_insert on public.%1$I for insert to authenticated
      with check (app.has_permission(organization_id, 'learning.manage'))$p$, t);
    execute format($p$create policy %1$s_update on public.%1$I for update to authenticated
      using (app.has_permission(organization_id, 'learning.manage'))
      with check (app.has_permission(organization_id, 'learning.manage'))$p$, t);
    execute format($p$create policy %1$s_delete on public.%1$I for delete to authenticated
      using (app.has_permission(organization_id, 'learning.manage'))$p$, t);
  end loop;
end $$;
