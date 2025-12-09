import { streamWorkflow, type StreamWorkflowOptions } from "./stream-workflow";
import { logger } from "../core/logger";

/**
 * Resume a paused workflow
 * AI SDK 5 pattern: Make a NEW request with the tool result in the state
 */
export function resumeWorkflow(options: {
  /**
   * The workflow definition
   */
  workflow: StreamWorkflowOptions["workflow"];

  /**
   * The current workflow state (accumulated step results)
   */
  state: Record<string, unknown>;

  /**
   * The original input that started the workflow
   */
  originalInput?: Record<string, unknown>;

  /**
   * The step name where the workflow paused
   */
  stepName: string;

  /**
   * The tool call ID to resume
   */
  toolCallId: string;

  /**
   * The name of the tool being resumed
   */
  toolName?: string;

  /**
   * The result from the user interaction
   */
  result: unknown;

  /**
   * Optional: Custom headers for the SSE response
   */
  headers?: Record<string, string>;

  /**
   * Optional: onFinish callback
   */
  onFinish?: StreamWorkflowOptions["onFinish"];
}) {
  const {
    workflow,
    state,
    originalInput,
    stepName,
    toolCallId,
    toolName,
    result,
    headers,
    onFinish,
  } = options;

  logger.debug(
    `Resuming workflow at step "${stepName}" with tool result for ${toolCallId}`,
  );

  // AI SDK 5 pattern: Create a NEW workflow execution
  // Use originalInput if provided, otherwise fall back to state for backwards compatibility
  const workflowResult = streamWorkflow({
    workflow,
    input: originalInput ?? state,
    headers,
    onFinish,
  });

  // Set the resume payload on the executor with step validation
  // Also pass the accumulated state so it can be restored
  workflowResult.executor.setResumePayload({
    toolCallId,
    toolName,
    result,
    stepName,
    previousState: state,
  });

  return workflowResult.toSSEResponse();
}
