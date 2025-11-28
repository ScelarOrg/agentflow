import {
  FlowTool,
  ToolExecutionError,
  ValidationError,
  AiSdkTool,
  ToolHandlerContext,
  AutomatedTool,
} from "../types";
import { z } from "zod";
import { logger } from "./logger";

const DEFAULT_TOOL_TIMEOUT = 30000; // 30 seconds
const DEFAULT_TOOL_RETRIES = 0; // No retry by default

/**
 * Manages tool registration and execution with timeout, cancellation, and error handling
 */
export class ToolManager {
  private userInteractiveTools = new Set<string>();
  private streamingTools = new Map<string, AutomatedTool<any, any, any>>();
  private aiSdkTools: Record<string, AiSdkTool> = {};
  private toolSchemas = new Map<string, z.ZodTypeAny>();
  private abortController: AbortController | null = null;

  registerTools(stepName: string, tools?: Record<string, FlowTool>): void {
    this.userInteractiveTools.clear();
    this.streamingTools.clear();
    this.aiSdkTools = {};
    this.toolSchemas.clear();

    if (!tools) return;

    for (const [toolName, flowTool] of Object.entries(tools)) {
      // Get input schema with backward compatibility (schema -> inputSchema)
      const inputSchema =
        flowTool.inputSchema || flowTool.schema || z.object({});

      // Store schema for validation
      this.toolSchemas.set(toolName, inputSchema);

      if (flowTool.type === "user-interactive") {
        this.userInteractiveTools.add(toolName);

        // User-interactive tools - don't provide an execute function
        this.aiSdkTools[toolName] = {
          description:
            flowTool.description || `User interactive tool: ${toolName}`,
          inputSchema: inputSchema,
        };
      } else if (flowTool.type === "automated") {
        if (!flowTool.handler) {
          throw new ToolExecutionError(
            `Automated tool "${toolName}" must have a handler`,
            toolName,
            stepName,
          );
        }

        // Store streaming tools separately - they'll be handled by step executor
        // We detect streaming tools by checking if the tool is marked as streaming
        if ((flowTool as any).streaming === true) {
          this.streamingTools.set(toolName, flowTool);

          // Register with AI SDK with a dummy execute that returns immediately
          // This prevents the AI SDK from blocking while waiting for the tool result
          this.aiSdkTools[toolName] = {
            description: flowTool.description || `Streaming tool: ${toolName}`,
            inputSchema: inputSchema,
            execute: async () => {
              // Return immediately - actual execution handled by step executor
              return { __streaming: true };
            },
          };
        } else {
          // Non-streaming automated tool - wrap handler with timeout, retry, and error handling
          this.aiSdkTools[toolName] = {
            description: flowTool.description || `Automated tool: ${toolName}`,
            inputSchema: inputSchema,
            execute: this.wrapHandler(toolName, stepName, flowTool),
          };
        }
      }
    }
  }

  /**
   * Create a new AbortController for this execution
   * Aborts any existing controller before creating a new one
   */
  createAbortController(): AbortController {
    // Abort existing controller if any to prevent orphaned controllers
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    return this.abortController;
  }

  /**
   * Abort all running tools
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Wrap tool handler with timeout, retry, cancellation, and error handling
   */
  private wrapHandler(
    toolName: string,
    stepName: string,
    tool: AutomatedTool<any, any, any>,
  ): (args: unknown) => Promise<unknown> {
    const handler = tool.handler;
    const timeout = tool.timeout ?? DEFAULT_TOOL_TIMEOUT;
    const maxRetries = tool.maxRetries ?? DEFAULT_TOOL_RETRIES;

    return async (args: unknown) => {
      let lastError: Error | null = null;

      // Retry loop
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        // Create abort controller for this specific tool execution if not exists
        const signal = this.abortController?.signal;

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new ToolExecutionError(
                `Tool "${toolName}" timed out after ${timeout}ms`,
                toolName,
                stepName,
                { timeout, args },
              ),
            );
          }, timeout);
        });

        // Create cancellation promise
        const cancellationPromise = signal
          ? new Promise<never>((_, reject) => {
              if (signal.aborted) {
                reject(
                  new ToolExecutionError(
                    `Tool "${toolName}" was cancelled`,
                    toolName,
                    stepName,
                    { cancelled: true, args },
                  ),
                );
              }
              signal.addEventListener("abort", () => {
                reject(
                  new ToolExecutionError(
                    `Tool "${toolName}" was cancelled`,
                    toolName,
                    stepName,
                    { cancelled: true, args },
                  ),
                );
              });
            })
          : null;

        try {
          // Race between handler execution, timeout, and cancellation
          const promises: Promise<unknown>[] = [
            Promise.resolve(handler(args, { signal })),
            timeoutPromise,
          ];
          if (cancellationPromise) {
            promises.push(cancellationPromise);
          }

          const result = await Promise.race(promises);
          return result;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));

          // Don't retry on cancellation
          if (error instanceof ToolExecutionError && error.details?.cancelled) {
            throw error;
          }

          if (attempt < maxRetries) {
            logger.debug(
              `Tool "${toolName}" failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying...`,
              lastError.message,
            );
            continue;
          }

          // Wrap errors with context
          if (error instanceof ToolExecutionError) {
            throw error;
          }

          throw new ToolExecutionError(
            `Tool "${toolName}" execution failed after ${maxRetries + 1} attempts: ${lastError.message}`,
            toolName,
            stepName,
            {
              originalError: lastError.message,
              args,
              attempts: maxRetries + 1,
            },
          );
        } finally {
          // Always clear timeout to prevent memory leak
          if (timeoutId) clearTimeout(timeoutId);
        }
      }

      // Should never reach here
      throw lastError!;
    };
  }

  isUserInteractive(toolName: string): boolean {
    return this.userInteractiveTools.has(toolName);
  }

  isStreaming(toolName: string): boolean {
    return this.streamingTools.has(toolName);
  }

  getStreamingTool(toolName: string): AutomatedTool<any, any, any> | undefined {
    return this.streamingTools.get(toolName);
  }

  getAiSdkTools(): Record<string, AiSdkTool> {
    return this.aiSdkTools;
  }

  getToolNames(): string[] {
    return Object.keys(this.aiSdkTools);
  }

  hasUserInteractiveTools(): boolean {
    return this.userInteractiveTools.size > 0;
  }
}
