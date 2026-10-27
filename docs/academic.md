# Academic structure (Phase 8)

One configurable structure for every institution type (architecture guide Part 7). No institution-specific code:

| Concept     | Table             | Example (engineering)                    | Example (school)    |
| ----------- | ----------------- | ---------------------------------------- | ------------------- |
| **Level**   | `academic_levels` | Program > Branch > Year > Semester       | Class > Section     |
| **Unit**    | `academic_units`  | B.Tech > EEE > Year 2 > Semester 4       | Class 8 > Section A |
| **Course**  | `courses`         | B.Tech (optionally placed on a unit)     | -                   |
| **Subject** | `subjects`        | Electrical Machines (course and/or unit) | Mathematics         |
| **Topic**   | `topics`          | Transformers                             | Fractions           |

Registration creates the default levels for the institution type (`app.default_levels`); the owner can rename, add, reorder
and delete them.

## Rules (enforced by the database or the API, never only in the UI)

- **Tree follows the level order** (migration `042`, trigger `app.validate_academic_unit`): a unit's parent sits on a higher
  level (smaller position). Levels may be skipped (Section directly under Class). This also makes cycles impossible.
  Reordering levels is refused (`409 LEVEL_ORDER_CONFLICT`) if it would put any unit at or above its parent's level.
- **Soft delete only** for units, courses, subjects and topics (`deleted_at`); history stays for reports. A deleted record
  frees its code. Levels have no history and are deleted for real.
- **Nothing in use is deleted** (`409`, with counts in `error.details`):
  level ← active units; unit ← sub-units, courses, subjects, students; course ← subjects; subject ← topics, questions;
  topic ← questions. The counts are taken as the system (filtered by the caller's organization), so a teacher cannot delete a
  topic just because another teacher's question is hidden from them.
- **Codes** are unique per organization among active rows (`409 DUPLICATE`); another college may reuse them.
  Topic names are unique per subject (case-insensitive).
- **Links stay inside the organization**: composite foreign keys (`organization_id, id`) plus an explicit check that the
  referenced unit/course/subject is visible and not deleted (`404`). Unknown body fields are rejected (strict schemas).

## Who may do what

| Endpoint group                                         | Owner / Admin     | Teacher                                 | Student |
| ------------------------------------------------------ | ----------------- | --------------------------------------- | ------- |
| `GET /academic-levels`, `/academic-units[/tree\|/:id]` | yes               | yes                                     | yes     |
| levels and units: create/update/delete                 | `academic.manage` | no                                      | no      |
| courses: read                                          | all               | only courses of subjects in their scope | no      |
| courses, subjects: create/update/delete                | yes               | no                                      | no      |
| subjects: read                                         | all               | only their scope (`app.in_scope`)       | no      |
| topics: read/create/update/delete                      | all               | only topics of subjects in their scope  | no      |

A teacher asking for a subject or topic outside their scope gets `404`, not `403`: for them it does not exist.

## Endpoints (`/api/v1`)

| Method and path                                                | Notes                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /academic-levels`                                         | all levels in order, with `unitCount`                                       |
| `POST /academic-levels`                                        | `{ name, code? }`; added at the bottom; max 10 levels                       |
| `PATCH /academic-levels/:id`                                   | `{ name?, code? }`                                                          |
| `PUT /academic-levels/order`                                   | `{ levelIds: [...] }` - every level exactly once                            |
| `DELETE /academic-levels/:id`                                  | only if no active unit uses it                                              |
| `GET /academic-units`                                          | paginated; filters `levelId`, `parentId` (`root` or id), `status`, `search` |
| `GET /academic-units/tree`                                     | `{ levels, units, truncated }`, flat (nest by `parentId`), max 5000 units   |
| `GET/PATCH/DELETE /academic-units/:id`, `POST /academic-units` | body `{ levelId, parentId?, code, name, status? }`                          |
| `GET/POST /courses`, `GET/PATCH/DELETE /courses/:id`           | filters `academicUnitId`, `status`, `search`                                |
| `GET/POST /subjects`, `GET/PATCH/DELETE /subjects/:id`         | filters `courseId`, `academicUnitId`, `status`, `search`                    |
| `GET/POST /topics`, `PATCH/DELETE /topics/:id`                 | filter `subjectId`, `search`; `POST { subjectId, name, position? }`         |

Every change writes an audit log row (`ACADEMIC_UNIT_CREATED`, `COURSE_DELETED` ...).

## Screens (frontend)

`/org/academic` (levels + unit tree), `/org/courses`, `/org/subjects`, `/org/topics`; teachers reach subjects (read-only) and
topics from their own menu at `/teacher/subjects` and `/teacher/topics`.

## Not in this phase

- Moving a unit to another parent is supported by the API (`PATCH parentId`) but not offered on screen yet.
- Assigning teachers to subjects/units (`user_scopes`) arrives with teacher management; students' units with student
  management.
