-- 008: which role holds which permission. Owner = everything; Admin = everything except billing/org profile.
create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.code = 'ORGANIZATION_OWNER';

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.code = 'ORGANIZATION_ADMIN' and p.code not in ('organization.update','subscription.read');

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in (
  'course.read','subject.read','topic.read','topic.create','topic.update','topic.delete',
  'question.create','question.read','question.update','question.delete','question.publish',
  'exam.read','exam.create','exam.update','exam.delete','exam.assign','exam.publish','exam.unpublish',
  'student.read','result.read','report.read','leaderboard.read','notification.read','organization.read'
) where r.code = 'TEACHER';

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in (
  'leaderboard.read','notification.read'
) where r.code = 'STUDENT';
