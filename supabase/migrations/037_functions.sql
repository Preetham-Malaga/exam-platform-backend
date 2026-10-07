-- 037: business functions. Security-critical logic lives in the database so it is atomic and cannot be skipped.
--  SYSTEM functions (service role / backend system connection only): register_organization, activate_organization, add_member, finalize_attempt
--  USER functions (SECURITY DEFINER but check auth.uid() themselves): the exam engine + leaderboard.
-- Error convention: raise exception '<CODE>' using errcode = 'EXnnn'. The backend maps CODE to an HTTP status.

create or replace function app.default_levels(p_type text) returns text[]
language sql immutable as $$
  select case p_type
    when 'engineering' then array['Program','Branch','Year','Semester']
    when 'degree'      then array['Program','Year','Semester']
    when 'school'      then array['Class','Section']
    when 'mba'         then array['Program','Specialization','Semester']
    else                    array['Program','Batch']
  end
$$;

-- ---------- registration (one transaction: all rows or none) ----------
create or replace function app.register_organization(
  p_user_id uuid, p_email text, p_owner_name text, p_org_name text, p_institution_type text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org uuid; v_owner_role uuid; v_plan uuid; v_trial_days int; v_names text[]; i int;
begin
  insert into public.profiles (id, email, full_name) values (p_user_id, p_email, p_owner_name)
    on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;

  insert into public.organizations (name, institution_type, contact_email, created_by)
    values (p_org_name, p_institution_type, p_email, p_user_id) returning id into v_org;
  insert into public.organization_settings (organization_id, created_by) values (v_org, p_user_id);
  insert into public.organization_members (organization_id, user_id, created_by) values (v_org, p_user_id, p_user_id);

  select id into v_owner_role from public.roles where code = 'ORGANIZATION_OWNER' and organization_id is null;
  insert into public.user_roles (organization_id, user_id, role_id, created_by) values (v_org, p_user_id, v_owner_role, p_user_id);

  select id, trial_days into v_plan, v_trial_days from public.plans where code = 'trial';
  insert into public.subscriptions (organization_id, plan_id, status, trial_ends_at, created_by)
    values (v_org, v_plan, 'trialing', now() + make_interval(days => v_trial_days), p_user_id);

  v_names := app.default_levels(p_institution_type);
  for i in 1 .. coalesce(array_length(v_names, 1), 0) loop
    insert into public.academic_levels (organization_id, code, name, position, created_by)
      values (v_org, lower(regexp_replace(v_names[i], '[^a-zA-Z0-9]+', '_', 'g')), v_names[i], i, p_user_id);
  end loop;
  return v_org;
end $$;

create or replace function app.activate_organization(p_org uuid) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.organizations set status = 'active' where id = p_org and status = 'pending_email'
$$;

create or replace function app.add_member(
  p_org uuid, p_user_id uuid, p_email text, p_full_name text, p_role_code text, p_actor uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_role uuid; v_member uuid;
begin
  if p_role_code not in ('ORGANIZATION_ADMIN','TEACHER','STUDENT') then
    raise exception 'INVALID_ROLE' using errcode = 'EX400';
  end if;
  select id into v_role from public.roles where code = p_role_code and organization_id is null;
  insert into public.profiles (id, email, full_name) values (p_user_id, p_email, coalesce(p_full_name, ''))
    on conflict (id) do update set full_name = case when public.profiles.full_name = '' then excluded.full_name else public.profiles.full_name end;
  insert into public.organization_members (organization_id, user_id, status, created_by)
    values (p_org, p_user_id, 'active', p_actor)
    on conflict (organization_id, user_id) do update set status = 'active'
    returning id into v_member;
  insert into public.user_roles (organization_id, user_id, role_id, created_by)
    values (p_org, p_user_id, v_role, p_actor) on conflict do nothing;
  return v_member;
end $$;

revoke execute on function app.register_organization(uuid, text, text, text, text),
  app.activate_organization(uuid), app.add_member(uuid, uuid, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function app.register_organization(uuid, text, text, text, text),
  app.activate_organization(uuid), app.add_member(uuid, uuid, text, text, text, uuid) to service_role;

-- ---------- assignment / availability ----------
create or replace function app.exam_assigned_to_student(p_org uuid, p_exam uuid, p_student uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.exam_assignments ea
    join public.students s on s.id = p_student and s.organization_id = p_org
    where ea.organization_id = p_org and ea.exam_id = p_exam and (
      ea.target_type = 'organization'
      or (ea.target_type = 'student' and ea.target_id = s.id)
      or (ea.target_type = 'academic_unit' and s.academic_unit_id is not null
          and ea.target_id in (select app.unit_chain(p_org, s.academic_unit_id)))
      or (ea.target_type = 'subject' and s.academic_unit_id is not null and exists (
            select 1 from public.subjects sb
            where sb.id = ea.target_id and sb.organization_id = p_org and sb.academic_unit_id is not null
              and sb.academic_unit_id in (select app.unit_chain(p_org, s.academic_unit_id))))
    )
  )
$$;

create or replace function app.available_exams(p_org uuid) returns table (
  exam_id uuid, exam_code text, name text, description text, duration_minutes int,
  passing_percentage numeric, start_at timestamptz, end_at timestamptz, max_attempts int,
  attempts_used int, running_attempt_id uuid, show_results boolean, leaderboard_enabled boolean,
  question_count int, total_marks numeric)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_student uuid;
begin
  select s.id into v_student from public.students s
  where s.organization_id = p_org and s.user_id = auth.uid() and s.deleted_at is null
    and s.status = 'active' and app.is_org_member(p_org);
  if v_student is null then return; end if;
  return query
  select e.id, e.exam_code, e.name, e.description, e.duration_minutes, e.passing_percentage,
         e.start_at, e.end_at, st.max_attempts,
         (select count(*)::int from public.exam_attempts a where a.exam_id = e.id and a.student_id = v_student and a.status = 'submitted'),
         (select a.id from public.exam_attempts a where a.exam_id = e.id and a.student_id = v_student and a.status = 'in_progress' limit 1),
         st.show_results, st.leaderboard_enabled,
         (select count(*)::int from public.exam_questions q where q.exam_id = e.id),
         (select coalesce(sum(q.marks), 0) from public.exam_questions q where q.exam_id = e.id)
  from public.exams e join public.exam_settings st on st.exam_id = e.id
  where e.organization_id = p_org and e.status = 'published' and e.deleted_at is null
    and app.exam_assigned_to_student(p_org, e.id, v_student)
    and ((e.start_at is null or e.start_at <= now()) and (e.end_at is null or e.end_at >= now())
         or exists (select 1 from public.exam_attempts a where a.exam_id = e.id and a.student_id = v_student and a.status = 'in_progress'))
  order by e.start_at nulls last, e.name;
end $$;

-- ---------- exam engine ----------
create or replace function app.attempt_meta(p_att public.exam_attempts) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('attemptId', p_att.id, 'examId', p_att.exam_id, 'attemptNo', p_att.attempt_no,
    'status', p_att.status, 'startedAt', p_att.started_at, 'deadlineAt', p_att.deadline_at,
    'submittedAt', p_att.submitted_at, 'autoSubmitted', p_att.auto_submitted, 'serverTime', now())
$$;

-- Evaluate + store the result. Idempotent: calling it again on a submitted attempt returns the same result id.
create or replace function app.finalize_attempt(p_attempt uuid, p_auto boolean) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_att public.exam_attempts%rowtype; v_res uuid; v_passing numeric; v_submitted timestamptz;
  v_raw numeric; v_max numeric; v_correct int; v_wrong int; v_unans int; v_pending boolean;
  v_score numeric; v_pct numeric; v_status text; v_duration int;
begin
  select * into v_att from public.exam_attempts where id = p_attempt for update;
  if not found then raise exception 'ATTEMPT_NOT_FOUND' using errcode = 'EX404'; end if;
  if v_att.status = 'submitted' then
    select id into v_res from public.results where attempt_id = p_attempt;
    return v_res;
  end if;

  v_submitted := case when p_auto then least(now(), v_att.deadline_at) else now() end;
  select e.passing_percentage into v_passing from public.exams e where e.id = v_att.exam_id;

  with scored as (
    select eq.question_id, eq.marks, eq.negative_marks, qt.is_objective,
           case when not qt.is_objective then null
                when a.selected_option_id is null then null
                else (a.selected_option_id = k.correct_option_id) end as is_correct,
           (a.selected_option_id is null and nullif(btrim(coalesce(a.answer_text, '')), '') is null) as unanswered
    from public.exam_questions eq
    join public.questions q on q.id = eq.question_id
    join public.question_types qt on qt.code = q.question_type
    left join public.question_answer_keys k on k.question_id = eq.question_id
    left join public.attempt_answers a on a.attempt_id = p_attempt and a.question_id = eq.question_id
    where eq.exam_id = v_att.exam_id and eq.question_id = any (v_att.question_order)
  )
  select coalesce(sum(case when is_correct then marks when is_correct is false then -negative_marks else 0 end), 0),
         coalesce(sum(marks), 0),
         count(*) filter (where is_correct is true),
         count(*) filter (where is_correct is false),
         count(*) filter (where unanswered),
         coalesce(bool_or(not is_objective), false)
    into v_raw, v_max, v_correct, v_wrong, v_unans, v_pending
  from scored;

  update public.attempt_answers aa
     set is_correct = case when qt.is_objective and aa.selected_option_id is not null
                           then aa.selected_option_id = k.correct_option_id end,
         marks_awarded = case when not qt.is_objective or aa.selected_option_id is null then 0
                              when aa.selected_option_id = k.correct_option_id then eq.marks
                              else -eq.negative_marks end
    from public.exam_questions eq
    join public.questions q on q.id = eq.question_id
    join public.question_types qt on qt.code = q.question_type
    left join public.question_answer_keys k on k.question_id = eq.question_id
   where aa.attempt_id = p_attempt and eq.exam_id = v_att.exam_id and eq.question_id = aa.question_id;

  v_score := greatest(v_raw, 0);                       -- total never goes below zero
  v_pct := case when v_max > 0 then round(v_score / v_max * 100, 2) else 0 end;
  v_status := case when v_pending then 'Pending' when v_pct >= v_passing then 'Passed' else 'Failed' end;
  v_duration := greatest(0, extract(epoch from (v_submitted - v_att.started_at)))::int;

  insert into public.results (organization_id, attempt_id, student_id, exam_id, score, maximum_score, percentage,
                              correct_count, wrong_count, unanswered_count, duration_seconds, status)
  values (v_att.organization_id, p_attempt, v_att.student_id, v_att.exam_id, v_score, v_max, v_pct,
          v_correct, v_wrong, v_unans, v_duration, v_status)
  returning id into v_res;

  update public.exam_attempts
     set status = 'submitted', submitted_at = v_submitted, auto_submitted = p_auto, updated_at = now()
   where id = p_attempt;

  if v_status <> 'Pending' then
    insert into public.leaderboards (organization_id, exam_id, student_id, best_result_id, best_score,
                                     best_percentage, best_duration_seconds, attempts_count)
    values (v_att.organization_id, v_att.exam_id, v_att.student_id, v_res, v_score, v_pct, v_duration, 1)
    on conflict (exam_id, student_id) do update set
      attempts_count = public.leaderboards.attempts_count + 1,
      best_result_id = case when (excluded.best_score, -excluded.best_duration_seconds)
                              > (public.leaderboards.best_score, -public.leaderboards.best_duration_seconds)
                            then excluded.best_result_id else public.leaderboards.best_result_id end,
      best_percentage = case when (excluded.best_score, -excluded.best_duration_seconds)
                               > (public.leaderboards.best_score, -public.leaderboards.best_duration_seconds)
                             then excluded.best_percentage else public.leaderboards.best_percentage end,
      best_duration_seconds = case when (excluded.best_score, -excluded.best_duration_seconds)
                               > (public.leaderboards.best_score, -public.leaderboards.best_duration_seconds)
                             then excluded.best_duration_seconds else public.leaderboards.best_duration_seconds end,
      best_score = case when (excluded.best_score, -excluded.best_duration_seconds)
                          > (public.leaderboards.best_score, -public.leaderboards.best_duration_seconds)
                        then excluded.best_score else public.leaderboards.best_score end,
      updated_at = now();
  end if;
  return v_res;
end $$;

-- Closes every attempt whose server deadline has passed (called by a worker/cron; also lazily on access).
create or replace function app.expire_overdue_attempts(p_limit int default 500) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0;
begin
  for r in select id from public.exam_attempts where status = 'in_progress' and deadline_at <= now()
           order by deadline_at limit p_limit for update skip locked loop
    perform app.finalize_attempt(r.id, true); n := n + 1;
  end loop;
  return n;
end $$;

create or replace function app.start_attempt(p_org uuid, p_exam uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_student uuid; v_exam public.exams%rowtype; v_set public.exam_settings%rowtype;
  v_att public.exam_attempts%rowtype; v_used int; v_qids uuid[]; v_orders jsonb;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED' using errcode = 'EX401'; end if;
  select s.id into v_student from public.students s
   where s.organization_id = p_org and s.user_id = auth.uid() and s.deleted_at is null
     and s.status = 'active' and app.is_org_member(p_org)
   for update of s;                                  -- serialises concurrent starts of the same student
  if v_student is null then raise exception 'NOT_A_STUDENT' using errcode = 'EX403'; end if;

  select * into v_exam from public.exams
   where id = p_exam and organization_id = p_org and deleted_at is null and status = 'published';
  if not found or not app.exam_assigned_to_student(p_org, p_exam, v_student) then
    raise exception 'EXAM_NOT_AVAILABLE' using errcode = 'EX404';
  end if;
  select * into v_set from public.exam_settings where exam_id = p_exam;

  select * into v_att from public.exam_attempts
   where exam_id = p_exam and student_id = v_student and status = 'in_progress';
  if found then
    if now() < v_att.deadline_at then return app.attempt_meta(v_att); end if;   -- idempotent start
    perform app.finalize_attempt(v_att.id, true);
  end if;

  if (v_exam.start_at is not null and now() < v_exam.start_at)
     or (v_exam.end_at is not null and now() > v_exam.end_at) then
    raise exception 'EXAM_NOT_AVAILABLE' using errcode = 'EX404';
  end if;

  select count(*) into v_used from public.exam_attempts where exam_id = p_exam and student_id = v_student;
  if v_used >= v_set.max_attempts then raise exception 'MAX_ATTEMPTS_REACHED' using errcode = 'EX409'; end if;

  select array_agg(question_id order by case when v_set.randomize_questions then random() end, position)
    into v_qids from public.exam_questions where exam_id = p_exam;
  if v_qids is null then raise exception 'EXAM_HAS_NO_QUESTIONS' using errcode = 'EX422'; end if;

  select jsonb_object_agg(q.qid::text, coalesce((
           select jsonb_agg(o.id order by case when v_set.randomize_options then random() end, o.position)
           from public.question_options o where o.question_id = q.qid), '[]'::jsonb))
    into v_orders from unnest(v_qids) as q(qid);

  insert into public.exam_attempts (organization_id, exam_id, student_id, attempt_no, deadline_at, question_order, option_orders)
  values (p_org, p_exam, v_student, v_used + 1,
          least(now() + make_interval(mins => v_exam.duration_minutes), coalesce(v_exam.end_at, 'infinity'::timestamptz)),
          v_qids, v_orders)
  returning * into v_att;
  return app.attempt_meta(v_att);
end $$;

-- Returns the paper WITHOUT answer keys. If the deadline passed, the attempt is auto-submitted first.
create or replace function app.get_attempt(p_org uuid, p_attempt uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_att public.exam_attempts%rowtype; v_exam public.exams%rowtype; v_questions jsonb; v_answers jsonb;
begin
  select * into v_att from public.exam_attempts a
   where a.id = p_attempt and a.organization_id = p_org and app.is_own_student(p_org, a.student_id);
  if not found then raise exception 'ATTEMPT_NOT_FOUND' using errcode = 'EX404'; end if;
  if v_att.status = 'in_progress' and now() >= v_att.deadline_at then
    perform app.finalize_attempt(p_attempt, true);
    select * into v_att from public.exam_attempts where id = p_attempt;
  end if;
  select * into v_exam from public.exams where id = v_att.exam_id;
  if v_att.status = 'submitted' then
    return app.attempt_meta(v_att) || jsonb_build_object('examName', v_exam.name, 'durationMinutes', v_exam.duration_minutes);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', q.id, 'text', q.question_text, 'type', q.question_type,
           'marks', eq.marks, 'negativeMarks', eq.negative_marks,
           'options', coalesce((
              select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.option_text) order by t.idx)
              from jsonb_array_elements_text(coalesce(v_att.option_orders -> q.id::text, '[]'::jsonb)) with ordinality as t(oid, idx)
              join public.question_options o on o.id = t.oid::uuid), '[]'::jsonb)
         ) order by u.ord), '[]'::jsonb)
    into v_questions
  from unnest(v_att.question_order) with ordinality as u(qid, ord)
  join public.questions q on q.id = u.qid
  join public.exam_questions eq on eq.exam_id = v_att.exam_id and eq.question_id = q.id;

  select coalesce(jsonb_agg(jsonb_build_object('questionId', a.question_id, 'selectedOptionId', a.selected_option_id,
                                               'answerText', a.answer_text, 'flagged', a.flagged)), '[]'::jsonb)
    into v_answers from public.attempt_answers a where a.attempt_id = p_attempt;

  return app.attempt_meta(v_att) || jsonb_build_object(
    'examName', v_exam.name, 'durationMinutes', v_exam.duration_minutes,
    'instructions', coalesce(v_exam.description, ''), 'questions', v_questions, 'answers', v_answers);
