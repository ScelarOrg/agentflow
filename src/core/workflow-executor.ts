import {
  FlowStep,
  StreamEvent,
  WorkflowState,
  ResumePayload,
  ConditionalResult,
  WorkflowExecutionError,
  StepResult,
  ExecuteContext,
} from "../types";
import { ToolManager } from "./tool-manager";
import { StepExecutor } from "./step-executor";
import { logger } from "./logger";
import { WorkflowErrorHandler } from "./workflow-builder";

/**
 * Executes a workflow by processing steps sequentially or in parallel
 * AI SDK 5 pattern: Each request is independent, state passed via input
 */
export class WorkflowExecutor {
  private steps: FlowStep<any, any, any, any, any, any>[];
  private state: WorkflowState = {};
  private input: unknown = null;
  private resumePayload: ResumePayload | null = null;
  private executeContext: unknown = null;
  private onErrorHandler?: WorkflowErrorHandler;
  private completedSteps: Set<string> = new Set();
  private stepIndexMap: Map<string, number>; // O(1) step lookup for goto

  constructor(
    steps: FlowStep<any, any, any, any, any, any>[],
    executeContext?: unknown,
    onErrorHandler?: WorkflowErrorHandler,
  ) {
    if (!steps || steps.length === 0) {
      throw new WorkflowExecutionError("Workflow must have at least one step");
    }

    this.steps = steps;
    this.executeContext = executeContext;
    this.onErrorHandler = onErrorHandler;

    // Build step index map for O(1) lookups in goto statements
    this.stepIndexMap = new Map(steps.map((s, i) => [s.name, i]));
  }

  /**
   * Set user-provided context for execute callbacks (e.g., sandbox, DB client, etc.)
   */
  setExecuteContext(context: unknown): void {
    this.executeContext = context;
  }

  /**
   * Set resume payload (AI SDK 5 pattern: new request with tool result)
   */
  setResumePayload(payload: ResumePayload): void {
    this.resumePayload = payload;
  }

  /**
   * Execute the workflow and stream events.
   * AI SDK 5 pattern: Each execution is a fresh request
   */
  async *stream(input: unknown): AsyncGenerator<StreamEvent> {
    // Store input for access in prompts/conditions
    this.input = input;

    // If resuming with previous state, restore it; otherwise start fresh
    if (this.resumePayload?.previousState) {
      this.state = { ...this.resumePayload.previousState } as WorkflowState;
      // Mark completed steps based on state keys
      this.completedSteps = new Set(Object.keys(this.state));
    } else {
      this.state = {};
      this.completedSteps = new Set();
    }

    // If we have a resume payload, we do NOT mark the step as completed
    // The step will be re-executed with the user's tool result, allowing the LLM
    // to call additional tools (e.g., after questionnaire, call specDocument)

    let currentStepName = "";

    try {
      // Check if we should use DAG execution
      if (this.usesDagExecution()) {
        yield* this.streamDag();
        return;
      }

      // Sequential execution (original behavior)
      // Track actual step number for progress (not loop index, which skips completed steps)
      let executedStepNumber = this.completedSteps.size;

      for (
        let currentIndex = 0;
        currentIndex < this.steps.length;
        currentIndex++
      ) {
        const step = this.steps[currentIndex];
        currentStepName = step.name;

        // Skip already completed steps (important for resume)
        // But don't skip the step we're resuming on
        if (
          this.completedSteps.has(step.name) &&
          this.resumePayload?.stepName !== step.name
        ) {
          logger.debug(`Skipping already completed step: ${step.name}`);
          continue;
        }

        // Increment executed step counter
        executedStepNumber++;

        // Evaluate step condition
        const conditionResult = this.evaluateCondition(step);

        // Calculate progress info
        const totalSteps = this.steps.length;
        const stepIndex = executedStepNumber; // Use actual executed step number

        if (conditionResult.skip) {
          yield* this.handleSkippedStep(
            step,
            conditionResult,
            stepIndex,
            totalSteps,
          );
          this.completedSteps.add(step.name);
          continue;
        }

        // Execute step(s)

        if (step._parallelSteps && step._parallelSteps.length > 1) {
          yield* this.executeParallelSteps(
            step._parallelSteps,
            stepIndex,
            totalSteps,
          );
          for (const pStep of step._parallelSteps) {
            this.completedSteps.add(pStep.name);
          }
        } else {
          const paused = yield* this.executeSingleStep(
            step,
            stepIndex,
            totalSteps,
          );

          // If paused for user input, stop here
          // Client will make a NEW request with tool result
          if (paused) {
            logger.debug(`Paused at step: ${step.name}`);
            return;
          }
          this.completedSteps.add(step.name);
        }

        // Handle goto if specified
        if (conditionResult.goto) {
          currentIndex = this.findStepIndex(conditionResult.goto) - 1;
        }
      }

      yield {
        type: "workflow-complete",
        state: this.state,
        totalSteps: this.steps.length,
      };
    } catch (error) {
      // Call onError handler if provided
      if (this.onErrorHandler) {
        try {
          await this.onErrorHandler(
            error instanceof Error ? error : new Error(String(error)),
            currentStepName,
            this.state,
          );
        } catch (handlerError) {
          logger.error("onError handler threw:", handlerError);
        }
      }

      const errorEvent: StreamEvent = {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof WorkflowExecutionError ? error.code : undefined,
        details:
          error instanceof WorkflowExecutionError ? error.details : undefined,
      };
      yield errorEvent;
      throw error;
    }
  }

