-- 036: Row Level Security. PART 1 = reusable helper functions (policies need them, so they come first).
-- PART 2 = privileges. PART 3 = policies for every table. PART 4 = storage policies.
-- All helpers are SECURITY DEFINER with a fixed search_path so they can read membership/role tables
-- without recursing into those tables' own policies. They only ever look at auth.uid().

-- ===== PART 1: helpers =====
create or replace function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select p.is_platform_super_admin from public.profiles p where p.id = auth.uid()), false)
$$;

create or replace function app.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = p_org and m.user_id = auth.uid() and m.status = 'active'
      and o.deleted_at is null and o.status in ('pending_email','active')
  )
$$;

create or replace function app.has_role(p_org uuid, p_role_code text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_org_member(p_org) and exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.organization_id = p_org and ur.user_id = auth.uid() and r.code = p_role_code
  )
$$;

create or replace function app.is_org_admin(p_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_role(p_org, 'ORGANIZATION_OWNER') or app.has_role(p_org, 'ORGANIZATION_ADMIN')
$$;

create or replace function app.has_permission(p_org uuid, p_permission text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_org_member(p_org) and exists (
    select 1 from public.user_roles ur
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions pm on pm.id = rp.permission_id
    where ur.organization_id = p_org and ur.user_id = auth.uid() and pm.code = p_permission
  )
$$;

-- All ids from a unit up to the root (the unit itself included).
create or replace function app.unit_chain(p_org uuid, p_unit uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  with recursive chain as (
    select u.id, u.parent_id from public.academic_units u
    where u.organization_id = p_org and u.id = p_unit
    union
    select u.id, u.parent_id from public.academic_units u
    join chain c on u.id = c.parent_id where u.organization_id = p_org
  ) select id from chain
$$;

-- Teacher scope: admins/owners see everything; teachers only subjects they were assigned
-- (directly, through the subject's course, or through the subject's academic unit or any parent unit).
-- NOTE: used inside policies of the table that holds the row itself (INSERT ... RETURNING), so it must NOT re-read that
-- row to prove it exists. Cross-organization ids are rejected by the composite foreign keys instead.
create or replace function app.in_scope(p_org uuid, p_subject uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_org_admin(p_org) or (
    app.is_org_member(p_org) and exists (
      select 1 from public.subjects s
      where s.id = p_subject and s.organization_id = p_org and exists (
        select 1 from public.user_scopes us
        where us.organization_id = p_org and us.user_id = auth.uid() and (
          (us.scope_type = 'subject' and us.scope_id = s.id)
          or (us.scope_type = 'course' and s.course_id is not null and us.scope_id = s.course_id)
          or (us.scope_type = 'academic_unit' and s.academic_unit_id is not null
              and us.scope_id in (select app.unit_chain(p_org, s.academic_unit_id)))
        )
      )
    )
  )
$$;

create or replace function app.course_in_scope(p_org uuid, p_course uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_org_admin(p_org) or (
    app.is_org_member(p_org) and exists (
      select 1 from public.courses c
      where c.id = p_course and c.organization_id = p_org and (
        exists (select 1 from public.user_scopes us where us.organization_id = p_org
                and us.user_id = auth.uid() and us.scope_type = 'course' and us.scope_id = c.id)
        or (c.academic_unit_id is not null and exists (
              select 1 from public.user_scopes us where us.organization_id = p_org
              and us.user_id = auth.uid() and us.scope_type = 'academic_unit'
              and us.scope_id in (select app.unit_chain(p_org, c.academic_unit_id))))
        or exists (select 1 from public.subjects s where s.organization_id = p_org and s.course_id = c.id
                   and app.in_scope(p_org, s.id))
      )
    )
  )
$$;

create or replace function app.question_in_scope(p_org uuid, p_question uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.questions q
                 where q.id = p_question and q.organization_id = p_org and app.in_scope(p_org, q.subject_id))
$$;

create or replace function app.exam_accessible(p_org uuid, p_exam uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_org_member(p_org) and exists (
    select 1 from public.exams e
    where e.id = p_exam and e.organization_id = p_org
      and (e.created_by = auth.uid() or app.is_org_admin(p_org))
  )
$$;

create or replace function app.is_own_student(p_org uuid, p_student uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_org_member(p_org) and exists (
    select 1 from public.students s
    where s.id = p_student and s.organization_id = p_org and s.user_id = auth.uid() and s.deleted_at is null
  )
$$;

create or replace function app.is_own_attempt(p_org uuid, p_attempt uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.exam_attempts a
                 where a.id = p_attempt and a.organization_id = p_org and app.is_own_student(p_org, a.student_id))
$$;

create or replace function app.attempt_exam_accessible(p_org uuid, p_attempt uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.exam_attempts a
                 where a.id = p_attempt and a.organization_id = p_org and app.exam_accessible(p_org, a.exam_id))
$$;

create or replace function app.exam_shows_results(p_org uuid, p_exam uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select s.show_results from public.exam_settings s
                   where s.exam_id = p_exam and s.organization_id = p_org), false)
$$;

create or replace function app.exam_leaderboard_enabled(p_org uuid, p_exam uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select s.leaderboard_enabled from public.exam_settings s
                   where s.exam_id = p_exam and s.organization_id = p_org), false)
$$;

create or replace function app.can_view_leaderboard(p_org uuid, p_exam uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_permission(p_org, 'leaderboard.read')
     and (app.exam_accessible(p_org, p_exam) or app.exam_leaderboard_enabled(p_org, p_exam))
$$;

-- Who may grant/remove which role. OWNER can never be granted through the API; only the owner grants ADMIN.
create or replace function app.can_assign_role(p_org uuid, p_role uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.roles r
    where r.id = p_role and r.scope = 'organization'
      and (r.organization_id is null or r.organization_id = p_org)
      and (r.code in ('TEACHER','STUDENT')
           or (r.code = 'ORGANIZATION_ADMIN' and app.has_role(p_org, 'ORGANIZATION_OWNER')))
  )
$$;

create or replace function app.is_owner_user(p_org uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
                 where ur.organization_id = p_org and ur.user_id = p_user and r.code = 'ORGANIZATION_OWNER')
$$;

create or replace function app.storage_org(p_name text) returns uuid
language sql immutable as $$
  select case
    when (string_to_array(p_name, '/'))[1] = 'organizations'
     and (string_to_array(p_name, '/'))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then ((string_to_array(p_name, '/'))[2])::uuid end
$$;

grant execute on function
  app.is_platform_admin(), app.is_org_member(uuid), app.has_role(uuid, text), app.is_org_admin(uuid),
  app.has_permission(uuid, text), app.unit_chain(uuid, uuid), app.in_scope(uuid, uuid),
  app.course_in_scope(uuid, uuid), app.question_in_scope(uuid, uuid), app.exam_accessible(uuid, uuid),
  app.is_own_student(uuid, uuid), app.is_own_attempt(uuid, uuid), app.attempt_exam_accessible(uuid, uuid),
  app.exam_shows_results(uuid, uuid), app.exam_leaderboard_enabled(uuid, uuid),
  app.can_view_leaderboard(uuid, uuid), app.can_assign_role(uuid, uuid), app.is_owner_user(uuid, uuid), app.storage_org(text)
to authenticated, service_role;

-- ===== PART 2: privileges (defence in depth on top of RLS) =====
-- Only THIS platform's tables are named here on purpose: the migration must never touch other tables that may live in
-- the same Supabase project. Any table added by a later migration needs its own explicit REVOKE ... FROM anon.
revoke all on table
    public.academic_levels,
    public.academic_units,
    public.attempt_answers,
    public.audit_logs,
    public.courses,
    public.exam_assignments,
    public.exam_attempts,
    public.exam_questions,
    public.exam_settings,
    public.exams,
    public.files,
    public.leaderboards,
    public.notifications,
    public.organization_members,
    public.organization_settings,
    public.organizations,
    public.permissions,
    public.plan_limits,
    public.plans,
    public.profiles,
    public.question_answer_keys,
    public.question_options,
    public.question_types,
    public.questions,
    public.results,
    public.role_permissions,
    public.roles,
    public.students,
    public.subjects,
    public.subscriptions,
    public.teachers,
    public.topics,
    public.user_roles,
    public.user_scopes
  from anon;
revoke truncate, references, trigger on table
    public.academic_levels,
    public.academic_units,
    public.attempt_answers,
    public.audit_logs,
    public.courses,
    public.exam_assignments,
    public.exam_attempts,
    public.exam_questions,
    public.exam_settings,
    public.exams,
    public.files,
    public.leaderboards,
    public.notifications,
    public.organization_members,
    public.organization_settings,
    public.organizations,
    public.permissions,
    public.plan_limits,
    public.plans,
    public.profiles,
    public.question_answer_keys,
    public.question_options,
    public.question_types,
    public.questions,
    public.results,
    public.role_permissions,
    public.roles,
    public.students,
    public.subjects,
    public.subscriptions,
    public.teachers,
    public.topics,
    public.user_roles,
    public.user_scopes
  from authenticated;
-- Tables the browser/user JWT may only READ; every write goes through SECURITY DEFINER functions or the backend.
revoke insert, update, delete on public.exam_attempts, public.attempt_answers, public.results,
  public.leaderboards, public.audit_logs, public.permissions, public.role_permissions,
  public.question_types, public.subscriptions from authenticated;
revoke insert, delete on public.organizations, public.organization_settings, public.profiles,
  public.notifications, public.organization_members from authenticated;
revoke update on public.user_roles, public.user_scopes, public.exam_assignments from authenticated;
-- Plans can only be changed by the platform (backend system connection).
revoke insert, update, delete on public.plans, public.plan_limits from authenticated;

-- ===== PART 3: policies =====
-- NOTE on soft delete: SELECT policies deliberately do NOT filter deleted_at. PostgreSQL also checks the SELECT policy
-- against the NEW row of an UPDATE, so hiding deleted rows here would make "soft delete" impossible. Every API query
-- filters "deleted_at is null" explicitly; deleted rows stay inside the owner's organization for audit/history.
alter table public.organizations enable row level security;
alter table public.organization_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.organization_members enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_roles enable row level security;
alter table public.user_scopes enable row level security;
alter table public.academic_levels enable row level security;
alter table public.academic_units enable row level security;
alter table public.courses enable row level security;
alter table public.subjects enable row level security;
alter table public.topics enable row level security;
alter table public.students enable row level security;
alter table public.teachers enable row level security;
alter table public.question_types enable row level security;
alter table public.questions enable row level security;
alter table public.question_options enable row level security;
alter table public.question_answer_keys enable row level security;
alter table public.files enable row level security;
alter table public.exams enable row level security;
alter table public.exam_settings enable row level security;
alter table public.exam_questions enable row level security;
alter table public.exam_assignments enable row level security;
alter table public.exam_attempts enable row level security;
alter table public.attempt_answers enable row level security;
alter table public.results enable row level security;
alter table public.leaderboards enable row level security;
alter table public.plans enable row level security;
alter table public.plan_limits enable row level security;
alter table public.subscriptions enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_logs enable row level security;

-- organizations / settings (Platform Super Admin may read organizations but NEVER org content)
create policy organizations_select on public.organizations for select to authenticated
  using (app.is_org_member(id) or app.is_platform_admin());
create policy organizations_update on public.organizations for update to authenticated
  using (app.has_permission(id, 'organization.update'))
  with check (app.has_permission(id, 'organization.update'));
create policy org_settings_select on public.organization_settings for select to authenticated
  using (app.is_org_member(organization_id));
create policy org_settings_update on public.organization_settings for update to authenticated
  using (app.has_permission(organization_id, 'settings.update'))
  with check (app.has_permission(organization_id, 'settings.update'));

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or app.is_platform_admin() or exists (
    select 1 from public.organization_members m
    where m.user_id = profiles.id and app.has_permission(m.organization_id, 'user.read')));
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- membership / roles
create policy members_select on public.organization_members for select to authenticated
  using (user_id = auth.uid() or app.has_permission(organization_id, 'user.read'));
create policy members_update on public.organization_members for update to authenticated
  using (app.has_permission(organization_id, 'user.update')
         and (app.has_role(organization_id, 'ORGANIZATION_OWNER') or not app.is_owner_user(organization_id, user_id)))
  with check (app.has_permission(organization_id, 'user.update'));
create policy roles_select on public.roles for select to authenticated
  using (organization_id is null or app.is_org_member(organization_id));
create policy permissions_select on public.permissions for select to authenticated using (true);
create policy role_permissions_select on public.role_permissions for select to authenticated using (true);
create policy question_types_select on public.question_types for select to authenticated using (true);

create policy user_roles_select on public.user_roles for select to authenticated
  using (user_id = auth.uid() or app.has_permission(organization_id, 'user.read'));
create policy user_roles_insert on public.user_roles for insert to authenticated
  with check (app.has_permission(organization_id, 'user.update') and app.can_assign_role(organization_id, role_id));
create policy user_roles_delete on public.user_roles for delete to authenticated
  using (app.has_permission(organization_id, 'user.update') and app.can_assign_role(organization_id, role_id));

create policy user_scopes_select on public.user_scopes for select to authenticated
  using (user_id = auth.uid() or app.has_permission(organization_id, 'teacher.read'));
create policy user_scopes_insert on public.user_scopes for insert to authenticated
  with check (app.has_permission(organization_id, 'teacher.assign_scope'));
create policy user_scopes_delete on public.user_scopes for delete to authenticated
  using (app.has_permission(organization_id, 'teacher.assign_scope'));

-- academic structure
create policy academic_levels_select on public.academic_levels for select to authenticated
  using (app.is_org_member(organization_id));
create policy academic_levels_write on public.academic_levels for all to authenticated
  using (app.has_permission(organization_id, 'academic.manage'))
  with check (app.has_permission(organization_id, 'academic.manage'));
create policy academic_units_select on public.academic_units for select to authenticated
  using (app.is_org_member(organization_id));
create policy academic_units_write on public.academic_units for all to authenticated
  using (app.has_permission(organization_id, 'academic.manage'))
  with check (app.has_permission(organization_id, 'academic.manage'));

create policy courses_select on public.courses for select to authenticated
  using (app.has_permission(organization_id, 'course.read')
         and app.course_in_scope(organization_id, id));
create policy courses_insert on public.courses for insert to authenticated
  with check (app.has_permission(organization_id, 'course.create'));
create policy courses_update on public.courses for update to authenticated
  using (app.has_permission(organization_id, 'course.update') and app.course_in_scope(organization_id, id))
  with check (app.has_permission(organization_id, 'course.update'));
create policy courses_delete on public.courses for delete to authenticated
  using (app.has_permission(organization_id, 'course.delete'));

create policy subjects_select on public.subjects for select to authenticated
  using (app.has_permission(organization_id, 'subject.read')
         and app.in_scope(organization_id, id));
create policy subjects_insert on public.subjects for insert to authenticated
  with check (app.has_permission(organization_id, 'subject.create'));
create policy subjects_update on public.subjects for update to authenticated
  using (app.has_permission(organization_id, 'subject.update') and app.in_scope(organization_id, id))
  with check (app.has_permission(organization_id, 'subject.update'));
create policy subjects_delete on public.subjects for delete to authenticated
  using (app.has_permission(organization_id, 'subject.delete'));

create policy topics_select on public.topics for select to authenticated
  using (app.has_permission(organization_id, 'topic.read')
         and app.in_scope(organization_id, subject_id));
create policy topics_insert on public.topics for insert to authenticated
  with check (app.has_permission(organization_id, 'topic.create') and app.in_scope(organization_id, subject_id));
create policy topics_update on public.topics for update to authenticated
  using (app.has_permission(organization_id, 'topic.update') and app.in_scope(organization_id, subject_id))
  with check (app.has_permission(organization_id, 'topic.update') and app.in_scope(organization_id, subject_id));
create policy topics_delete on public.topics for delete to authenticated
  using (app.has_permission(organization_id, 'topic.delete') and app.in_scope(organization_id, subject_id));

-- people
create policy students_select on public.students for select to authenticated
  using ((app.has_permission(organization_id, 'student.read')
         or (user_id = auth.uid() and app.is_org_member(organization_id))));
create policy students_insert on public.students for insert to authenticated
  with check (app.has_permission(organization_id, 'student.create'));
create policy students_update on public.students for update to authenticated
  using (app.has_permission(organization_id, 'student.update'))
  with check (app.has_permission(organization_id, 'student.update'));
create policy students_delete on public.students for delete to authenticated
  using (app.has_permission(organization_id, 'student.delete'));

create policy teachers_select on public.teachers for select to authenticated
  using ((app.has_permission(organization_id, 'teacher.read')
         or (user_id = auth.uid() and app.is_org_member(organization_id))));
create policy teachers_insert on public.teachers for insert to authenticated
  with check (app.has_permission(organization_id, 'teacher.create'));
create policy teachers_update on public.teachers for update to authenticated
  using (app.has_permission(organization_id, 'teacher.update'))
  with check (app.has_permission(organization_id, 'teacher.update'));
create policy teachers_delete on public.teachers for delete to authenticated
  using (app.has_permission(organization_id, 'teacher.delete'));

-- question bank (students hold none of these permissions, so they can never read questions or keys directly)
create policy questions_select on public.questions for select to authenticated
  using (app.has_permission(organization_id, 'question.read')
         and app.in_scope(organization_id, subject_id));
create policy questions_insert on public.questions for insert to authenticated
  with check (app.has_permission(organization_id, 'question.create')
              and app.in_scope(organization_id, subject_id)
              and created_by = auth.uid());
create policy questions_update on public.questions for update to authenticated
  using (app.has_permission(organization_id, 'question.update') and app.in_scope(organization_id, subject_id))
  with check (app.has_permission(organization_id, 'question.update')
              and app.in_scope(organization_id, subject_id)
              and (status <> 'published' or app.has_permission(organization_id, 'question.publish')));
create policy questions_delete on public.questions for delete to authenticated
  using (app.has_permission(organization_id, 'question.delete') and app.in_scope(organization_id, subject_id));

create policy question_options_select on public.question_options for select to authenticated
  using (app.has_permission(organization_id, 'question.read') and app.question_in_scope(organization_id, question_id));
create policy question_options_write on public.question_options for all to authenticated
  using ((app.has_permission(organization_id, 'question.update') or app.has_permission(organization_id, 'question.create'))
         and app.question_in_scope(organization_id, question_id))
  with check ((app.has_permission(organization_id, 'question.update') or app.has_permission(organization_id, 'question.create'))
              and app.question_in_scope(organization_id, question_id));

create policy answer_keys_select on public.question_answer_keys for select to authenticated
  using (app.has_permission(organization_id, 'question.read') and app.question_in_scope(organization_id, question_id));
create policy answer_keys_write on public.question_answer_keys for all to authenticated
  using ((app.has_permission(organization_id, 'question.update') or app.has_permission(organization_id, 'question.create'))
         and app.question_in_scope(organization_id, question_id))
  with check ((app.has_permission(organization_id, 'question.update') or app.has_permission(organization_id, 'question.create'))
              and app.question_in_scope(organization_id, question_id));

create policy files_select on public.files for select to authenticated
  using ((uploaded_by = auth.uid() or app.has_permission(organization_id, 'settings.read')));
create policy files_insert on public.files for insert to authenticated
  with check (uploaded_by = auth.uid() and (app.has_permission(organization_id, 'settings.update')
              or app.has_permission(organization_id, 'question.create')));
create policy files_update on public.files for update to authenticated
  using (uploaded_by = auth.uid() or app.has_permission(organization_id, 'settings.update'))
  with check (app.is_org_member(organization_id));

-- exams (students read exams only through app.available_exams(), never the table).
-- NOTE: the creator check is inline (not app.exam_accessible) because INSERT ... RETURNING must see its own new row.
create policy exams_select on public.exams for select to authenticated
  using (app.has_permission(organization_id, 'exam.read')
         and (created_by = auth.uid() or app.is_org_admin(organization_id)));
create policy exams_insert on public.exams for insert to authenticated
  with check (app.has_permission(organization_id, 'exam.create') and created_by = auth.uid()
              and status = 'draft');
create policy exams_update on public.exams for update to authenticated
  using (app.has_permission(organization_id, 'exam.update')
         and (created_by = auth.uid() or app.is_org_admin(organization_id)))
  with check (app.has_permission(organization_id, 'exam.update')
              and (status = 'draft' or status = 'archived'
                   or (status = 'published' and app.has_permission(organization_id, 'exam.publish'))
                   or (status = 'unpublished' and app.has_permission(organization_id, 'exam.unpublish'))));
create policy exams_delete on public.exams for delete to authenticated
  using (app.has_permission(organization_id, 'exam.delete')
         and (created_by = auth.uid() or app.is_org_admin(organization_id)));

create policy exam_settings_select on public.exam_settings for select to authenticated
  using (app.has_permission(organization_id, 'exam.read') and app.exam_accessible(organization_id, exam_id));
create policy exam_settings_write on public.exam_settings for all to authenticated
  using ((app.has_permission(organization_id, 'exam.update') or app.has_permission(organization_id, 'exam.create'))
         and app.exam_accessible(organization_id, exam_id))
  with check ((app.has_permission(organization_id, 'exam.update') or app.has_permission(organization_id, 'exam.create'))
              and app.exam_accessible(organization_id, exam_id));

create policy exam_questions_select on public.exam_questions for select to authenticated
  using (app.has_permission(organization_id, 'exam.read') and app.exam_accessible(organization_id, exam_id));
create policy exam_questions_write on public.exam_questions for all to authenticated
  using ((app.has_permission(organization_id, 'exam.update') or app.has_permission(organization_id, 'exam.create'))
         and app.exam_accessible(organization_id, exam_id))
  with check ((app.has_permission(organization_id, 'exam.update') or app.has_permission(organization_id, 'exam.create'))
              and app.exam_accessible(organization_id, exam_id)
              and app.question_in_scope(organization_id, question_id));

create policy exam_assignments_select on public.exam_assignments for select to authenticated
  using (app.has_permission(organization_id, 'exam.read') and app.exam_accessible(organization_id, exam_id));
create policy exam_assignments_insert on public.exam_assignments for insert to authenticated
  with check (app.has_permission(organization_id, 'exam.assign') and app.exam_accessible(organization_id, exam_id));
create policy exam_assignments_delete on public.exam_assignments for delete to authenticated
  using (app.has_permission(organization_id, 'exam.assign') and app.exam_accessible(organization_id, exam_id));

-- attempts / answers / results / leaderboard: READ-ONLY for users; writes happen inside app.* exam-engine functions
create policy exam_attempts_select on public.exam_attempts for select to authenticated
  using (app.is_own_student(organization_id, student_id)
         or (app.has_permission(organization_id, 'result.read') and app.exam_accessible(organization_id, exam_id)));
create policy attempt_answers_select on public.attempt_answers for select to authenticated
  using (app.is_own_attempt(organization_id, attempt_id)
         or (app.has_permission(organization_id, 'result.read') and app.attempt_exam_accessible(organization_id, attempt_id)));
create policy results_select on public.results for select to authenticated
  using ((app.is_own_student(organization_id, student_id) and app.exam_shows_results(organization_id, exam_id))
         or (app.has_permission(organization_id, 'result.read') and app.exam_accessible(organization_id, exam_id)));
create policy leaderboards_select on public.leaderboards for select to authenticated
  using (app.can_view_leaderboard(organization_id, exam_id));

-- platform catalogue and billing
create policy plans_select on public.plans for select to authenticated using (true);
create policy plan_limits_select on public.plan_limits for select to authenticated using (true);
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (app.has_permission(organization_id, 'subscription.read') or app.is_platform_admin());

create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid() and app.is_org_member(organization_id));
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = auth.uid() and app.is_org_member(organization_id))
  with check (user_id = auth.uid());

create policy audit_logs_select on public.audit_logs for select to authenticated
  using (app.is_platform_admin()
         or (organization_id is not null and app.has_permission(organization_id, 'audit.read')));

-- ===== PART 4: storage (only where Supabase Storage exists) =====
do $$
begin
  if to_regclass('storage.objects') is not null then
    insert into storage.buckets (id, name, public) values ('org-files', 'org-files', false)
      on conflict (id) do nothing;
    create policy org_files_select on storage.objects for select to authenticated
      using (bucket_id = 'org-files' and app.storage_org(name) is not null
             and app.has_permission(app.storage_org(name), 'settings.read'));
    create policy org_files_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'org-files' and app.storage_org(name) is not null
             and (app.has_permission(app.storage_org(name), 'settings.update')
                  or app.has_permission(app.storage_org(name), 'question.create')));
    create policy org_files_delete on storage.objects for delete to authenticated
      using (bucket_id = 'org-files' and app.storage_org(name) is not null
             and app.has_permission(app.storage_org(name), 'settings.update'));
  end if;
end $$;