end $$;

create or replace function app.save_answer(
  p_org uuid, p_attempt uuid, p_question uuid, p_option uuid, p_text text, p_flagged boolean
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_att public.exam_attempts%rowtype;
begin
  select * into v_att from public.exam_attempts a
   where a.id = p_attempt and a.organization_id = p_org and app.is_own_student(p_org, a.student_id);
  if not found then raise exception 'ATTEMPT_NOT_FOUND' using errcode = 'EX404'; end if;
  if v_att.status <> 'in_progress' then raise exception 'ATTEMPT_CLOSED' using errcode = 'EX409'; end if;
  if now() > v_att.deadline_at + interval '5 seconds' then raise exception 'DEADLINE_PASSED' using errcode = 'EX410'; end if;
  if not (p_question = any (v_att.question_order)) then raise exception 'QUESTION_NOT_IN_ATTEMPT' using errcode = 'EX400'; end if;
  if p_option is not null and not exists (
       select 1 from public.question_options o where o.id = p_option and o.question_id = p_question and o.organization_id = p_org) then
    raise exception 'INVALID_OPTION' using errcode = 'EX400';
  end if;
  insert into public.attempt_answers (organization_id, attempt_id, question_id, selected_option_id, answer_text, flagged)
  values (p_org, p_attempt, p_question, p_option, p_text, coalesce(p_flagged, false))
  on conflict (attempt_id, question_id) do update
    set selected_option_id = excluded.selected_option_id, answer_text = excluded.answer_text,
        flagged = excluded.flagged, answered_at = now(), updated_at = now();
  return jsonb_build_object('saved', true, 'serverTime', now());
end $$;

create or replace function app.result_json(p_res public.results) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('resultId', p_res.id, 'attemptId', p_res.attempt_id, 'examId', p_res.exam_id,
    'score', p_res.score, 'maximumScore', p_res.maximum_score, 'percentage', p_res.percentage,
    'correctCount', p_res.correct_count, 'wrongCount', p_res.wrong_count, 'unansweredCount', p_res.unanswered_count,
    'durationSeconds', p_res.duration_seconds, 'status', p_res.status, 'evaluatedAt', p_res.evaluated_at)
$$;

-- Idempotent: a second call (double click, retry) returns the SAME result and never creates another.
create or replace function app.submit_attempt(p_org uuid, p_attempt uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_att public.exam_attempts%rowtype; v_res_id uuid; v_res public.results%rowtype;
begin
  select * into v_att from public.exam_attempts a
   where a.id = p_attempt and a.organization_id = p_org and app.is_own_student(p_org, a.student_id);
  if not found then raise exception 'ATTEMPT_NOT_FOUND' using errcode = 'EX404'; end if;
  v_res_id := app.finalize_attempt(p_attempt, v_att.status = 'in_progress' and now() > v_att.deadline_at);
  select * into v_res from public.results where id = v_res_id;
  if app.exam_shows_results(p_org, v_res.exam_id) then
    return jsonb_build_object('submitted', true, 'result', app.result_json(v_res));
  end if;
  return jsonb_build_object('submitted', true, 'result', null, 'resultsHidden', true);
end $$;

create or replace function app.my_results(p_org uuid) returns table (
  result_id uuid, attempt_id uuid, exam_id uuid, exam_name text, score numeric, maximum_score numeric,
  percentage numeric, correct_count int, wrong_count int, unanswered_count int, duration_seconds int,
  status text, evaluated_at timestamptz, show_answers boolean, leaderboard_enabled boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.id, r.attempt_id, r.exam_id, e.name, r.score, r.maximum_score, r.percentage, r.correct_count,
         r.wrong_count, r.unanswered_count, r.duration_seconds, r.status, r.evaluated_at,
         st.show_answers, st.leaderboard_enabled
  from public.results r
  join public.exams e on e.id = r.exam_id
  join public.exam_settings st on st.exam_id = r.exam_id
  where r.organization_id = p_org and app.is_own_student(p_org, r.student_id) and st.show_results
  order by r.evaluated_at desc
$$;

-- Detailed result. Correct answers are included ONLY when the exam allows it (show_answers).
create or replace function app.get_attempt_review(p_org uuid, p_attempt uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_att public.exam_attempts%rowtype; v_set public.exam_settings%rowtype; v_res public.results%rowtype; v_review jsonb;
begin
  select * into v_att from public.exam_attempts a
   where a.id = p_attempt and a.organization_id = p_org and app.is_own_student(p_org, a.student_id);
  if not found then raise exception 'ATTEMPT_NOT_FOUND' using errcode = 'EX404'; end if;
  if v_att.status <> 'submitted' then raise exception 'ATTEMPT_OPEN' using errcode = 'EX409'; end if;
  select * into v_set from public.exam_settings where exam_id = v_att.exam_id;
  if not v_set.show_results then raise exception 'RESULTS_HIDDEN' using errcode = 'EX403'; end if;
  select * into v_res from public.results where attempt_id = p_attempt;

  if v_set.show_answers then
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', q.id, 'text', q.question_text, 'explanation', q.explanation,
        'selectedOptionId', a.selected_option_id, 'correctOptionId', k.correct_option_id,
        'isCorrect', a.is_correct, 'marksAwarded', coalesce(a.marks_awarded, 0), 'marks', eq.marks,
        'options', (select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.option_text) order by o.position)
                    from public.question_options o where o.question_id = q.id)
      ) order by u.ord), '[]'::jsonb)
      into v_review
    from unnest(v_att.question_order) with ordinality as u(qid, ord)
    join public.questions q on q.id = u.qid
    join public.exam_questions eq on eq.exam_id = v_att.exam_id and eq.question_id = q.id
    left join public.question_answer_keys k on k.question_id = q.id
    left join public.attempt_answers a on a.attempt_id = p_attempt and a.question_id = q.id;
  end if;
  return jsonb_build_object('result', app.result_json(v_res), 'showAnswers', v_set.show_answers, 'review', v_review);
