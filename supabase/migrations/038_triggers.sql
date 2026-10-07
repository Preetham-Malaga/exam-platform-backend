-- 038: triggers. Keep data consistent no matter which code path writes it.

-- updated_at on every table that has the column
create or replace function app.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- Explicit list (not "every table that has the column") so other apps' tables in the same project are never touched.
do $$
declare t text;
begin
  foreach t in array array[
    'academic_levels',
    'academic_units',
    'attempt_answers',
    'courses',
    'exam_attempts',
    'exam_settings',
    'exams',
    'files',
    'leaderboards',
    'organization_members',
    'organization_settings',
    'organizations',
    'profiles',
    'question_answer_keys',
    'question_options',
    'questions',
    'roles',
    'students',
    'subjects',
    'subscriptions',
    'teachers',
    'topics'
  ] loop
    execute format('create trigger trg_set_updated_at before update on public.%I for each row execute function app.set_updated_at()', t);
  end loop;
end $$;

-- a row can never be moved to another organization
create or replace function app.prevent_org_change() returns trigger language plpgsql as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'ORGANIZATION_CHANGE_FORBIDDEN' using errcode = 'EX403';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'academic_levels',
    'academic_units',
    'attempt_answers',
    'audit_logs',
    'courses',
    'exam_assignments',
    'exam_attempts',
    'exam_questions',
    'exam_settings',
    'exams',
    'files',
    'leaderboards',
    'notifications',
    'organization_members',
    'organization_settings',
    'question_answer_keys',
    'question_options',
    'questions',
    'results',
    'roles',
    'students',
    'subjects',
    'subscriptions',
    'teachers',
    'topics',
    'user_roles',
    'user_scopes'
  ] loop
    execute format('create trigger trg_prevent_org_change before update on public.%I for each row execute function app.prevent_org_change()', t);
  end loop;
end $$;

-- protected columns: users cannot grant themselves platform admin or change org status/code
create or replace function app.protect_profile() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') and
     (new.is_platform_super_admin is distinct from old.is_platform_super_admin
      or new.id is distinct from old.id or new.email is distinct from old.email) then
    raise exception 'FORBIDDEN' using errcode = 'EX403';
  end if;
  return new;
end $$;
create trigger trg_protect_profile before update on public.profiles for each row execute function app.protect_profile();

create or replace function app.protect_organization() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') and
     (new.org_code is distinct from old.org_code or new.status is distinct from old.status
      or new.deleted_at is distinct from old.deleted_at or new.created_by is distinct from old.created_by) then
    raise exception 'FORBIDDEN' using errcode = 'EX403';
  end if;
  return new;
end $$;
create trigger trg_protect_organization before update on public.organizations for each row execute function app.protect_organization();

-- audit log is append-only for everyone except system maintenance connections
create or replace function app.audit_immutable() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') then raise exception 'AUDIT_LOG_IMMUTABLE' using errcode = 'EX403'; end if;
  return coalesce(new, old);
end $$;
create trigger trg_audit_immutable before update or delete on public.audit_logs for each row execute function app.audit_immutable();

-- role / scope / assignment targets must belong to the same organization
create or replace function app.validate_user_role() returns trigger language plpgsql as $$
declare r public.roles%rowtype;
begin
  select * into r from public.roles where id = new.role_id;
  if r.scope <> 'organization' or (r.organization_id is not null and r.organization_id <> new.organization_id) then
    raise exception 'INVALID_ROLE' using errcode = 'EX400';
  end if;
  return new;
end $$;
create trigger trg_validate_user_role before insert on public.user_roles for each row execute function app.validate_user_role();

create or replace function app.target_in_org(p_type text, p_id uuid, p_org uuid) returns boolean
language plpgsql stable set search_path = public, pg_temp as $$
begin
  return case p_type
    when 'course'        then exists (select 1 from public.courses where id = p_id and organization_id = p_org)
    when 'academic_unit' then exists (select 1 from public.academic_units where id = p_id and organization_id = p_org)
    when 'subject'       then exists (select 1 from public.subjects where id = p_id and organization_id = p_org)
    when 'student'       then exists (select 1 from public.students where id = p_id and organization_id = p_org)
    when 'organization'  then p_id = p_org
    else false end;
end $$;

create or replace function app.validate_user_scope() returns trigger language plpgsql as $$
begin
  if not app.target_in_org(new.scope_type, new.scope_id, new.organization_id) then
    raise exception 'INVALID_SCOPE_TARGET' using errcode = 'EX400';
  end if;
  return new;
end $$;
create trigger trg_validate_user_scope before insert or update on public.user_scopes for each row execute function app.validate_user_scope();

create or replace function app.validate_exam_assignment() returns trigger language plpgsql as $$
begin
  if not app.target_in_org(new.target_type, new.target_id, new.organization_id) then
    raise exception 'INVALID_ASSIGNMENT_TARGET' using errcode = 'EX400';
  end if;
  return new;
end $$;
create trigger trg_validate_exam_assignment before insert or update on public.exam_assignments for each row execute function app.validate_exam_assignment();

