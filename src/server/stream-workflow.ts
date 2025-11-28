import { WorkflowExecutor } from "../core/workflow-executor";
import {
  FlowStep,
  StreamEvent,
  ValidationError,
  WorkflowState,
} from "../types";
import { logger } from "../core/logger";

/** Error handler type for workflow-level errors */
type WorkflowErrorHandler = (
  error: Error,
  stepName: string,
  state: WorkflowState,
) => void | Promise<void>;

export interface StreamWorkflowOptions {
  /**
   * The workflow definition built with flow()
   */
  workflow: {
    steps: FlowStep<any, any, any, any, any>[];
    onError?: WorkflowErrorHandler;
  };

  /**
   * Input data for the workflow
   */
  input: Record<string, unknown>;

  /**
   * Optional: Workflow ID (auto-generated if not provided)
   */
  workflowId?: string;

  /**
   * Optional: Callback when workflow completes
   */
  onFinish?: (result: {
    state: Record<string, unknown>;
    workflowId: string;
  }) => void | Promise<void>;

  /**
   * Optional: Custom headers for the SSE response
   */
  headers?: Record<string, string>;

  /**
   * Optional: Custom text encoder (defaults to UTF-8)
   */
  encoder?: TextEncoder;

  /**
   * Optional: Enable real-time event batching for better performance
   */
  enableBatching?: boolean;

  /**
   * Optional: Batch size when enableBatching is true (defaults to 10)
   */
  batchSize?: number;

  /**
   * Optional: Batch delay in ms when enableBatching is true (defaults to 50)
   */
  batchDelayMs?: number;

  /**
   * Optional: User-provided context passed to execute callbacks
   * (e.g., sandbox instance, database client, API client, etc.)
   */
  executeContext?: unknown;
}

/**
 * Validates workflow input
 */
function validateWorkflowInput(options: StreamWorkflowOptions): void {
  if (!options.workflow) {
    throw new ValidationError("Workflow is required");
  }

  if (!options.workflow.steps || !Array.isArray(options.workflow.steps)) {
    throw new ValidationError("Workflow must have a steps array");
  }

  if (options.workflow.steps.length === 0) {
    throw new ValidationError("Workflow must have at least one step");
  }

  if (!options.input || typeof options.input !== "object") {
    throw new ValidationError("Input must be an object");
  }

  // Validate each step has required fields
  for (let i = 0; i < options.workflow.steps.length; i++) {
    const step = options.workflow.steps[i];

    if (!step.name || typeof step.name !== "string") {
      throw new ValidationError(`Step at index ${i} must have a name`);
    }

    if (!step.model) {
      throw new ValidationError(`Step "${step.name}" must have a model`);
    }

    if (!step.prompt) {
      throw new ValidationError(`Step "${step.name}" must have a prompt`);
    }
  }

  // Validate batching options
  if (options.enableBatching) {
    if (options.batchSize !== undefined && options.batchSize < 1) {
      throw new ValidationError("batchSize must be at least 1");
    }

    if (options.batchDelayMs !== undefined && options.batchDelayMs < 0) {
      throw new ValidationError("batchDelayMs must be non-negative");
    }
  }
}

/**
 * Stream a workflow execution.
 * Returns a WorkflowExecutor that can be used to resume user-interactive tools.
 *
 * @example
 * ```ts
 * const result = streamWorkflow({
 *   workflow: myWorkflow,
 *   input: { city: "Paris", dates: "3/15-3/20" }
 * });
 *
 * return result.toSSEResponse();
 * ```
 */
