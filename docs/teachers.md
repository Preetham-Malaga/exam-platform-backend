# Teachers (Phase 9)

A teacher has three parts, kept in sync by the API:

| Part         | Where                                                           | Decides                                                  |
| ------------ | --------------------------------------------------------------- | -------------------------------------------------------- |
| Record       | `teachers` (employee code, name, e-mail …)                      | who the teacher is for the college (works without login) |
| Login + role | Supabase Auth + `organization_members` + `user_roles` (TEACHER) | that they can sign in, and the permissions they get      |
| Scope        | `user_scopes` (subject, course or academic unit)                | WHAT they can work on (`app.in_scope` in every policy)   |

A course in the scope covers all its subjects; a unit covers every subject placed on it or on any unit below it.

## Flows

- **Add + invite** (`POST /teachers`, default `invite: true`): finds or creates the login (Supabase sends the invitation
  e-mail), makes it a TEACHER member and creates the record **in one transaction**. If anything fails, a login created
  for this request is deleted again.
- **Add without login** (`invite: false`) and **invite later** (`POST /teachers/:id/invite`, needs an e-mail on the record).
- **Existing accounts:** a member who already has the Teacher role (e.g. changed on the Users page) is linked. Someone who
  belongs to the organization with another role is refused (`409 ALREADY_MEMBER`): `user_roles` allows several roles and
  we never silently give a second one. One record per login (`409 TEACHER_EXISTS`).
- **Edit** (`PATCH /teachers/:id`): the e-mail of a linked teacher is their sign-in address and cannot be changed here
  (`400 EMAIL_LOCKED`). `status: inactive` suspends the membership at once (they lose access); `active` restores it.
- **Remove** (`DELETE /teachers/:id`, guide 13.1 "remove membership + soft delete"): record soft-deleted, membership
  `removed`, scope cleared. Exams and questions they created stay.
- **Scope** (`PUT /teachers/:id/scopes`, `teacher.assign_scope`): replaces the whole set (max 200). Every target must be an
  active subject/course/unit of the organization (`400 INVALID_SCOPE_TARGET` lists the bad ids; nothing changes). Needs a
  login (`400 TEACHER_HAS_NO_LOGIN`).
- Plan limit: the number of teacher records per plan is enforced by the database (`402 PLAN_LIMIT_REACHED`).

## Permissions

Owner and admin hold every `teacher.*` permission; teachers and students hold none (`403`). Another organization's
teachers are `404`. Every change is audit-logged (`TEACHER_CREATED`, `TEACHER_INVITED`, `TEACHER_UPDATED`,
`TEACHER_REMOVED`, `TEACHER_SCOPES_CHANGED`).

## Screen

`/org/teachers`: list with login state and scope size, add/invite, edit/deactivate, send invitation, remove, and a scope
drawer with subjects, courses and units.

## Known limits

- Changing a teacher's role on the Users page does not touch their teacher record or scope (use Remove here instead).
- A person in several organizations still works in the earliest one (no organization switcher yet, see authorization.md).
- The scope drawer lists the first 100 subjects and courses.
