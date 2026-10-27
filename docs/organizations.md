# Organizations (Phase 4)

A **tenant** is one organization (college, school, coaching institute ...). Everything else hangs off `organization_id`.

## How the current organization is found

```
Bearer token -> Supabase Auth verifies it -> user id
user id -> organization_members (active) -> organization_id
organization_id -> user_roles -> role_permissions -> permissions
```

The client can send `?organizationId=...` or an `x-organization-id` header: both are ignored. `PATCH` bodies that contain
`status`, `orgCode`, `id`, `organizationId` ... are rejected (strict schemas). PostgreSQL row level security repeats every check.

## Endpoints

| Method and path                                | Permission                         | What it does                                   |
| ---------------------------------------------- | ---------------------------------- | ---------------------------------------------- |
| `GET /api/v1/organizations/current`            | `organization.read`                | profile + branding + timezone                  |
| `PATCH /api/v1/organizations/current`          | `organization.update` (owner only) | name, contactEmail, contactPhone, address      |
| `PATCH /api/v1/organizations/current/settings` | `settings.update` (owner, admin)   | branding (`primaryColor`, `tagline`), timezone |

## Lifecycle

- Registration (Phase 5 endpoint, database function ready): creates organization, settings, owner membership, owner role,
  trial subscription and the academic levels that fit the institution type, **in one transaction**.
- Status `pending_email` becomes `active` the first time the owner calls the API after verifying their email.
- Status `suspended` or `closed` locks every member out at once (API and database).
- Only the platform (backend system connection) can change `status`, `org_code`, `deleted_at`.

## Trying it before Phase 5 login screens exist

```bash
node scripts/dev-create-org.mjs --email owner@college.test --password "Passw0rd!x" --owner "Asha Verma" --org "Demo College" --type engineering
```

Then sign in at `http://localhost:5173/dev/signin` (development builds only) and open `/org/profile`.
