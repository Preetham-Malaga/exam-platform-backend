-- 040: leaderboard privacy. A student may see the leaderboard of an exam only if the exam is assigned to them (and the exam shows one);
-- before, any student of the organization could see the board of ANY exam that had leaderboards enabled. Teachers see only exams they own.
create or replace function app.can_view_leaderboard(p_org uuid, p_exam uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_permission(p_org, 'leaderboard.read') and (
    app.exam_accessible(p_org, p_exam)
    or (app.exam_leaderboard_enabled(p_org, p_exam) and exists (
          select 1 from public.students s
          where s.organization_id = p_org and s.user_id = auth.uid() and s.deleted_at is null
            and app.exam_assigned_to_student(p_org, p_exam, s.id)))
  )
$$;

create or replace function app.leaderboard(
  p_org uuid, p_scope text, p_scope_id uuid default null, p_limit int default 50, p_offset int default 0
) returns table (rank bigint, student_id uuid, student_name text, score numeric, percentage numeric,
                 duration_seconds bigint, exams_taken int, is_me boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_admin boolean; v_student uuid;
begin
  if not app.has_permission(p_org, 'leaderboard.read') then raise exception 'FORBIDDEN' using errcode = 'EX403'; end if;
  v_admin := app.is_org_admin(p_org);
  select s.id into v_student from public.students s where s.organization_id = p_org and s.user_id = auth.uid() and s.deleted_at is null;
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
        -- admins see every exam, teachers the exams they own, students only exams they are assigned to AND that show a leaderboard
        and (v_admin or app.exam_accessible(p_org, l.exam_id)
             or (st.leaderboard_enabled and v_student is not null and app.exam_assigned_to_student(p_org, l.exam_id, v_student)))
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
