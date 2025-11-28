/**
 * Message types for AgentFlow
 */

export type MessagePart =
  | { type: "text"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool-output-streaming";
      toolCallId: string;
      toolName: string;
      output: unknown;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      result: unknown;
    }
  | {
      type: "tool-call-pending";
      toolCallId: string;
      toolName: string;
      args: unknown;
    };

// Type guards for MessagePart
export function isTextPart(
  part: MessagePart,
): part is Extract<MessagePart, { type: "text" }> {
  return part.type === "text";
}

export function isToolCallPart(
  part: MessagePart,
): part is Extract<MessagePart, { type: "tool-call" }> {
  return part.type === "tool-call";
}

export function isToolOutputStreamingPart(
  part: MessagePart,
): part is Extract<MessagePart, { type: "tool-output-streaming" }> {
  return part.type === "tool-output-streaming";
}

export function isToolResultPart(
  part: MessagePart,
): part is Extract<MessagePart, { type: "tool-result" }> {
  return part.type === "tool-result";
}

export function isToolCallPendingPart(
  part: MessagePart,
): part is Extract<MessagePart, { type: "tool-call-pending" }> {
  return part.type === "tool-call-pending";
}

export interface Message {
  id: string;
  role: "assistant" | "system";
  parts: MessagePart[];
  step?: string;
  timestamp?: number;

  // Helper properties for pending tools (added by client)
  awaitingUserInput?: boolean;
  toolName?: string;
  toolArgs?: unknown;
}
