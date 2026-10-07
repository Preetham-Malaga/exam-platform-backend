-- 007: the permission catalogue. Code format: <resource>.<action>.
create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  description text not null default '',
  created_at timestamptz not null default now()
);

insert into public.permissions (code, description) values
  ('organization.read','View organization profile'),
  ('organization.update','Edit organization profile'),
  ('user.read','View users'), ('user.create','Invite users'),
  ('user.update','Change user roles and status'), ('user.delete','Remove users'),
  ('student.read','View students'), ('student.create','Add students'),
  ('student.update','Edit students'), ('student.delete','Remove students'),
  ('student.import','Import students'),
  ('teacher.read','View teachers'), ('teacher.create','Add teachers'),
  ('teacher.update','Edit teachers'), ('teacher.delete','Remove teachers'),
  ('teacher.assign_scope','Assign teacher scopes'),
  ('academic.manage','Manage academic levels and units'),
  ('course.read','View courses'), ('course.create','Create courses'),
  ('course.update','Edit courses'), ('course.delete','Delete courses'),
  ('subject.read','View subjects'), ('subject.create','Create subjects'),
  ('subject.update','Edit subjects'), ('subject.delete','Delete subjects'),
  ('topic.read','View topics'), ('topic.create','Create topics'),
  ('topic.update','Edit topics'), ('topic.delete','Delete topics'),
  ('question.create','Create questions'), ('question.read','View questions'),
  ('question.update','Edit questions'), ('question.delete','Delete questions'),
  ('question.publish','Publish questions'),
  ('exam.read','View exams'), ('exam.create','Create exams'), ('exam.update','Edit exams'),
  ('exam.delete','Delete exams'), ('exam.assign','Assign exams'),
  ('exam.publish','Publish exams'), ('exam.unpublish','Unpublish exams'),
  ('result.read','View results'), ('report.read','View reports'),
  ('leaderboard.read','View leaderboards'),
  ('settings.read','View settings'), ('settings.update','Edit settings'),
  ('subscription.read','View subscription'),
  ('notification.read','View notifications'),
  ('audit.read','View organization audit log');
