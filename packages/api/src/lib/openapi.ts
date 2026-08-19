import { z } from '@hono/zod-openapi';
import { errorResponseSchema } from '@inventory/shared';

// Shared bits for OpenAPI route definitions — keeps entity routers terse.

export const jsonContent = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});

export const jsonBody = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

export const errorResponse = (description: string) => ({
  description,
  ...jsonContent(errorResponseSchema),
});

export const idParam = z.object({ id: z.uuid() });