-- a question can only be published when it is complete
create or replace function app.validate_question_publish() returns trigger language plpgsql as $$
declare v_opts int; v_key uuid;
begin
  if new.status = 'published' then
    if tg_op = 'INSERT' then raise exception 'QUESTION_INCOMPLETE' using errcode = 'EX422'; end if;
    select count(*) into v_opts from public.question_options where question_id = new.id;
    select correct_option_id into v_key from public.question_answer_keys where question_id = new.id;
    if v_opts < 2 or v_key is null or (new.question_type = 'true_false' and v_opts <> 2) then
      raise exception 'QUESTION_INCOMPLETE' using errcode = 'EX422';
    end if;
  end if;
  return new;
end $$;
create trigger trg_validate_question_publish before insert or update of status on public.questions for each row execute function app.validate_question_publish();

-- an exam can only be published when it has settings and questions
create or replace function app.validate_exam_publish() returns trigger language plpgsql as $$
begin
  if new.status = 'published' and (tg_op = 'INSERT' or old.status is distinct from 'published') then
    if tg_op = 'INSERT'
       or not exists (select 1 from public.exam_settings where exam_id = new.id)
       or not exists (select 1 from public.exam_questions where exam_id = new.id) then
      raise exception 'EXAM_INCOMPLETE' using errcode = 'EX422';
    end if;
  end if;
  return new;
end $$;
create trigger trg_validate_exam_publish before insert or update of status on public.exams for each row execute function app.validate_exam_publish();

-- exam_questions: snapshot marks, default position, only published questions, frozen once attempts exist
-- SECURITY DEFINER so a question hidden by RLS (another teacher's scope) is reported by the RLS WITH CHECK (403), not as "not published".
create or replace function app.exam_questions_guard() returns trigger language plpgsql
security definer set search_path = public, pg_temp as $$
declare v_exam uuid := coalesce(new.exam_id, old.exam_id); q public.questions%rowtype;
begin
  -- A cascade (deleting the exam or the whole organization) runs this trigger nested (depth > 1) and must be allowed.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  if exists (select 1 from public.exam_attempts where exam_id = v_exam) then
    raise exception 'EXAM_HAS_ATTEMPTS' using errcode = 'EX409';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  select * into q from public.questions where id = new.question_id and organization_id = new.organization_id;
  if q.id is null or q.deleted_at is not null or q.status <> 'published' then
    raise exception 'QUESTION_NOT_PUBLISHED' using errcode = 'EX422';
  end if;
  if tg_op = 'INSERT' or new.question_id is distinct from old.question_id then
    new.marks := q.marks;
    new.negative_marks := q.negative_marks;
  end if;
  if new.position is null then
    select coalesce(max(position), 0) + 1 into new.position from public.exam_questions where exam_id = new.exam_id;
  end if;
  return new;
end $$;
create trigger trg_exam_questions_guard before insert or update or delete on public.exam_questions for each row execute function app.exam_questions_guard();

-- plan limits are enforced here, never only in the UI
create or replace function app.enforce_plan_limit() returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_key text := tg_argv[0]; v_limit int; v_status text; v_trial timestamptz; v_used numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text || ':' || v_key, 0));
  select s.status, s.trial_ends_at, pl.limit_value into v_status, v_trial, v_limit
  from public.subscriptions s
  join public.plan_limits pl on pl.plan_id = s.plan_id and pl.limit_key = v_key
  where s.organization_id = new.organization_id and s.status in ('trialing', 'active') limit 1;
  if v_limit is null or (v_status = 'trialing' and v_trial is not null and v_trial < now()) then
    raise exception 'SUBSCRIPTION_INACTIVE' using errcode = 'EX402';
  end if;
  v_used := case v_key
    when 'students'  then (select count(*) from public.students  where organization_id = new.organization_id and deleted_at is null)
    when 'teachers'  then (select count(*) from public.teachers  where organization_id = new.organization_id and deleted_at is null)
    when 'questions' then (select count(*) from public.questions where organization_id = new.organization_id and deleted_at is null)
    when 'exams'     then (select count(*) from public.exams     where organization_id = new.organization_id and deleted_at is null)
    when 'storage_mb' then (select coalesce(sum(size_bytes), 0) / 1048576.0 from public.files where organization_id = new.organization_id and deleted_at is null)
  end;
  if v_key = 'storage_mb' then
    if v_used + (new.size_bytes / 1048576.0) > v_limit then
      raise exception 'PLAN_LIMIT_REACHED' using errcode = 'EX402', detail = v_key;
    end if;
  elsif v_used >= v_limit then
    raise exception 'PLAN_LIMIT_REACHED' using errcode = 'EX402', detail = v_key;
  end if;
  return new;
end $$;
create trigger trg_limit_students  before insert on public.students  for each row execute function app.enforce_plan_limit('students');
create trigger trg_limit_teachers  before insert on public.teachers  for each row execute function app.enforce_plan_limit('teachers');
create trigger trg_limit_questions before insert on public.questions for each row execute function app.enforce_plan_limit('questions');
create trigger trg_limit_exams     before insert on public.exams     for each row execute function app.enforce_plan_limit('exams');
create trigger trg_limit_files     before insert on public.files     for each row execute function app.enforce_plan_limit('storage_mb');
