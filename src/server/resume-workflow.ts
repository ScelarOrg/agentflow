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
   * The current workflow state
   */
  state: Record<string, unknown>;

  /**
   * The step name where the workflow paused
   */
  stepName: string;

  /**
   * The tool call ID to resume
   */
  toolCallId: string;

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
  const { workflow, state, stepName, toolCallId, result, headers, onFinish } =
    options;

  logger.debug(
    `Resuming workflow at step "${stepName}" with tool result for ${toolCallId}`,
  );

  // AI SDK 5 pattern: Create a NEW workflow execution
  // Pass the state directly without metadata
  const workflowResult = streamWorkflow({
    workflow,
    input: state, // Clean state, no control flow metadata
    headers,
    onFinish,
  });

  // Set the resume payload on the executor with step validation
  workflowResult.executor.setResumePayload({ toolCallId, result, stepName });

  return workflowResult.toSSEResponse();
}
