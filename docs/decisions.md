# Decisions

- Fastify chosen over Express: built-in schema/logging support, good TypeScript types.
- Backend repo owns `supabase/migrations/`. The frontend repo never changes the database.
- Backend uses ESM (`"type": "module"`); relative imports end in `.js`.
- Health endpoint is served at `/health` (load balancers) and `/api/v1/health` (API contract).
