/**
 * Step and conditional types for AgentFlow
 */
import { z } from "zod";
import type { LanguageModel } from "ai";
import { FlowTool, InferToolResults } from "./tools";
import { WorkflowState, StepResult } from "./state";

/** Step type determines execution mode */
export type StepType = "ai" | "structured";

/** Tool choice options for AI steps */
export type ToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "tool"; toolName: string };

/** Step error types for onError handler */
export type StepErrorType =
  | "no_tool_call"
  | "validation_failed"
  | "missing_dependency"
  | "execution_error"
  | "timeout";

/** Error passed to step onError handler */
export interface StepError {
  type: StepErrorType;
  message: string;
  details?: unknown;
}

/** Actions returned from onError handler */
export type ErrorAction =
  | { action: "retry"; maxAttempts?: number }
  | { action: "goto"; stepName: string }
  | { action: "skip"; data?: unknown }
  | void;

/** Error handler context with action helpers */
export interface ErrorHandlerActions {
  retry: (opts?: { maxAttempts?: number }) => {
    action: "retry";
    maxAttempts?: number;
  };
  goto: (stepName: string) => { action: "goto"; stepName: string };
  skip: (data?: unknown) => { action: "skip"; data?: unknown };
}

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
  /**
   * Step execution type:
   * - 'ai' (default): Full AI loop with streamText, supports tools
   * - 'structured': Uses generateObject for guaranteed typed output, no tools
   */
  type?: StepType;
  model: LanguageModel;
  tools?: TTools;
  /**
   * Zod schema for structured output (required when type: 'structured')
   * The step will use generateObject and return typed data matching this schema
   */
  schema?: TSchema;
  prompt:
    | string
    | ((state: TState, input: TInput, context?: TContext) => string);
  /**
   * Control tool calling behavior (only applies to type: 'ai'):
   * - 'auto': Model decides whether to call tools (default)
   * - 'required': Model must call at least one tool
   * - 'none': Model cannot call tools
   * - { type: 'tool', toolName: string }: Model must call specific tool
   */
  toolChoice?: ToolChoice;
  /** Maximum retries for this step (default: 3) */
  maxRetries?: number;
  /** Timeout for entire step in milliseconds */
  timeout?: number;
  /** Use TOON format for tool schemas to reduce token usage by ~40% (default: false) */
  useTOON?: boolean;
  /**
   * Data requirements that must be satisfied before step runs.
   * - string[]: Paths that must exist and be truthy (e.g., ['search.toolResults.hotels'])
   * - Record<string, ZodSchema>: Paths with schema validation
   */
  requires?: string[] | Record<string, z.ZodTypeAny>;
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
  /**
   * Error handler for step-level failures.
   * Called when step fails after retries, validation fails, or requirements not met.
   * Return an action to retry, goto another step, or skip with data.
   */
  onError?: (
    error: StepError,
    state: TState,
    actions: ErrorHandlerActions,
  ) => ErrorAction;
  /** Steps that must complete before this step runs (for DAG execution) */
  dependsOn?: string[];
  _isParallel?: boolean;
  _parallelSteps?: FlowStep<TState, any, any, any, any, any>[];
  _toolResults?: InferToolResults<TTools>; // Phantom type for inference
}
