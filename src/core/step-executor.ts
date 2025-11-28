import {
  streamText,
  type LanguageModel,
  wrapLanguageModel,
  type LanguageModelMiddleware,
  type CoreMessage,
} from "ai";
import {
  FlowStep,
  StreamEvent,
  WorkflowState,
  StepData,
  WorkflowExecutionError,
  StepResult,
  ValidationResult,
} from "../types";
import { ToolManager } from "./tool-manager";
import { logger } from "./logger";
import { ToonSerializer } from "../utils/toon-serializer";
import { z } from "zod";

/**
 * Executes individual workflow steps
 * AI SDK 5 pattern: Use message history to resume, not long-running generators
 */
export class StepExecutor {
  private context: unknown;

  constructor(
    private toolManager: ToolManager,
    context?: unknown,
  ) {
    this.context = context;
  }

  async *execute(
    step: FlowStep<any, any, any, any, any, any>,
    state: WorkflowState,
    input: unknown,
    resumeToolResult?: {
      toolCallId: string;
      toolName: string;
      result: unknown;
    } | null,
  ): AsyncGenerator<StreamEvent> {
    const maxRetries = step.maxRetries ?? 3; // Default to 3 retries
    let lastError: Error | null = null;

    // Retry loop
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Execute the attempt - always use streaming (yield*) approach
        // Timeout is not supported with streaming to avoid buffering
        let result: StepResult = yield* this.executeAttempt(
          step,
          state,
          input,
          attempt,
          resumeToolResult,
        );

        // Apply transform if defined
        if (step.transform && result.toolResults) {
          logger.debug(`Applying transform for step "${step.name}"`);
          result = {
            ...result,
            toolResults: (step.transform as (r: unknown) => unknown)(
              result.toolResults,
            ),
          };
        }

        // Apply validate if defined
        if (step.validate) {
          const validation: ValidationResult = (
            step.validate as (r: unknown) => ValidationResult
          )(result);
          if (!validation.valid) {
            const message = validation.message || "Validation failed";
            logger.debug(
              `Validation failed for step "${step.name}": ${message}`,
            );

            if (validation.retry !== false && attempt < maxRetries) {
              // Retry on validation failure
              yield {
                type: "text-delta",
                step: step.name,
                delta: `\n[Validation failed: ${message}, retrying...]\n`,
                text: `[Validation failed: ${message}]`,
              };
              continue; // Continue to next retry attempt
            }

            throw new WorkflowExecutionError(
              `Step "${step.name}" validation failed: ${message}`,
              { step: step.name, validation },
            );
          }
        }

        return result; // Success - return the step result
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries) {
          logger.debug(
            `Step "${step.name}" failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying...`,
            lastError.message,
          );
          // Yield a retry notification
          yield {
            type: "text-delta",
            step: step.name,
            delta: `\n[Retry ${attempt + 1}/${maxRetries}]\n`,
            text: `[Retry ${attempt + 1}/${maxRetries}]`,
          };
        } else {
          logger.error(
            `Step "${step.name}" failed after ${maxRetries + 1} attempts`,
            lastError,
          );
          throw new WorkflowExecutionError(
            `Step "${step.name}" failed after ${maxRetries + 1} attempts: ${lastError.message}`,
            {
              step: step.name,
              attempts: maxRetries + 1,
              originalError: lastError,
            },
          );
        }
      }
    }

    // Should never reach here due to throw above
    throw lastError!;
  }

  /**
   * Execute attempt and collect events (for timeout support)
   * Can't race async generators directly, so we collect events first
   */
  private async *executeAttempt(
    step: FlowStep<any, any, any, any, any, any>,
    state: WorkflowState,
    input: unknown,
    attempt: number,
    resumeToolResult?: {
      toolCallId: string;
      toolName: string;
      result: unknown;
    } | null,
  ): AsyncGenerator<StreamEvent> {
    const promptText =
      typeof step.prompt === "function"
        ? step.prompt(state, input, this.context)
        : step.prompt;

    // Register tools for this step
    this.toolManager.registerTools(step.name, step.tools);

    let stepOutput = "";
    const toolResults: Record<string, unknown> = {};
    let toolCall:
      | { name: string; args: unknown; toolCallId?: string }
      | undefined = undefined;

    const emittedToolCalls = new Set<string>();
    const emittedToolResults = new Set<string>();
    const inspectorMiddleware: LanguageModelMiddleware = {
      transformParams: async ({ params }) => {
        logger.debug(`[${step.name}] Sending to model:`);
        logger.debug(`[Prompt]:`, JSON.stringify(params.prompt, null, 2));

        if (params.tools && params.tools.length > 0) {
          logger.debug(`[Tools]:`, JSON.stringify(params.tools, null, 2));
        } else {
          logger.debug(`[Tools]: None`);
        }

        return params;
      },
    };
    const monitoredModel = wrapLanguageModel({
      model: step.model as any,
      middleware: inspectorMiddleware,
    });

    // Build the final prompt - include user answers if resuming
    let finalPrompt = promptText;

    if (resumeToolResult) {
      const resumeDataStr = step.useTOON
        ? ToonSerializer.serialize(resumeToolResult.result)
        : JSON.stringify(resumeToolResult.result, null, 2);

      finalPrompt = `${promptText}\n\n---\n\nUser input received for ${resumeToolResult.toolName}:\n${resumeDataStr}\n\nContinue workflow execution with this input.`;

      yield {
        type: "tool-result",
        step: step.name,
        tool: resumeToolResult.toolName,
        result: resumeToolResult.result,
        toolCallId: resumeToolResult.toolCallId,
      };
    }

    const messages: CoreMessage[] = [];

    if (step.useTOON && step.tools && Object.keys(step.tools).length > 0) {
      const toonToolSchemas = ToonSerializer.serializeToolSchemas(step.tools);
      messages.push({
        role: "system" as const,
        content: `${toonToolSchemas}\n\nNote: Tool schemas are in TOON format for efficiency. When calling tools, use the normal JSON format.`,
      });

      const jsonStr = JSON.stringify(step.tools);
      const savings = ToonSerializer.estimateTokenSavings(jsonStr);
      logger.debug(
        `[TOON] Estimated token savings for step "${step.name}": ${savings.saved} tokens (${savings.percentage}%)`,
      );
    }

    messages.push({
      role: "user" as const,
      content: finalPrompt,
    });

    // Get tools with proper typing
    const aiSdkTools = this.toolManager.getAiSdkTools();

    // Configure streaming (AI SDK 5 pattern) - properly typed
    const streamResult = streamText({
      model: monitoredModel as LanguageModel,
      messages,
      tools: aiSdkTools,
    });

    try {
      for await (const chunk of streamResult.fullStream) {
        if (chunk.type === "text-delta") {
          stepOutput += chunk.text;
          yield {
            type: "text-delta",
            step: step.name,
            delta: chunk.text,
            text: stepOutput,
          };
        } else if (chunk.type === "tool-call") {
          const toolName = chunk.toolName;
          const toolCallId = chunk.toolCallId;
          const input = "input" in chunk ? chunk.input : {};

          if (emittedToolCalls.has(toolCallId)) {
            continue;
          }
          emittedToolCalls.add(toolCallId);

          if (this.toolManager.isUserInteractive(toolName)) {
            // User-interactive tool - store and pause (AI SDK 5 pattern)
            logger.debug(
              `User-interactive tool detected: ${toolName}, ID: ${toolCallId}, args:`,
              input,
            );

            yield {
              type: "tool-pending",
              step: step.name,
              tool: toolName,
              args: input,
              toolCallId: toolCallId,
            };

            toolCall = { name: toolName, args: input };

            // PAUSE - return early, client will call continueWithToolResult
            return {
              text: stepOutput.trim(),
              toolResults,
            };
          } else if (this.toolManager.isStreaming(toolName)) {
            // Streaming automated tool - emit tool-call and execute immediately
            yield {
              type: "tool-call",
              step: step.name,
              tool: toolName,
              args: input,
              toolCallId: toolCallId,
            };

            // Store the tool call and break out of fullStream loop to execute it
            toolCall = {
              name: toolName,
              args: input,
              toolCallId: toolCallId,
            };

            // Break out of fullStream - we'll execute the streaming tool now
            break;
          } else {
            // Non-streaming automated tool
            yield {
              type: "tool-call",
              step: step.name,
              tool: toolName,
              args: input,
              toolCallId: toolCallId,
            };
          }
        } else if (chunk.type === "tool-result") {
          const toolName = chunk.toolName;
          const toolCallId = chunk.toolCallId;
          const output = "output" in chunk ? chunk.output : {};

          if (emittedToolResults.has(toolCallId)) {
            continue;
          }
          emittedToolResults.add(toolCallId);

          // Only emit results for automated tools
          if (!this.toolManager.isUserInteractive(toolName)) {
            yield {
              type: "tool-result",
              step: step.name,
              tool: toolName,
              result: output,
              toolCallId: toolCallId,
            };

            toolResults[toolName] = output;
          }
        }
      }

      // If we have a streaming tool, execute it now (we broke out of the loop early)
      // Otherwise, wait for streamResult to complete
      if (toolCall && this.toolManager.isStreaming(toolCall.name)) {
        // Don't await streamResult - execute streaming tool immediately
        const streamingTool = this.toolManager.getStreamingTool(toolCall.name);
        if (streamingTool?.handler) {
          try {
            // Get abort signal from tool manager for cancellation support
            const abortController = this.toolManager.createAbortController();
            const signal = abortController.signal;
            const handlerResult = streamingTool.handler(toolCall.args, {
              signal,
            });

            // Check if it's an async generator (streaming)
            if (
              handlerResult &&
              typeof (handlerResult as any)[Symbol.asyncIterator] === "function"
            ) {
              let accumulatedOutput: any = null;

              // Stream the tool output
              for await (const chunk of handlerResult as AsyncGenerator<
                any,
                any,
                any
              >) {
                // Check if it's a ToolStreamChunk
                if (chunk && typeof chunk === "object" && "delta" in chunk) {
                  // Merge delta into accumulated output
                  if (accumulatedOutput === null) {
                    accumulatedOutput = chunk.delta;
                  } else if (
                    typeof chunk.delta === "string" &&
                    typeof accumulatedOutput === "string"
                  ) {
                    accumulatedOutput += chunk.delta;
                  } else if (
                    typeof chunk.delta === "object" &&
                    typeof accumulatedOutput === "object"
                  ) {
                    accumulatedOutput = {
                      ...accumulatedOutput,
                      ...chunk.delta,
                    };
                  } else {
                    accumulatedOutput = chunk.delta;
                  }

                  yield {
                    type: "tool-output-delta",
                    step: step.name,
                    tool: toolCall.name,
                    toolCallId:
                      (toolCall as any).toolCallId || "streaming-tool",
                    delta: chunk.delta,
                    output: accumulatedOutput,
                  };
                }
              }

              // Get the final return value from the generator
              const finalResult = accumulatedOutput;

              // Emit final tool-result
              yield {
                type: "tool-result",
                step: step.name,
                tool: toolCall.name,
                result: finalResult,
                toolCallId: (toolCall as any).toolCallId || "streaming-tool",
              };

              toolResults[toolCall.name] = finalResult;
            } else {
              // Not actually streaming, just return the promise result
              const result = await handlerResult;

              yield {
                type: "tool-result",
                step: step.name,
                tool: toolCall.name,
                result: result,
                toolCallId: (toolCall as any).toolCallId || "streaming-tool",
              };

              toolResults[toolCall.name] = result;
            }
          } catch (error) {
            logger.error(`Streaming tool "${toolCall.name}" failed:`, error);
            throw error;
          }
        }
      } else {
        // No streaming tool - wait for streamResult to complete normally
        await streamResult;
      }

      return {
        text: stepOutput.trim(),
        toolResults,
      };
    } catch (error) {
      // Re-throw for retry logic to handle
      throw error;
    }
  }
}