end $$;

-- ---------- leaderboard (scope: exam | organization | academic_unit | subject) ----------
create or replace function app.leaderboard(
  p_org uuid, p_scope text, p_scope_id uuid default null, p_limit int default 50, p_offset int default 0
) returns table (rank bigint, student_id uuid, student_name text, score numeric, percentage numeric,
                 duration_seconds bigint, exams_taken int, is_me boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_admin boolean;
begin
  if not app.has_permission(p_org, 'leaderboard.read') then raise exception 'FORBIDDEN' using errcode = 'EX403'; end if;
  v_admin := app.is_org_admin(p_org);
  p_limit := least(greatest(coalesce(p_limit, 50), 1), 200);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if p_scope = 'exam' then
    if p_scope_id is null or not app.can_view_leaderboard(p_org, p_scope_id) then
      raise exception 'FORBIDDEN' using errcode = 'EX403';
    end if;
    return query
    select * from (
      select rank() over (order by l.best_score desc, l.best_duration_seconds asc),
             s.id, s.full_name, l.best_score, l.best_percentage, l.best_duration_seconds::bigint, 1,
             (s.user_id = auth.uid())
      from public.leaderboards l join public.students s on s.id = l.student_id
      where l.organization_id = p_org and l.exam_id = p_scope_id
    ) x order by 1, 3 limit p_limit offset p_offset;

  elsif p_scope in ('organization', 'academic_unit', 'subject') then
    if p_scope <> 'organization' and p_scope_id is null then raise exception 'BAD_REQUEST' using errcode = 'EX400'; end if;
    return query
    select * from (
      select rank() over (order by round(avg(l.best_percentage), 2) desc, sum(l.best_duration_seconds) asc),
             s.id, s.full_name, sum(l.best_score), round(avg(l.best_percentage), 2),
             sum(l.best_duration_seconds)::bigint, count(*)::int, bool_or(s.user_id = auth.uid())
      from public.leaderboards l
      join public.students s on s.id = l.student_id
      join public.exam_settings st on st.exam_id = l.exam_id
      where l.organization_id = p_org
        and (v_admin or st.leaderboard_enabled)
        and (p_scope <> 'academic_unit' or (s.academic_unit_id is not null
              and p_scope_id in (select app.unit_chain(p_org, s.academic_unit_id))))
        and (p_scope <> 'subject' or exists (
              select 1 from public.exam_questions eq join public.questions q on q.id = eq.question_id
              where eq.exam_id = l.exam_id and q.subject_id = p_scope_id))
      group by s.id, s.full_name
    ) x order by 1, 3 limit p_limit offset p_offset;
  else
    raise exception 'BAD_REQUEST' using errcode = 'EX400';
  end if;
end $$;

grant execute on function
  app.exam_assigned_to_student(uuid, uuid, uuid), app.available_exams(uuid), app.start_attempt(uuid, uuid),
  app.get_attempt(uuid, uuid), app.save_answer(uuid, uuid, uuid, uuid, text, boolean),
  app.submit_attempt(uuid, uuid), app.my_results(uuid), app.get_attempt_review(uuid, uuid),
  app.leaderboard(uuid, text, uuid, int, int), app.attempt_meta(public.exam_attempts), app.result_json(public.results)
to authenticated, service_role;
-- finalize / expire are SYSTEM-only (users reach finalize through submit_attempt, which checks ownership).
revoke execute on function app.finalize_attempt(uuid, boolean), app.expire_overdue_attempts(int) from public, anon, authenticated;
grant execute on function app.finalize_attempt(uuid, boolean), app.expire_overdue_attempts(int) to service_role;
