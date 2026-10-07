-- 035: indexes. Organization-owned tables start with organization_id; search columns use trigram indexes.
create index roles_org_idx on public.roles (organization_id) where organization_id is not null;
create index org_members_user_idx on public.organization_members (user_id, status);
create index user_roles_user_idx on public.user_roles (organization_id, user_id);
create index user_roles_role_idx on public.user_roles (role_id);
create index user_scopes_user_idx on public.user_scopes (organization_id, user_id);
create index user_scopes_target_idx on public.user_scopes (organization_id, scope_type, scope_id);

create index academic_units_level_idx on public.academic_units (organization_id, level_id);
create index academic_units_parent_idx on public.academic_units (organization_id, parent_id);
create index courses_unit_idx on public.courses (organization_id, academic_unit_id);
create index courses_created_idx on public.courses (organization_id, created_at desc);
create index subjects_course_idx on public.subjects (organization_id, course_id);
create index subjects_unit_idx on public.subjects (organization_id, academic_unit_id);
create index topics_subject_idx on public.topics (organization_id, subject_id);

create index students_unit_idx on public.students (organization_id, academic_unit_id);
create index students_status_idx on public.students (organization_id, status);
create index students_created_idx on public.students (organization_id, created_at desc);
create index students_name_trgm on public.students using gin (full_name gin_trgm_ops);
create index teachers_status_idx on public.teachers (organization_id, status);
create index teachers_created_idx on public.teachers (organization_id, created_at desc);
create index teachers_name_trgm on public.teachers using gin (full_name gin_trgm_ops);

create index questions_status_idx on public.questions (organization_id, status);
create index questions_subject_idx on public.questions (organization_id, subject_id);
create index questions_topic_idx on public.questions (organization_id, topic_id);
create index questions_created_idx on public.questions (organization_id, created_at desc);
create index questions_text_trgm on public.questions using gin (question_text gin_trgm_ops);
create index files_kind_idx on public.files (organization_id, kind);

create index exams_status_idx on public.exams (organization_id, status);
create index exams_created_idx on public.exams (organization_id, created_at desc);
create index exams_course_idx on public.exams (organization_id, course_id);
create index exam_settings_exam_idx on public.exam_settings (organization_id, exam_id);
create index exam_questions_exam_idx on public.exam_questions (organization_id, exam_id, position);
create index exam_questions_question_idx on public.exam_questions (question_id);
create index exam_assignments_exam_idx on public.exam_assignments (organization_id, exam_id);
create index exam_assignments_target_idx on public.exam_assignments (organization_id, target_type, target_id);

create index exam_attempts_exam_idx on public.exam_attempts (organization_id, exam_id);
create index exam_attempts_student_idx on public.exam_attempts (organization_id, student_id);
create index exam_attempts_exam_only_idx on public.exam_attempts (exam_id);
create index exam_attempts_student_only_idx on public.exam_attempts (student_id);
create index exam_attempts_running_deadline_idx on public.exam_attempts (deadline_at) where status = 'in_progress';
create index attempt_answers_attempt_idx on public.attempt_answers (organization_id, attempt_id);
create index attempt_answers_question_idx on public.attempt_answers (question_id);
create index results_exam_idx on public.results (organization_id, exam_id);
create index results_student_idx on public.results (organization_id, student_id);
create index results_evaluated_idx on public.results (organization_id, evaluated_at desc);
create index leaderboards_rank_idx on public.leaderboards (organization_id, exam_id, best_score desc, best_duration_seconds);

create index subscriptions_plan_idx on public.subscriptions (plan_id);
create index notifications_user_idx on public.notifications (organization_id, user_id, read_at);
create index audit_logs_org_created_idx on public.audit_logs (organization_id, created_at desc);
create index audit_logs_user_idx on public.audit_logs (organization_id, user_id);
create index audit_logs_action_idx on public.audit_logs (organization_id, action);
create index audit_logs_request_idx on public.audit_logs (request_id);
