# Authorization (Phase 6): roles, permissions, scope

Access is decided by **permissions**, and permissions come from **roles**. Pages and routes never check role names directly.

## Roles

| Role                   | Belongs to                                                  | Purpose                                                                                   |
| ---------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `PLATFORM_SUPER_ADMIN` | our company (flag on the profile, not an organization role) | runs the platform; has **no** access to any organization's questions, students or results |
| `ORGANIZATION_OWNER`   | the customer                                                | everything inside the organization, including billing and the organization profile        |
| `ORGANIZATION_ADMIN`   | the customer                                                | everything except editing the organization profile and viewing the subscription           |
| `TEACHER`              | the customer                                                | questions, topics, exams, results of what they are scoped to                              |
| `STUDENT`              | the customer                                                | sits exams; sees own results; leaderboards the exam allows                                |

## Three layers, all must agree

1. **UI (React):** `utils/permissions.ts`, `<Can>`, `RequirePermission`, filtered menu. Better experience only.
2. **API (Fastify):** `requirePermission('user.update')` on every route. Permission codes are typed (`src/auth/permissions.ts`).
3. **Database (PostgreSQL RLS):** `app.has_permission()`, `app.in_scope()`, `app.can_assign_role()` inside every policy. The final wall.

The organization, roles and permissions of a caller are always derived from `organization_members -> user_roles -> role_permissions`; nothing comes from the request.

## Who may change roles

- The **owner role can never be granted or removed** through the API.
- Only the **owner** can create or change **admins**. Admins can move people between Teacher and Student.
- Nobody can change their own role, or suspend themselves. An admin cannot suspend the owner.
- Role definitions (`roles`, `permissions`, `role_permissions`) are read-only for every user session (migrations 036 + 039); only the platform changes them.
- A role change replaces the previous organization role (no accumulation) and takes effect on the next request.

## Teacher scope (`user_scopes`)

A teacher sees only the subjects, courses or academic units assigned to them (`app.in_scope`). Owners and admins see everything.
Scopes are assigned with `PUT /api/v1/teachers/:id/scopes` (Phase 9, see `teachers.md`).

## Endpoints in this phase

| Endpoint                             | Permission                             |
| ------------------------------------ | -------------------------------------- |
| `GET /api/v1/users`                  | `user.read`                            |
| `POST /api/v1/users/admins`          | owner + `user.create`                  |
| `PUT /api/v1/users/:userId/role`     | `user.update` (admin role: owner only) |
| `PATCH /api/v1/users/:userId/status` | `user.update`                          |
| `GET /api/v1/roles`                  | `settings.read`                        |

## Adding a permission later (checklist)

1. New migration: `insert into permissions ...` and `insert into role_permissions ...` (never edit an applied migration).
2. Add the code to `src/auth/permissions.ts` (a test fails until the list equals the database).
3. Add it to `utils/permissions.ts` in the frontend.
4. Use `requirePermission('new.code')` on the route and `<Can>` / `RequirePermission` in the UI.

## Known simplifications

- Inviting an e-mail that already has an account links that account to the organization immediately (there is no "accept invitation" step yet).
- A person who belongs to several organizations always works in the earliest one; an organization switcher is not built yet.
