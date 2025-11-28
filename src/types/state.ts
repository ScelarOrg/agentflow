/**
 * State types for AgentFlow
 */
import { z } from "zod";
import { FlowTool, InferToolResults, InferUserConfirmation } from "./tools";

export interface StepResult<
  TToolResults = unknown,
  TUserConfirmation = unknown,
> {
  text: string;
  toolResults: TToolResults;
  userConfirmation?: TUserConfirmation;
}

export interface WorkflowState {
  [stepName: string]: StepResult;
}

// Build state progressively as steps are added
export type AddStepToState<
  TCurrentState extends WorkflowState,
  TStepName extends string,
  TTools extends Record<string, FlowTool>,
  TSchema extends z.ZodTypeAny = never,
  TMode extends "text" | "object" = "text",
> = TCurrentState & {
  [K in TStepName]: StepResult<
    TMode extends "object"
      ? TSchema extends z.ZodTypeAny
        ? z.infer<TSchema>
        : unknown
      : InferToolResults<TTools>,
    InferUserConfirmation<TTools>
  >;
};

// Type-safe state accessor - extracts tool results type from a specific step
export type ExtractStepToolResults<
  TState extends WorkflowState,
  TStepName extends keyof TState,
> = TState[TStepName] extends StepResult<infer T> ? T : never;

/**
 * Step Data Types (Runtime)
 */
export interface StepData {
  toolResults: Record<string, unknown>;
  toolCall?: {
    name: string;
    args: unknown;
  };
  userConfirmation?: unknown;
}
