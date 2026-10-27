// PURPOSE: Parses and validates list query params (page, pageSize, search, sort, order) safely.
// WHY: Every list endpoint must paginate, search and sort without allowing SQL injection via sort columns.
// DEPENDS ON: zod.

import { z } from 'zod';
import type { Paginated } from '../types/api.js';

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  sort: z.string().trim().max(50).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export function paginate<T>(
  items: T[],
  total: number,
  q: { page: number; pageSize: number },
): Paginated<T> {
  return {
    items,
    pagination: {
      page: q.page,
      pageSize: q.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
    },
  };
}

/** Escapes % and _ so user text is matched literally inside ILIKE. */
export const likePattern = (s: string): string => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
