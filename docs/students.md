# Students (Phase 10)

A student has a **record** (`students`: roll number, name, e-mail, phone), a **unit** (`academic_unit_id`: where they
study, e.g. B.Tech > EEE > Year 2 > Semester 4) and optionally a **login** (STUDENT role). The unit decides which exams
reach them: an exam assigned to a unit reaches every student on that unit or any unit below it (`app.unit_chain`).

Logins are linked exactly like teachers (`src/modules/_shared/member.ts`): one transaction, no second role for an existing
member (`409 ALREADY_MEMBER`), a login created for a failed request is deleted again. See `teachers.md`.

## Endpoints (`/api/v1`)

| Method and path             | Permission       | Notes                                                                                                                 |
| --------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GET /students`             | `student.read`   | filters `academicUnitId` (unit **and everything below it**), `unplaced=true`, `status`, `search` (name, roll, e-mail) |
| `GET /students/:id`         | `student.read`   |                                                                                                                       |
| `POST /students`            | `student.create` | `{ rollNumber, fullName, email?, phone?, academicUnitId?, invite? }` (`invite` defaults to false)                     |
| `POST /students/:id/invite` | `student.create` | creates/links the login and sends the invitation                                                                      |
| `PATCH /students/:id`       | `student.update` | move to another unit; `status: inactive` locks the login out; linked e-mail is locked                                 |
| `DELETE /students/:id`      | `student.delete` | soft delete + membership removed; attempts and results stay; roll number free again                                   |
| `POST /students/import`     | `student.import` | `{ rows: [...max 500], dryRun? }` - see below                                                                         |

Owners and admins hold all of these. Teachers may **read** students (`student.read`, needed for results later) but not
change them. Students get `403`. Another organization's students are `404`.

## Import

The browser reads the CSV (`roll_number, full_name, email, phone, unit_code`; headers like "Roll No" or "Name" are
recognised) and sends JSON rows, 500 per request (the screen sends bigger files in batches).

- Each row is checked on its own and reported with its position and reason: `INVALID_ROW` (missing name, bad e-mail ...),
  `DUPLICATE_IN_FILE`, `DUPLICATE` (roll number already in the college), `UNKNOWN_UNIT` (unit codes are matched
  case-insensitively, only within the caller's organization), `PLAN_LIMIT_REACHED`.
- Good rows are saved even when others fail (one savepoint per row). `dryRun: true` runs every check and saves nothing;
  the screen always checks first.
- **No e-mails are sent by an import.** Supabase's built-in mailer allows only a few e-mails per hour; bulk invitations
  belong in the background job queue (guide Part 12), which is not built yet. Invite students one by one meanwhile.
- Imported rows are written in the caller's session, so RLS and the plan limit apply exactly as for single adds.

## Known limits

- Re-importing a file does not update existing students (they are reported as `DUPLICATE`).
- Teachers see every student of the organization (not only those in their scope); results phases may narrow this.
