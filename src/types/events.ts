/**
 * Stream event types for AgentFlow
 */
import { WorkflowState } from "./state";

export type StreamEvent =
  | {
      type: "text-delta";
      step?: string;
      delta: string;
      text: string;
    }
  | {
      type: "tool-call";
      step: string;
      tool: string;
      args: unknown;
      toolCallId: string;
    }
  | {
      type: "tool-pending";
      step: string;
      tool: string;
      args: unknown;
      toolCallId: string;
    }
  | {
      type: "tool-output-delta";
      step: string;
      tool: string;
      toolCallId: string;
      delta: unknown;
      /** Accumulated output so far */
      output: unknown;
    }
  | {
      type: "tool-result";
      step: string;
      tool: string;
      result: unknown;
      toolCallId: string;
    }
  | {
      type: "structured-output";
      step: string;
      /** The structured output data */
      output: unknown;
    }
  | {
      type: "step-start";
      step: string;
      /** Optional step description */
      description?: string;
      /** Current step index (1-based) */
      stepIndex: number;
      /** Total number of steps in workflow */
      totalSteps: number;
    }
  | {
      type: "step-complete";
      step: string;
      state: WorkflowState;
      /** Current step index (1-based) */
      stepIndex: number;
      /** Total number of steps in workflow */
      totalSteps: number;
    }
  | {
      type: "workflow-complete";
      state: WorkflowState;
      /** Total number of steps completed */
      totalSteps: number;
    }
  | {
      type: "error";
      error: string;
      code?: string;
      details?: Record<string, unknown>;
    };

// Type guards for StreamEvent
export function isTextDeltaEvent(
  event: StreamEvent,
): event is Extract<StreamEvent, { type: "text-delta" }> {
  return event.type === "text-delta";
}

export function isToolCallEvent(
  event: StreamEvent,
): event is Extract<StreamEvent, { type: "tool-call" }> {
  return event.type === "tool-call";
}

export function isToolPendingEvent(
  event: StreamEvent,
): event is Extract<StreamEvent, { type: "tool-pending" }> {
  return event.type === "tool-pending";
}

export function isToolOutputDeltaEvent(
  event: StreamEvent,
): event is Extract<StreamEvent, { type: "tool-output-delta" }> {
  return event.type === "tool-output-delta";
}

export function isToolResultEvent(
  event: StreamEvent,
): event is Extract<StreamEvent, { type: "tool-result" }> {
  return event.type === "tool-result";
}

export function isStructuredOutputEvent(
  event: StreamEvent,
): event is Extract<StreamEvent, { type: "structured-output" }> {
  return event.type === "structured-output";
}

export function isStepStartEvent(
  event: StreamEvent,
): event is Extract<StreamEvent, { type: "step-start" }> {
  return event.type === "step-start";
}

export function isStepCompleteEvent(
  event: StreamEvent,
): event is Extract<StreamEvent, { type: "step-complete" }> {
  return event.type === "step-complete";
}

export function isWorkflowCompleteEvent(
  event: StreamEvent,
): event is Extract<StreamEvent, { type: "workflow-complete" }> {
  return event.type === "workflow-complete";
}

export function isErrorEvent(
  event: StreamEvent,
): event is Extract<StreamEvent, { type: "error" }> {
  return event.type === "error";
}

/**
 * Pending Tool Call Types
 */
export interface PendingToolCall {
  toolCallId: string;
  tool: string;
  args: unknown;
  step: string;
}

/**
 * Stream Result Types
 */
export interface WorkflowStreamResult {
  text: string;
  pendingTool: PendingToolCall | null;
  state: WorkflowState;
  completed: boolean;
  error: string | null;
}

/**
 * Resume Payload Types
 */
export interface ResumePayload {
  toolCallId: string;
  toolName?: string; // Name of the tool being resumed
  result: unknown;
  stepName: string; // Added for step validation
  previousState?: Record<string, unknown>; // Accumulated state from previous steps
}