  private evaluateCondition(step: FlowStep<any, any, any, any, any, any>): {
    skip: boolean;
    goto?: string;
    data?: unknown;
  } {
    if (!step.condition) {
      return { skip: false };
    }

    const conditionResult = step.condition(this.state, this.input);

    if (typeof conditionResult === "boolean") {
      return { skip: !conditionResult };
    }

    if (conditionResult.skip) {
      return {
        skip: true,
        data: "data" in conditionResult ? conditionResult.data : undefined,
      };
    }

    return {
      skip: false,
      goto: "goto" in conditionResult ? conditionResult.goto : undefined,
    };
  }

  private async *handleSkippedStep(
    step: FlowStep<any, any, any, any, any, any>,
    conditionResult: { skip: boolean; data?: unknown },
    stepIndex: number,
    totalSteps: number,
  ): AsyncGenerator<StreamEvent> {
    if (conditionResult.data !== undefined) {
      yield {
        type: "step-start",
        step: step.name,
        description: step.description,
        stepIndex,
        totalSteps,
      };

      this.state[step.name] = {
        text: "",
        toolResults: conditionResult.data as Record<string, unknown>,
      };

      yield {
        type: "step-complete",
        step: step.name,
        state: this.state,
        stepIndex,
        totalSteps,
      };
    }
  }

  /**
   * Execute a single step, returns true if paused
   */
  private async *executeSingleStep(
    step: FlowStep<any, any, any, any, any, any>,
    stepIndex: number,
    totalSteps: number,
  ): AsyncGenerator<StreamEvent, boolean> {
    yield {
      type: "step-start",
      step: step.name,
      description: step.description,
      stepIndex,
      totalSteps,
    };

    // Check if this step is being resumed with a user-interactive tool result
    // We need to RE-EXECUTE the step so the LLM can continue with additional tools
    let resumeToolResult: {
      toolCallId: string;
      toolName: string;
      result: unknown;
    } | null = null;
    if (this.resumePayload && this.resumePayload.stepName === step.name) {
      resumeToolResult = {
        toolCallId: this.resumePayload.toolCallId,
        toolName: this.resumePayload.toolName || "user-input",
        result: this.resumePayload.result,
      };
      // Clear the resume payload so we don't process it again
      this.resumePayload = null;
    }

    // Create isolated ToolManager and StepExecutor for this step (fixes parallel execution bug)
    const toolManager = new ToolManager();
    const stepExecutor = new StepExecutor(toolManager, this.executeContext);

    const stepResultGen = stepExecutor.execute(
      step,
      this.state,
      this.input,
      resumeToolResult,
    );
    let finalResult: StepResult | undefined;
    let paused = false;

    while (true) {
      const { value, done } = await stepResultGen.next();

      if (done) {
        finalResult = value as StepResult;
        break;
      }

      const event = value as StreamEvent;

      // Check if pausing for user input
      if (event.type === "tool-pending") {
        yield event;
        paused = true;
        break;
      }

      yield event;
    }

    // Store result and call execute callback if provided
    if (finalResult && !paused) {
      this.state[step.name] = finalResult;

      // Call execute callback if provided
      if (step.execute) {
        try {
          await step.execute(this.state[step.name], {
            context: this.executeContext,
            state: this.state,
            stepName: step.name,
          });
        } catch (error) {
          logger.error(
            `Execute callback failed for step "${step.name}":`,
            error,
          );
          throw error;
        }
      }

      yield {
        type: "step-complete",
        step: step.name,
        state: this.state,
        stepIndex,
        totalSteps,
      };
    }

    return paused;
  }

