-- PURPOSE: Limits per plan. Enforcement code arrives in Phase 19; the data model is ready now.

create table public.plan_limits (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans (id) on delete cascade,
  limit_key text not null check (limit_key in ('students', 'teachers', 'questions', 'exams', 'storage_mb')),
  limit_value int not null check (limit_value >= 0),
  unique (plan_id, limit_key)
);
insert into public.plan_limits (plan_id, limit_key, limit_value)
select p.id, l.k, case when p.code = 'trial' then l.trial_v else l.std_v end
from public.plans p
cross join (values ('students', 100, 5000), ('teachers', 10, 200), ('questions', 500, 50000),
                   ('exams', 20, 2000), ('storage_mb', 100, 10240)) as l (k, trial_v, std_v);
