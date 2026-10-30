// PURPOSE: Validation for the extra course / subject / topic fields stored in each row's "details" column (migration 044).
// WHY: The prototype forms (SPEC.course, SPEC.subject, SPEC.topic) ask for more than code and name. Each field is
//      optional and checked here, so only known keys with sensible values reach the database.
// DEPENDS ON: zod.

import { z } from 'zod';

const text = (max: number) => z.string().trim().max(max);
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const date = z.iso.date();

export const courseDetailsSchema = z
  .object({
    courseType: z.enum([
      'Degree',
      'Diploma',
      'Certificate',
      'Coaching programme',
      'School class',
      'Short course',
    ]),
    department: text(100),
    medium: text(40),
    durationValue: int(1, 120),
    durationUnit: z.enum(['Months', 'Years', 'Semesters']),
    terms: int(1, 20),
    startDate: date,
    endDate: date,
    seats: int(1, 100000),
    fee: z.number().min(0).max(100000000),
  })
  .partial()
  .strict();

export const subjectDetailsSchema = z
  .object({
    subjectType: z.enum(['Theory', 'Practical', 'Lab', 'Elective', 'Project']),
    term: text(40),
    credits: z.number().min(0).max(10),
    maxMarks: z.number().min(1).max(10000),
    passMarks: z.number().min(0).max(10000),
    internalMarks: z.number().min(0).max(10000),
    externalMarks: z.number().min(0).max(10000),
    weeklyHours: z.number().min(0).max(40),
    order: int(1, 10000),
  })
  .partial()
  .strict();

export const topicDetailsSchema = z
  .object({
    code: text(10),
    objectives: text(2000),
    hours: z.number().min(0).max(200),
    difficulty: z.enum(['Easy', 'Medium', 'Hard']),
    status: z.enum(['active', 'inactive']),
  })
  .partial()
  .strict();
