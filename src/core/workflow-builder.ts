import {
  FlowStep,
  FlowTool,
  WorkflowState,
  ConditionalResult,
  ValidationError,
  AddStepToState,
  StepResult,
  ExecuteContext,
  InferToolResults,
  ValidationResult,
  StepType,
  ToolChoice,
  StepError,
  ErrorAction,
  ErrorHandlerActions,
} from "../types";
import { z } from "zod";
import type { LanguageModel } from "ai";

/** Error handler for workflow-level errors */
export type WorkflowErrorHandler = (
  error: Error,
  stepName: string,
  state: WorkflowState,
) => void | Promise<void>;

export class WorkflowBuilder<
  TState extends WorkflowState = {},
  TInput = unknown,
> {
  private steps: FlowStep<any, any, any, any, any, any>[] = [];
  private errorHandler?: WorkflowErrorHandler;

  /**
   * Set a global error handler for the workflow.
   * Called when any step fails after all retries.
   *
   * @example
   * ```ts
   * flow<Input>()
   *   .onError((error, stepName, state) => {
   *     console.error(`Step ${stepName} failed:`, error);
   *     // Log to analytics, send alert, etc.
   *   })
   *   .step('search', { ... })
   * ```
   */
  onError(handler: WorkflowErrorHandler): this {
    this.errorHandler = handler;
    return this;
  }

  /**
   * Add a step to the workflow with full type safety.
   * The state type will automatically include all previous steps' data.
   *
   * @example
   * ```ts
   * const workflow = flow<{ city: string; dates: string }>()
   *   .step('search', {
   *     model: openai('gpt-4'),
   *     tools: { searchHotels: automatedTool({ ... }) },
   *     // Access input as second parameter
   *     prompt: (state, input) => `Find hotels in ${input.city}`
   *   })
   *   .step('confirm', {
   *     model: openai('gpt-4'),
   *     tools: { confirmBooking: userInteractive({ ... }) },
   *     // TypeScript knows about state.search here!
   *     prompt: (state) => `Confirm booking for ${state.search.toolResults.searchHotels}`
   *   })
   * ```
   */
  step<
    TStepName extends string,
    TTools extends Record<string, FlowTool> = {},
    TSchema extends z.ZodTypeAny = never,
    TStepType extends StepType = "ai",
    TNewState extends WorkflowState = AddStepToState<
      TState,
      TStepName,
      TTools,
      TSchema,
      TStepType extends "structured" ? "object" : "text"
    >,
  >(
    name: TStepName,
    config: {
      /** Human-readable description of what this step does */
      description?: string;
      /**
       * Step execution type:
       * - 'ai' (default): Full AI loop with streamText, supports tools
       * - 'structured': Uses generateObject for guaranteed typed output, no tools
       */
      type?: TStepType;
      model: LanguageModel;
      tools?: TTools;
      /**
       * Zod schema for structured output (required when type: 'structured')
       * The step will use generateObject and return typed data matching this schema
       */
      schema?: TSchema;
      prompt:
        | string
        | ((state: TState, input: TInput, context?: unknown) => string);
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
      validate?: (
        result: StepResult<InferToolResults<TTools>>,
      ) => ValidationResult;
      /** Execute callback after step completes */
      execute?: (
        result: StepResult,
        context: ExecuteContext,
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
    },
  ): WorkflowBuilder<TNewState, TInput> {
    // Validate step name
    if (!name || typeof name !== "string") {
      throw new ValidationError("Step name must be a non-empty string");
    }

    // Check for duplicate step names
    if (this.steps.some((s) => s.name === name)) {
      throw new ValidationError(`Duplicate step name: ${name}`, {
        stepName: name,
      });
    }

    // Validate model
    if (!config.model) {
      throw new ValidationError(`Step "${name}" must have a model`, {
        stepName: name,
      });
    }

    // Validate prompt
    if (!config.prompt) {
      throw new ValidationError(`Step "${name}" must have a prompt`, {
        stepName: name,
      });
    }

    // Validate maxRetries
    if (config.maxRetries !== undefined && config.maxRetries < 0) {
      throw new ValidationError(
        `Step "${name}" maxRetries must be non-negative`,
        { stepName: name, maxRetries: config.maxRetries },
      );
    }

    // Validate structured steps have a schema
    if (config.type === "structured" && !config.schema) {
      throw new ValidationError(
        `Step "${name}" has type 'structured' but no schema defined`,
        { stepName: name },
      );
    }

    // Warn if tools are provided with structured type (they won't be used)
    if (
      config.type === "structured" &&
      config.tools &&
      Object.keys(config.tools).length > 0
    ) {
      console.warn(
        `Step "${name}" has type 'structured' - tools will be ignored. Use type 'ai' for tool support.`,
      );
    }

    this.steps.push({
      name,
      description: config.description,
      type: config.type,
      model: config.model,
      tools: config.tools,
      schema: config.schema,
      prompt: config.prompt as
        | string
        | ((state: WorkflowState, input: unknown, context?: unknown) => string),
      toolChoice: config.toolChoice,
      maxRetries: config.maxRetries ?? 3,
      timeout: config.timeout,
      useTOON: config.useTOON,
      requires: config.requires,
      condition: config.condition as
        | ((
            state: WorkflowState,
            input: unknown,
          ) => ConditionalResult<any> | boolean)
        | undefined,
      transform: config.transform as ((toolResults: any) => any) | undefined,
      validate: config.validate as
        | ((result: any) => ValidationResult)
        | undefined,
      execute: config.execute,
      onError: config.onError as any,
      dependsOn: config.dependsOn,
    } as FlowStep<TState, TTools, TStepName, TSchema, unknown, TInput>);

    return this as unknown as WorkflowBuilder<TNewState, TInput>;
  }

  /**
   * Run multiple steps in parallel
   * @param steps Array of step configurations to run simultaneously
   */
  parallel<
    TParallelSteps extends Array<{
      name: string;
      /** Human-readable description of what this step does */
      description?: string;
      model: LanguageModel;
      tools?: Record<string, FlowTool>;
      prompt:
        | string
        | ((state: TState, input: TInput, context?: unknown) => string);
      maxRetries?: number;
      /** Timeout for entire step in milliseconds */
      timeout?: number;
      condition?: (state: TState, input: TInput) => ConditionalResult | boolean;
    }>,
  >(
    steps: TParallelSteps,
  ): WorkflowBuilder<
    TState & {
      [K in TParallelSteps[number]["name"]]: StepResult<
        TParallelSteps[number] extends { name: K; tools: infer T }
          ? T extends Record<string, FlowTool>
            ? InferToolResults<T>
            : Record<string, unknown>
          : Record<string, unknown>
      >;
    },
    TInput
  > {
    if (!steps || steps.length === 0) {
      throw new ValidationError("parallel() requires at least one step");
    }

    // Validate all parallel steps
    const stepNames = new Set<string>();
    for (const config of steps) {
      if (!config.name || typeof config.name !== "string") {
        throw new ValidationError(
          "Parallel step name must be a non-empty string",
        );
      }

      if (stepNames.has(config.name)) {
        throw new ValidationError(
          `Duplicate step name in parallel group: ${config.name}`,
          { stepName: config.name },
        );
      }
      stepNames.add(config.name);

      if (this.steps.some((s) => s.name === config.name)) {
        throw new ValidationError(`Duplicate step name: ${config.name}`, {
          stepName: config.name,
        });
      }

      if (!config.model) {
        throw new ValidationError(
          `Parallel step "${config.name}" must have a model`,
          { stepName: config.name },
        );
      }

      if (!config.prompt) {
        throw new ValidationError(
          `Parallel step "${config.name}" must have a prompt`,
          { stepName: config.name },
        );
      }
    }

    // Create the parallel steps
    const parallelSteps: FlowStep<TState, any, any, any, any, any>[] =
      steps.map((config) => ({
        name: config.name,
        description: config.description,
        model: config.model,
        mode: "text", // Parallel steps currently only support text mode
        tools: config.tools,
        prompt: config.prompt as
          | string
          | ((
              state: WorkflowState,
              input: unknown,
              context?: unknown,
            ) => string),
        maxRetries: config.maxRetries ?? 3,
        timeout: config.timeout,
        condition: config.condition as
          | ((
              state: WorkflowState,
              input: unknown,
            ) => ConditionalResult<any> | boolean)
          | undefined,
        _isParallel: true,
      }));

    // First step is the "coordinator" that holds references to all parallel steps
    const coordinator = parallelSteps[0];
    coordinator._parallelSteps = parallelSteps;

    // Add the coordinator to the workflow
    this.steps.push(coordinator);

    return this as unknown as WorkflowBuilder<
      TState & {
        [K in TParallelSteps[number]["name"]]: StepResult<
          TParallelSteps[number] extends { name: K; tools: infer T }
            ? T extends Record<string, FlowTool>
              ? InferToolResults<T>
              : Record<string, unknown>
            : Record<string, unknown>
        >;
      },
      TInput
    >;
  }

  /**
   * Build and return the workflow
   */
  build() {
    if (this.steps.length === 0) {
      throw new ValidationError("Workflow must have at least one step");
    }

    return {
      steps: this.steps,
      onError: this.errorHandler,
    };
  }

  /**
   * Get the current steps (for debugging/inspection)
   */
  getSteps(): ReadonlyArray<FlowStep<any, any, any, any, any>> {
    return this.steps;
  }

  /**
   * Get step count
   */
  getStepCount(): number {
    return this.steps.length;
  }
}

/**
 * Creates a new workflow builder with full type safety.
 *
 * Each step you add will automatically know about all previous steps' data!
 * Input is passed as second parameter to prompt and condition functions.
 *
 * @example
 * ```ts
 * const searchTool = automatedTool({
 *   handler: async (args: { city: string }) => {
 *     return { hotels: ['Hotel A', 'Hotel B'] };
 *   },
 *   schema: z.object({ city: z.string() })
 * });
 *
 * const confirmTool = userInteractive({
 *   schema: z.object({ hotel: z.string() })
 * });
 *
 * // Specify input type for full type safety
 * const workflow = flow<{ city: string; dates: string }>()
 *   .step('search', {
 *     model: openai('gpt-4'),
 *     tools: { searchHotels: searchTool },
 *     // Access input as second parameter
 *     prompt: (state, input) => `Find hotels in ${input.city} for ${input.dates}`
 *   })
 *   .step('confirm', {
 *     model: openai('gpt-4'),
 *     tools: { confirmBooking: confirmTool },
 *     // TypeScript knows state.search exists and has searchHotels result!
 *     prompt: (state) => {
 *       const hotels = state.search.toolResults.searchHotels;
 *       return `Found ${hotels.hotels.length} hotels. Please confirm.`;
 *     },
 *     // TypeScript validates condition has access to state.search!
 *     condition: (state) => {
 *       if (state.search.toolResults.searchHotels.hotels.length === 0) {
 *         return { skip: true };
 *       }
 *       return { skip: false };
 *     }
 *   })
 *   .build();
 * ```
 */
export function flow<TInput = unknown>(): WorkflowBuilder<{}, TInput> {
  return new WorkflowBuilder<{}, TInput>();
}
