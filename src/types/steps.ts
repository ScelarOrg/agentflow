/**
 * Step and conditional types for AgentFlow
 */
import { z } from "zod";
import type { LanguageModel } from "ai";
import { FlowTool, InferToolResults } from "./tools";
import { WorkflowState, StepResult } from "./state";

export type ConditionalResult<TToolResults = unknown> =
  | { skip: true; data?: TToolResults }
  | { skip: false; goto?: string }
  | { skip: false };

export interface ExecuteContext<TContext = unknown> {
  context?: TContext; // User-provided context (e.g., sandbox, database, API client, etc.)
  state: WorkflowState; // Current workflow state
  stepName: string; // Name of the step being executed
}

/** Validation result for step output */
export type ValidationResult =
  | { valid: true }
  | { valid: false; retry?: boolean; message?: string };

export interface FlowStep<
  TState = WorkflowState,
  TTools extends Record<string, FlowTool> = Record<string, FlowTool>,
  TStepName extends string = string,
  TSchema extends z.ZodTypeAny = never,
  TContext = unknown,
  TInput = unknown,
> {
  name: TStepName;
  /** Human-readable description of what this step does */
  description?: string;
  model: LanguageModel;
  tools?: TTools;
  prompt:
    | string
    | ((state: TState, input: TInput, context?: TContext) => string);
  /** Maximum retries for this step (default: 3) */
  maxRetries?: number;
  /** Timeout for entire step in milliseconds */
  timeout?: number;
  /** Use TOON format for tool schemas to reduce token usage by ~40% (default: false) */
  useTOON?: boolean;
  /** Condition to skip or modify step execution */
  condition?: (
    state: TState,
    input: TInput,
  ) => ConditionalResult<InferToolResults<TTools>> | boolean;
  /** Transform tool results before storing in state */
  transform?: (
    toolResults: InferToolResults<TTools>,
  ) => InferToolResults<TTools>;
  /** Validate step output before proceeding */
  validate?: (result: StepResult<InferToolResults<TTools>>) => ValidationResult;
  /** Execute callback after step completes */
  execute?: (
    result: StepResult,
    context: ExecuteContext<TContext>,
  ) => Promise<void> | void;
  /** Steps that must complete before this step runs (for DAG execution) */
  dependsOn?: string[];
  _isParallel?: boolean;
  _parallelSteps?: FlowStep<TState, any, any, any, any, any>[];
  _toolResults?: InferToolResults<TTools>; // Phantom type for inference
}