  private async *executeParallelSteps(
    steps: FlowStep<any, any, any, any, any, any>[],
    stepIndex: number,
    totalSteps: number,
  ): AsyncGenerator<StreamEvent> {
    for (const step of steps) {
      yield {
        type: "step-start",
        step: step.name,
        description: step.description,
        stepIndex,
        totalSteps,
      };
    }

    const stepPromises = steps.map(async (step) => {
      const events: StreamEvent[] = [];

      // Create isolated ToolManager and StepExecutor for each parallel step
      const toolManager = new ToolManager();
      const stepExecutor = new StepExecutor(toolManager, this.executeContext);

      const generator = stepExecutor.execute(step, this.state, this.input);

      let stepResult: StepResult | undefined;

      // Properly consume generator and capture return value (fixes generator exhaustion bug)
      while (true) {
        const { value, done } = await generator.next();

        if (done) {
          // done=true means this is the return value, not a yielded event
          stepResult = value as StepResult;
          break;
        }

        // done=false means this is a yielded event
        events.push(value as StreamEvent);
      }

      return { stepName: step.name, events, result: stepResult };
    });

    const results = await Promise.all(stepPromises);

    for (const { stepName, events, result } of results) {
      for (const event of events) {
        yield event;
      }

      if (result) {
        this.state[stepName] = result;
      }
    }

    for (const step of steps) {
      yield {
        type: "step-complete",
        step: step.name,
        state: this.state,
        stepIndex,
        totalSteps,
      };
    }
  }

  private findStepIndex(stepName: string): number {
    const index = this.stepIndexMap.get(stepName);
    if (index === undefined) {
      throw new WorkflowExecutionError(
        `Goto target step "${stepName}" not found in workflow`,
        { stepName },
      );
    }
    return index;
  }

  /**
   * Execute workflow using DAG-based scheduling
   * Steps run as soon as their dependencies are satisfied
   */
  private async *streamDag(): AsyncGenerator<StreamEvent> {
    // Validate DAG structure
    this.validateDag();

    const totalSteps = this.steps.length;
    let executedCount = 0;

    while (this.completedSteps.size < this.steps.length) {
      const readySteps = this.getReadySteps();

      if (readySteps.length === 0) {
        // No steps ready but not all completed - shouldn't happen after validation
        throw new WorkflowExecutionError(
          "DAG execution stuck: no steps ready but workflow not complete",
          { completed: Array.from(this.completedSteps) },
        );
      }

      // Execute ready steps in parallel if multiple are ready
      if (readySteps.length > 1) {
        // Multiple steps ready - run in parallel
        yield* this.executeDagParallel(readySteps, executedCount, totalSteps);
        for (const step of readySteps) {
          this.completedSteps.add(step.name);
        }
        executedCount += readySteps.length;
      } else {
        // Single step ready - run sequentially
        const step = readySteps[0];
        executedCount++;

        // Evaluate condition
        const conditionResult = this.evaluateCondition(step);

        if (conditionResult.skip) {
          yield* this.handleSkippedStep(
            step,
            conditionResult,
            executedCount,
            totalSteps,
          );
          this.completedSteps.add(step.name);
          continue;
        }

        const paused = yield* this.executeSingleStep(
          step,
          executedCount,
          totalSteps,
        );

        if (paused) {
          logger.debug(`DAG execution paused at step: ${step.name}`);
          return;
        }

        this.completedSteps.add(step.name);
      }
    }

    yield {
      type: "workflow-complete",
      state: this.state,
      totalSteps,
    };
  }

