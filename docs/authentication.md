# Authentication (Phase 5)

Supabase Auth owns passwords, sessions, e-mails and tokens. Our backend never sees or stores a password after sign-up.

## Flows

| Flow                        | Who does what                                                                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Register**                | browser -> `POST /api/v1/auth/register` -> backend creates the Supabase login (sends the verification e-mail), then creates organization, settings, owner membership, owner role and trial **in one database transaction**. If that fails the login is deleted again: no half organization, no orphan login. |
| **Verify e-mail**           | The link in the e-mail signs the user in and lands on `/verify-email` ("Email verified"). Until then Supabase refuses sign-in. The organization turns `active` the first time the verified owner calls the API.                                                                                              |
| **Login**                   | browser -> Supabase Auth directly (`signInWithPassword`); supabase-js keeps and refreshes the session. `POST /api/v1/auth/login` exists for API clients and is rate limited.                                                                                                                                 |
| **Session restore**         | On page load the app asks supabase-js for the stored session, then loads `GET /api/v1/me`.                                                                                                                                                                                                                   |
| **Session expiry**          | If the API answers 401 to a request that carried a token, the app signs out, clears all cached data and shows "Your session has expired".                                                                                                                                                                    |
| **Logout**                  | `supabase.auth.signOut()` + the whole query cache is cleared. A different user signing in never sees the previous user's cached data.                                                                                                                                                                        |
| **Forgot / reset password** | `resetPasswordForEmail` -> e-mail link -> `/reset-password` (temporary session) -> `updateUser({ password })`. The "sent" message never reveals whether an account exists.                                                                                                                                   |

## `GET /api/v1/me`

Returns the signed-in user, `organization` (or `null`), `roles`, `permissions`, teacher `scopes` and `studentId`. The organization
is derived from membership; a suspended organization shows as `null`.

## Protection

- Backend: `authenticate` verifies the Bearer token with Supabase on every request; `requirePermission(...)` guards routes.
- Frontend: `RequireAuth` / `GuestOnly` route guards (UX only; the API and database enforce access).
- Rate limits: login and register 10 per minute per client; everything else 300 per minute. Redis-backed when Redis is running.
- Return-to paths after login are validated (no open redirects).

## Supabase dashboard settings you must check (Authentication)

1. **URL Configuration -> Site URL**: `http://localhost:5173` (your real domain later).
2. **URL Configuration -> Redirect URLs**: add `http://localhost:5173/verify-email` and `http://localhost:5173/reset-password`.
3. **Sign In / Providers -> Email**: "Confirm email" on, minimum password length 8.
4. The built-in e-mail sender allows only a few e-mails per hour: fine for testing, use your own SMTP provider before launch.
