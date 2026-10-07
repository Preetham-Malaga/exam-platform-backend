-- PURPOSE: Many-to-many link between exams and questions (never an array inside exams).
-- WHY: marks/negative_marks are a SNAPSHOT taken when the question is added, so later edits to the
--      question cannot change the scoring of an existing exam (trigger in 038 fills them).

create table public.exam_questions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  exam_id uuid not null,
  question_id uuid not null,
  position int not null check (position > 0),
  marks numeric(6, 2) not null check (marks > 0),
  negative_marks numeric(6, 2) not null check (negative_marks >= 0),
  created_at timestamptz not null default now(),
  unique (exam_id, question_id),
  foreign key (organization_id, exam_id) references public.exams (organization_id, id) on delete cascade,
  foreign key (organization_id, question_id) references public.questions (organization_id, id)
);
