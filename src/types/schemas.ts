/**
 * Validation schemas for AgentFlow
 */
import { z } from "zod";

export const ResumePayloadSchema = z.object({
  toolCallId: z.string().min(1),
  result: z.unknown(),
  stepName: z.string().min(1),
});

export const WorkflowInputSchema = z.object({
  input: z.record(z.string(), z.unknown()),
});

export const StreamConfigSchema = z.object({
  workflow: z.object({
    steps: z.array(z.any()),
  }),
  input: z.record(z.string(), z.unknown()),
  workflowId: z.string().optional(),
});
