import { z } from 'zod';
import type { BotContext } from './types.js';

/** Validate one config field against `schema`, warning and falling back when invalid. */
export function resolveConfigField<S extends z.ZodTypeAny>(
    pluginName: string,
    field: string,
    schema: S,
    configured: unknown,
    fallback: z.infer<S>,
    logger: BotContext['logger'],
): z.infer<S> {
    if (configured === undefined) return fallback;
    const result = schema.safeParse(configured);
    if (result.success) return result.data;
    logger.warn(
        { field, configured, issues: result.error.issues },
        `invalid ${pluginName} config value; falling back to default`,
    );
    return fallback;
}
