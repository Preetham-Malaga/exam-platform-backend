# Database (Phase 3)

PostgreSQL on Supabase. The backend repo owns the schema: `supabase/migrations/001 ... 038`.

## Rules every table follows
- `id uuid` primary key (internal). Organizations also get a human code: `org_code` = `ORG-000001`.
- Tenant tables carry `organization_id uuid NOT NULL` (FK to `organizations`, `ON DELETE CASCADE`) plus `created_at`, `updated_at`, `created_by/updated_by` and `deleted_at` where it makes sense.
- **Cross-organization references are impossible**: every parent has `unique (organization_id, id)` and children use composite foreign keys, e.g. `questions (organization_id, subject_id) -> subjects (organization_id, id)`.
- Business codes are unique **per organization** (`courses.code`, `subjects.code`, `students.roll_number`, `exams.exam_code` ...), never globally. Soft-deleted rows free their code.
- Every table has row level security enabled (policies are in `036`; they are exercised in Phase 7).
- Indexes always start with `organization_id` for tenant data.

## Migrations
| Range | Content |
|---|---|
| 001 | extensions (`pgcrypto`, `citext`, `pg_trgm`) and the private `app` schema |
| 002-005 | organizations, organization_settings, profiles, organization_members |
| 006-010 | roles, permissions, role_permissions, user_roles, user_scopes (RBAC and teacher scope) |
| 011-017 | academic_levels/units, courses, subjects, topics, students, teachers |
| 018-021 | questions, question_options, question_answer_keys (separate on purpose), files |
| 022-029 | exams, exam_settings, exam_questions, exam_assignments, exam_attempts, attempt_answers, results, leaderboards |
| 030-034 | plans, plan_limits, subscriptions, notifications, audit_logs |
| 035 | indexes |
| 036 | RLS helper functions (`app.is_org_member`, `has_role`, `has_permission`, `in_scope` ...), privileges, policies |
| 037 | business functions (register organization, exam engine, leaderboard) |
| 038 | triggers (updated_at, protected columns, plan limits, publish checks ...) |

Note: the architecture guide lists "RLS policies" before "database functions". The RLS **helper** functions had to move into `036` because policies cannot be created before the functions they call.

## Running the migrations
```bash
# real Supabase project: DATABASE_URL in .env (use a project dedicated to this platform)
node scripts/migrate.mjs

# local plain PostgreSQL (no Supabase): first creates a fake auth schema + roles from tests/db/supabase-shim.sql
node scripts/migrate.mjs --shim
```
The runner applies files in order, one transaction per file, and records them in `app.migrations` with a checksum.
Re-running is safe. **Never edit a migration that has been applied**: the runner refuses; add a new numbered file instead.
Prefer the *direct* or *session pooler* connection string from Supabase for migrations.

## Safety
- Migrations only touch tables they create (explicit lists in `036` and `038`), never "all tables in schema public".
- There is no `DROP` anywhere. Nothing here deletes existing data.
- The `anon` role has no privileges on any table.

## Tests
`tests/db/schema.test.ts` checks the file order, RLS on every table, primary keys, tenant columns, composite foreign keys,
per-organization uniqueness, organization-first indexes, `SECURITY DEFINER` hardening, seed data, cascade delete of a whole
organization, and applying all 38 migrations to an empty database. Run against a **throw-away** local database:
```bash
DATABASE_TEST_URL=postgresql://postgres:postgres@127.0.0.1:5432/exam_test npx vitest run tests/db/schema.test.ts
```
Without `DATABASE_TEST_URL` only the file-order test runs.
