# exam-platform-backend

Node.js + TypeScript (Fastify) REST API for the multi-tenant Online Examination & Assessment platform.
Owns the database migrations (`supabase/migrations/`). Status: **Phase 1 – project setup**.

## Requirements

Node 20.11+ (22 recommended), npm, a Redis instance, and a Supabase project (separate project per environment).

## Install

```bash
npm install
cp .env.example .env   # then fill in the values; never commit .env
```

## Run

```bash
npm run dev            # watch mode
npm run build && npm start
curl http://localhost:4000/health
```

`/health` returns 503 until both `DATABASE_URL` and `REDIS_URL` point to reachable services.

## Quality checks

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

## Docker

```bash
docker build -f docker/Dockerfile -t exam-platform-backend .
docker run --env-file .env -p 4000:4000 exam-platform-backend
```

## Layout

`src/modules/*` hold feature code (filled phase by phase), `src/middleware`, `src/health`, `src/config`,
`openapi/openapi.yaml` is the API contract the frontend will generate types from.
