// zod request schemas.
import { z } from 'zod';
import { AppError } from './errors.js';

export const commandSchema = z
  .object({ text: z.string({ required_error: 'text is required' }).trim().min(1, 'command is empty').max(300, 'command is longer than 300 characters') })
  .strict();

export const operationSchema = z.object({}).strict();

export const terminateSchema = z.object({ confirm: z.string().max(100).optional() }).strict();

export const logsQuerySchema = z.object({ since: z.coerce.number().int().min(0).optional().default(0) }).passthrough();

export function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
    throw new AppError('INVALID_INPUT', `Invalid request — ${where}${issue.message}.`, 400);
  }
  return r.data;
}
