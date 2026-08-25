import { z } from "zod";

export const conduitMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET");

export const conduitStepSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  method: conduitMethodSchema,
  headers: z.record(z.string(), z.string()).optional(),
  query_transform: z.string().optional(),
  body_transform: z.string().optional(),
  needs: z.array(z.string()).optional(),
  output_schema: z.unknown().optional(),
});

const conduitStepsSchema = z
  .array(conduitStepSchema)
  .min(1)
  .superRefine((steps, ctx) => {
    const ids = new Set(steps.map((step) => step.id));
    steps.forEach((step, i) => {
      (step.needs ?? []).forEach((dep, j) => {
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: "custom",
            message: `Step "${step.id}" needs unknown step "${dep}"`,
            path: ["steps", i, "needs", j],
          });
        }
      });
    });
    const counts = new Map<string, number>();
    steps.forEach((step) => counts.set(step.id, (counts.get(step.id) ?? 0) + 1));
    steps.forEach((step, i) => {
      if ((counts.get(step.id) ?? 0) > 1) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate step id "${step.id}"`,
          path: ["steps", i, "id"],
        });
      }
    });
  });

export const conduitSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.unknown().optional(),
  output_schema: z.unknown().optional(),
  steps: conduitStepsSchema,
  output_transform: z.string().min(1),
});

export type ConduitMethod = z.infer<typeof conduitMethodSchema>;
export type ConduitStep = z.infer<typeof conduitStepSchema>;
export type Conduit = z.infer<typeof conduitSchema>;

export function parseConduit(raw: unknown): Conduit {
  return conduitSchema.parse(raw);
}