export function streamWorkflow(options: StreamWorkflowOptions) {
  // Validate input
  validateWorkflowInput(options);

  const {
    workflow,
    input,
    workflowId,
    onFinish,
    headers: customHeaders,
    encoder: customEncoder,
    enableBatching = false,
    batchSize = 10,
    batchDelayMs = 50,
    executeContext,
  } = options;

  const executor = new WorkflowExecutor(
    workflow.steps,
    executeContext,
    workflow.onError,
  );
  const id =
    workflowId || `wf-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const encoder = customEncoder || new TextEncoder();

  // AI SDK 5 pattern: Each request creates a fresh generator
  // No need to persist - state is passed via input
  const createGenerator = (input: Record<string, unknown>) => {
    return executor.stream(input);
  };

  return {
    executor,
    workflowId: id,

    /**
     * Get current workflow state
     */
    getState() {
      return executor.getState();
    },

    /**
     * Resume the workflow with a tool result
     * @param payload - The resume payload containing toolCallId, toolName, result, and stepName
     */
    resume(payload: {
      toolCallId: string;
      toolName?: string;
      result: unknown;
      stepName?: string;
    }) {
      executor.setResumePayload({
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        result: payload.result,
        stepName: payload.stepName || "",
      });
    },

    /**
     * Convert to Server-Sent Events (SSE) Response
     */
    toSSEResponse() {
      const stream = enableBatching
        ? this.createBatchedStream(
            encoder,
            input,
            onFinish,
            id,
            batchSize,
            batchDelayMs,
          )
        : this.createUnbatchedStream(encoder, input, onFinish, id);

      const defaultHeaders = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Workflow-ID": id,
        // Critical: Disable buffering by proxies/servers
        "X-Accel-Buffering": "no",
      };

      return new Response(stream, {
        headers: { ...defaultHeaders, ...customHeaders },
      });
    },

    /**
     * Convert to a data stream (for AI SDK integration)
     */
    toDataStream() {
      return this.createDataStream(input, onFinish, id);
    },

    createUnbatchedStream(
      encoder: TextEncoder,
      input: Record<string, unknown>,
      onFinish: StreamWorkflowOptions["onFinish"],
      workflowId: string,
    ) {
      return new ReadableStream({
        async start(controller) {
          try {
            let finalState: Record<string, unknown> = {};
            const generator = createGenerator(input);

            for await (const event of generator) {
              const sseEvent = `data: ${JSON.stringify(event)}\n\n`;
              controller.enqueue(encoder.encode(sseEvent));

              // Force flush by yielding to event loop (helps with buffering)
              await new Promise((resolve) => setTimeout(resolve, 0));

              if (event.type === "workflow-complete") {
                finalState = event.state;
              }

              // Close stream when waiting for user input (AI SDK 5 pattern)
              // Generator ends here, client will make new request with state
              if (event.type === "tool-pending") {
                logger.debug(
                  `Stream paused for user input on tool: ${event.tool}`,
                );
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return; // End this request - client will resume with new request
              }
            }

            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();

            // Call onFinish callback
            if (onFinish) {
              await onFinish({ state: finalState, workflowId });
            }
          } catch (error) {
            logger.error("Stream error:", error);
            const errorEvent: StreamEvent = {
              type: "error",
              error: error instanceof Error ? error.message : String(error),
              code: error instanceof ValidationError ? error.code : undefined,
              details:
                error instanceof ValidationError ? error.details : undefined,
            };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`),
            );
            controller.close();
          }
        },
      });
    },

    createBatchedStream(
      encoder: TextEncoder,
      input: Record<string, unknown>,
      onFinish: StreamWorkflowOptions["onFinish"],
      workflowId: string,
      batchSize: number,
      batchDelayMs: number,
    ) {
      return new ReadableStream({
        async start(controller) {
          let batchTimeout: ReturnType<typeof setTimeout> | null = null;

          try {
            let finalState: Record<string, unknown> = {};
            let eventBatch: StreamEvent[] = [];

            const flushBatch = () => {
              if (eventBatch.length > 0) {
                for (const event of eventBatch) {
                  try {
                    const sseEvent = `data: ${JSON.stringify(event)}\n\n`;
                    controller.enqueue(encoder.encode(sseEvent));
                  } catch (error) {
                    // Controller may be closed - ignore enqueue errors
                    logger.debug(
                      "Failed to enqueue event (controller closed):",
                      error,
                    );
                  }
                }
                eventBatch = [];
              }
              if (batchTimeout) {
                clearTimeout(batchTimeout);
                batchTimeout = null;
              }
            };

            const generator = createGenerator(input);

            for await (const event of generator) {
              eventBatch.push(event);

              if (event.type === "workflow-complete") {
                finalState = event.state;
              }

              // Flush batch if size reached or on completion/error/pending
              if (
                eventBatch.length >= batchSize ||
                event.type === "workflow-complete" ||
                event.type === "error" ||
                event.type === "tool-pending"
              ) {
                flushBatch();
              } else if (!batchTimeout) {
                // Set timeout to flush batch if no new events
                batchTimeout = setTimeout(() => flushBatch(), batchDelayMs);
              }

              // Close stream when waiting for user input (performance optimization)
              if (event.type === "tool-pending") {
                logger.debug(
                  `Stream paused for user input on tool: ${event.tool}`,
                );
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }
            }

            // Flush any remaining events
            flushBatch();

            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();

            // Call onFinish callback
            if (onFinish) {
              await onFinish({ state: finalState, workflowId });
            }
          } catch (error) {
            logger.error("Batched stream error:", error);
            const errorEvent: StreamEvent = {
              type: "error",
              error: error instanceof Error ? error.message : String(error),
              code: error instanceof ValidationError ? error.code : undefined,
              details:
                error instanceof ValidationError ? error.details : undefined,
            };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`),
            );
            controller.close();
          } finally {
            // Always clear timeout to prevent memory leak
            if (batchTimeout) {
              clearTimeout(batchTimeout);
              batchTimeout = null;
            }
          }
        },
      });
    },

    createDataStream(
      input: Record<string, unknown>,
      onFinish: StreamWorkflowOptions["onFinish"],
      workflowId: string,
    ) {
      return new ReadableStream({
        async start(controller) {
          try {
            let finalState: Record<string, unknown> = {};
            const generator = createGenerator(input);

            for await (const event of generator) {
              // Send event as data stream chunk
              controller.enqueue(event);

              if (event.type === "workflow-complete") {
                finalState = event.state;
              }
            }

            controller.close();

            // Call onFinish callback
            if (onFinish) {
              await onFinish({ state: finalState, workflowId });
            }
          } catch (error) {
            logger.error("Data stream error:", error);
            const errorEvent: StreamEvent = {
              type: "error",
              error: error instanceof Error ? error.message : String(error),
              code: error instanceof ValidationError ? error.code : undefined,
              details:
                error instanceof ValidationError ? error.details : undefined,
            };
            controller.enqueue(errorEvent);
            controller.close();
          }
        },
      });
    },
  };
}
