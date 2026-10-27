// PURPOSE: Builds openapi/openapi.yaml from the routes the app really registers, plus hand-written summaries and schemas.
// WHY: The API contract can never silently drift from the code: a test regenerates it and compares with the committed file.
// DEPENDS ON: app.registeredRoutes (set in app.ts), yaml package. Run with: npm run openapi:generate

import { stringify } from 'yaml';

interface Route {
  method: string;
  url: string;
}

const SUMMARIES: Record<string, string> = {
  'POST /auth/register':
    'Register an organization and its owner (atomic). Sends the verification email.',
  'POST /auth/login':
    'Sign in with email and password (the web app normally uses Supabase Auth directly).',
  'GET /me': 'Current user, organization, roles, permissions, teacher scopes and student id.',
  'GET /organizations/current': 'Current organization profile.',
  'PATCH /organizations/current': 'Update organization profile (organization.update).',
  'PATCH /organizations/current/settings': 'Update branding and timezone (settings.update).',
  'GET /academic-levels': 'All level names of the organization, in order (any member).',
  'POST /academic-levels': 'Add a level at the bottom of the order (academic.manage).',
  'PUT /academic-levels/order':
    'Replace the level order; refused if a unit would end up above its parent.',
  'DELETE /academic-levels/{id}': 'Delete a level that no unit uses (academic.manage).',
  'GET /academic-units/tree':
    'Every level and active unit in one call (flat list; nest by parentId).',
  'POST /academic-units': 'Create a unit; its parent must sit on a higher level (academic.manage).',
  'DELETE /academic-units/{id}':
    'Soft-delete a unit with no active sub-units, courses, subjects or students.',
  'GET /courses': 'Courses visible to the caller (teachers: only their scope).',
  'DELETE /courses/{id}': 'Soft-delete a course that has no active subjects.',
  'GET /subjects': 'Subjects visible to the caller (teachers: only their scope).',
  'DELETE /subjects/{id}': 'Soft-delete a subject that has no active topics or questions.',
  'GET /topics': 'Topics of subjects visible to the caller (filter by subjectId).',
  'POST /topics': 'Add a topic to a subject inside the scope of the caller (topic.create).',
  'DELETE /topics/{id}': 'Soft-delete a topic that no active question uses.',
  'GET /organizations/current/onboarding': 'Onboarding progress (10 steps).',
  'PUT /organizations/current/onboarding': 'Save onboarding progress.',
  'GET /organizations/current/subscription': 'Plan, status and usage against plan limits.',
  'GET /organizations/current/dashboard':
    'One optimized dashboard payload (totals, charts, recent activity), scoped by RLS.',
  'POST /students/import':
    'Import up to 500 students; returns per-row failures. dryRun validates without saving.',
  'GET /students': 'Students; academicUnitId includes every unit below it (student.read).',
  'GET /students/{id}': 'One student record with unit and login state.',
  'POST /students': 'Add a student; invite: true also creates the login and sends the invitation.',
  'PATCH /students/{id}':
    'Edit a student or move them to another unit; inactive locks the login out.',
  'DELETE /students/{id}': 'Remove a student: soft delete, membership removed; results stay.',
  'POST /students/{id}/invite': 'Create/link a login for the student and send an invitation.',
  'PUT /teachers/{id}/scopes': 'Replace the subjects/courses/units a teacher may access.',
  'GET /teachers': 'Teacher records with login status and scope size (teacher.read).',
  'GET /teachers/{id}': 'Teacher record with the subjects, courses and units in their scope.',
  'POST /teachers':
    'Add a teacher; by default creates/links the login and sends the invitation (atomic).',
  'POST /teachers/{id}/invite': 'Create/link the login of a teacher added without one.',
  'PATCH /teachers/{id}': 'Edit a teacher; inactive also locks the login out.',
  'DELETE /teachers/{id}': 'Remove a teacher: soft delete, membership removed, scope cleared.',
  'GET /questions/{id}': 'Question with options and answer key (never reachable by students).',
  'POST /questions/{id}/publish': 'Publish a complete question (question.publish).',
  'PUT /exams/{id}/assignments':
    'Replace who the exam is assigned to (organization, units, subjects, students).',
  'POST /exams/{id}/unpublish': 'Take a published exam offline (exam.unpublish).',
  'GET /exams': 'Exams visible to the caller (teachers: the exams they created).',
  'GET /exams/{id}': 'Exam with settings, ordered questions and assignment targets.',
  'GET /questions':
    'Questions in the caller scope; filters subject, topic, status, difficulty, type.',
  'PUT /questions/{id}': 'Replace question content (refused once students answered it).',
  'PATCH /questions/{id}/status': 'Back to draft or archive a question.',
  'GET /results/{id}': 'One result with every answer and the correct option (staff only).',
  'PUT /exams/{id}/questions': 'Replace the exam question set (frozen once attempts exist).',
  'POST /exams/{id}/publish': 'Publish an exam (needs settings and questions).',
  'POST /exams/{id}/start': 'Start (or resume) an attempt. Server sets the authoritative deadline.',
  'GET /student/exams': 'Exams currently available to the signed-in student.',
  'GET /attempts/{id}': 'Exam paper WITHOUT answer keys. Auto-submits if the deadline passed.',
  'POST /attempts/{id}/answers': 'Idempotent auto-save of one answer.',
  'POST /attempts/{id}/submit': 'Idempotent submit; server evaluates and stores the result once.',
  'GET /attempts/{id}/review': 'Detailed result; correct answers only if the exam allows it.',
  'GET /student/results': 'Own results for exams that show results.',
  'GET /results': 'Results visible to the caller (teachers: only their exams).',
  'GET /leaderboards': 'Leaderboard by scope: exam, organization, academic_unit, subject.',
  'GET /reports/{type}':
    'Report: exam-performance, student-performance, pass-fail, question-performance, course-performance, participation.',
  'GET /health': 'API, database and Redis connectivity.',
};

