import { z } from "zod";

/** `GET /health/live`: the process is running. Never touches dependencies. */
export const LivenessResponseSchema = z.strictObject({
  status: z.literal("ok"),
});

export type LivenessResponse = z.infer<typeof LivenessResponseSchema>;

export const DependencyStatusSchema = z.enum(["up", "down"]);

/**
 * `GET /health/ready`: the process can serve traffic. 200 with `ready` when
 * every dependency is up; 503 with `not_ready` otherwise. Reports status only,
 * never connection details or error messages.
 */
export const ReadinessResponseSchema = z.strictObject({
  status: z.enum(["ready", "not_ready"]),
  checks: z.strictObject({
    database: DependencyStatusSchema,
  }),
});

export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
