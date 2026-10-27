// PURPOSE: The single, typed list of permission codes and role codes (mirrors the database seed in migrations 006-008).
// WHY: A typo like requirePermission('exam.creat') becomes a compile error; a test proves this list equals the database.
// DEPENDS ON: Nothing. Used by middleware/authorization.ts and every route guard.

export const PERMISSIONS = [
  'organization.read',
  'organization.update',
  'user.read',
  'user.create',
  'user.update',
  'user.delete',
  'student.read',
  'student.create',
  'student.update',
  'student.delete',
  'student.import',
  'teacher.read',
  'teacher.create',
  'teacher.update',
  'teacher.delete',
  'teacher.assign_scope',
  'academic.manage',
  'course.read',
  'course.create',
  'course.update',
  'course.delete',
  'subject.read',
  'subject.create',
  'subject.update',
  'subject.delete',
  'topic.read',
  'topic.create',
  'topic.update',
  'topic.delete',
  'question.create',
  'question.read',
  'question.update',
  'question.delete',
  'question.publish',
  'exam.read',
  'exam.create',
  'exam.update',
  'exam.delete',
  'exam.assign',
  'exam.publish',
  'exam.unpublish',
  'result.read',
  'report.read',
  'leaderboard.read',
  'settings.read',
  'settings.update',
  'subscription.read',
  'notification.read',
  'audit.read',
] as const;
export type PermissionCode = (typeof PERMISSIONS)[number];

export const ROLES = {
  PLATFORM_SUPER_ADMIN: 'PLATFORM_SUPER_ADMIN',
  ORGANIZATION_OWNER: 'ORGANIZATION_OWNER',
  ORGANIZATION_ADMIN: 'ORGANIZATION_ADMIN',
  TEACHER: 'TEACHER',
  STUDENT: 'STUDENT',
} as const;
export type RoleCode = (typeof ROLES)[keyof typeof ROLES];

export const hasPermission = (
  caller: { permissions: readonly string[] },
  permission: PermissionCode,
): boolean => caller.permissions.includes(permission);
export const hasRole = (caller: { roles: readonly string[] }, role: RoleCode): boolean =>
  caller.roles.includes(role);