const PUBLIC = new Set([
  'GET /health',
  'GET /api/v1/health',
  'POST /auth/register',
  'POST /auth/login',
]);
const LIST =
  /^\/(academic-units|courses|subjects|topics|students|teachers|users|questions|exams|results|notifications|audit-logs|platform\/(organizations|users|subscriptions|audit-logs)|reports\/\{type\}|leaderboards)$/;

export function generateOpenApi(routes: Route[]): string {
  const paths: Record<string, Record<string, unknown>> = {};
  const seen = new Set<string>();
  for (const r of routes) {
    if (r.url === '/health') continue; // the unversioned alias is documented via /health below
    const rel = r.url.replace(/^\/api\/v1/, '').replace(/:([A-Za-z]+)/g, '{$1}');
    const key = `${r.method.toUpperCase()} ${rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const method = r.method.toLowerCase();
    const tag = rel.split('/')[1] === 'platform' ? 'platform' : (rel.split('/')[1] ?? 'root');
    const params = [...rel.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    const isList = method === 'get' && LIST.test(rel);
    const op: Record<string, unknown> = {
      tags: [tag],
      summary: SUMMARIES[key] ?? `${method.toUpperCase()} ${rel}`,
      operationId: `${method}${rel
        .replace(/[{}]/g, '')
        .split(/[/-]/)
        .filter(Boolean)
        .map((w) => w[0]!.toUpperCase() + w.slice(1))
        .join('')}`,
      ...(PUBLIC.has(key) ? { security: [] } : {}),
      parameters: [
        ...params,
        ...(isList
          ? [
              { $ref: '#/components/parameters/Page' },
              { $ref: '#/components/parameters/PageSize' },
              { $ref: '#/components/parameters/Search' },
              { $ref: '#/components/parameters/Sort' },
              { $ref: '#/components/parameters/Order' },
            ]
          : []),
      ],
      ...(['post', 'put', 'patch'].includes(method)
        ? {
            requestBody: {
              required: false,
              content: {
                'application/json': { schema: { type: 'object', additionalProperties: true } },
              },
            },
          }
        : {}),
      responses: {
        '200': {
          description: 'Success',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } },
        },
        '400': { $ref: '#/components/responses/Error' },
        '401': { $ref: '#/components/responses/Error' },
        '403': { $ref: '#/components/responses/Error' },
        '404': { $ref: '#/components/responses/Error' },
        '429': { $ref: '#/components/responses/Error' },
      },
    };
    if (!op.parameters || (op.parameters as unknown[]).length === 0) delete op.parameters;
    (paths[rel] ??= {})[method] = op;
  }
  const doc = {
    openapi: '3.0.3',
    info: {
      title: 'Exam Platform API',
      version: '0.2.0',
      description:
        'Multi-tenant online examination platform. All responses use {success, data, error, requestId}. The organization is derived from the authenticated user, never from the request.',
    },
    servers: [{ url: '/api/v1' }],
    security: [{ bearerAuth: [] }],
    tags: [
      ...new Set(
        Object.keys(paths).map((p) =>
          p.split('/')[1] === 'platform' ? 'platform' : (p.split('/')[1] ?? 'root'),
        ),
      ),
    ]
      .sort()
      .map((name) => ({ name })),
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'Supabase access token (JWT)' },
      },
      parameters: {
        Page: { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        PageSize: {
          name: 'pageSize',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
        Search: { name: 'search', in: 'query', schema: { type: 'string', maxLength: 100 } },
        Sort: {
          name: 'sort',
          in: 'query',
          schema: { type: 'string' },
          description: 'Whitelisted per endpoint; unknown values fall back to the default sort.',
        },
        Order: {
          name: 'order',
          in: 'query',
          schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
        },
      },
      responses: {
        Error: {
          description: 'Failure envelope',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } },
        },
      },
      schemas: {
        ApiError: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', example: 'FORBIDDEN' },
            message: { type: 'string' },
            details: {},
          },
        },
        Envelope: {
          type: 'object',
          required: ['success', 'data', 'error', 'requestId'],
          properties: {
            success: { type: 'boolean' },
            data: { nullable: true },
            error: { nullable: true, allOf: [{ $ref: '#/components/schemas/ApiError' }] },
            requestId: { type: 'string' },
          },
        },
        Pagination: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            pageSize: { type: 'integer' },
            total: { type: 'integer' },
            totalPages: { type: 'integer' },
          },
        },
      },
    },
  };
  return `# GENERATED by "npm run openapi:generate" from the registered routes. Do not edit by hand.\n${stringify(doc, { lineWidth: 0 })}`;
}