  /**
   * Execute multiple DAG steps in parallel
   */
  private async *executeDagParallel(
    steps: FlowStep<any, any, any, any, any, any>[],
    startIndex: number,
    totalSteps: number,
  ): AsyncGenerator<StreamEvent> {
    // Emit step-start for all
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      yield {
        type: "step-start",
        step: step.name,
        description: step.description,
        stepIndex: startIndex + i + 1,
        totalSteps,
      };
    }

    // Execute all in parallel
    const stepPromises = steps.map(async (step) => {
      const events: StreamEvent[] = [];

      const toolManager = new ToolManager();
      const stepExecutor = new StepExecutor(toolManager, this.executeContext);
      const generator = stepExecutor.execute(step, this.state, this.input);

      let stepResult: StepResult | undefined;

      while (true) {
        const { value, done } = await generator.next();
        if (done) {
          stepResult = value as StepResult;
          break;
        }
        events.push(value as StreamEvent);
      }

      return { step, events, result: stepResult };
    });

    const results = await Promise.all(stepPromises);

    // Yield events and store results
    for (let i = 0; i < results.length; i++) {
      const { step, events, result } = results[i];

      for (const event of events) {
        yield event;
      }

      if (result) {
        this.state[step.name] = result;

        // Call execute callback if provided
        if (step.execute) {
          try {
            await step.execute(this.state[step.name], {
              context: this.executeContext,
              state: this.state,
              stepName: step.name,
            });
          } catch (error) {
            logger.error(
              `Execute callback failed for step "${step.name}":`,
              error,
            );
            throw error;
          }
        }
      }

      yield {
        type: "step-complete",
        step: step.name,
        state: this.state,
        stepIndex: startIndex + i + 1,
        totalSteps,
      };
    }
  }

  /**
   * Check if workflow uses DAG execution (any step has dependsOn)
   */
  private usesDagExecution(): boolean {
    return this.steps.some(
      (step) => step.dependsOn && step.dependsOn.length > 0,
    );
  }

  /**
   * Check if all dependencies for a step are satisfied
   */
  private areDependenciesSatisfied(
    step: FlowStep<any, any, any, any, any, any>,
  ): boolean {
    if (!step.dependsOn || step.dependsOn.length === 0) {
      return true;
    }
    return step.dependsOn.every((dep) => this.completedSteps.has(dep));
  }

  /**
   * Get steps that are ready to execute (dependencies satisfied, not yet completed)
   */
  private getReadySteps(): FlowStep<any, any, any, any, any, any>[] {
    return this.steps.filter(
      (step) =>
        !this.completedSteps.has(step.name) &&
        this.areDependenciesSatisfied(step),
    );
  }

  /**
   * Validate DAG has no cycles and all dependencies exist
   */
  private validateDag(): void {
    const stepNames = new Set(this.steps.map((s) => s.name));
    // Build step map for O(1) lookups instead of O(n) find
    const stepMap = new Map(this.steps.map((s) => [s.name, s]));

    for (const step of this.steps) {
      if (step.dependsOn) {
        for (const dep of step.dependsOn) {
          if (!stepNames.has(dep)) {
            throw new WorkflowExecutionError(
              `Step "${step.name}" depends on unknown step "${dep}"`,
              { step: step.name, dependency: dep },
            );
          }
          if (dep === step.name) {
            throw new WorkflowExecutionError(
              `Step "${step.name}" cannot depend on itself`,
              { step: step.name },
            );
          }
        }
      }
    }

    // Check for cycles using DFS
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const hasCycle = (stepName: string): boolean => {
      visited.add(stepName);
      recursionStack.add(stepName);

      const step = stepMap.get(stepName); // O(1) lookup instead of O(n) find
      if (step?.dependsOn) {
        for (const dep of step.dependsOn) {
          if (!visited.has(dep)) {
            if (hasCycle(dep)) return true;
          } else if (recursionStack.has(dep)) {
            return true;
          }
        }
      }

      recursionStack.delete(stepName);
      return false;
    };

    for (const step of this.steps) {
      if (!visited.has(step.name) && hasCycle(step.name)) {
        throw new WorkflowExecutionError(
          "Workflow contains a dependency cycle",
          { step: step.name },
        );
      }
    }
  }

  getState(): Readonly<WorkflowState> {
    return { ...this.state };
  }
}
