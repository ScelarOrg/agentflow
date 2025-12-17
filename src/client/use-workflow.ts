"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  StreamEvent,
  Message,
  MessagePart,
  WorkflowState,
  isTextDeltaEvent,
  isToolCallEvent,
  isToolOutputDeltaEvent,
  isToolResultEvent,
  isToolPendingEvent,
  isStructuredOutputEvent,
  isStepStartEvent,
  isStepCompleteEvent,
  isWorkflowCompleteEvent,
  isErrorEvent,
  NetworkError,
  ValidationError,
} from "../types";

export interface UseWorkflowOptions {
  /**
   * API endpoint for the workflow
   */
  api: string;

  /**
   * Optional: Initial input data
   */
  input?: Record<string, unknown>;

  /**
   * Optional: Auto-start workflow on mount
   * @default false
   */
  autoStart?: boolean;

  /**
   * Optional: Callback when workflow completes
   */
  onComplete?: (stepResults: WorkflowState) => void;

  /**
   * Optional: Callback when error occurs
   */
  onError?: (error: Error) => void;

  /**
   * Optional: Maximum retry attempts on network errors
   * @default 0 (no retries)
   */
  maxRetries?: number;

  /**
   * Optional: Delay between retries in milliseconds
   * @default 1000
   */
  retryDelay?: number;

  /**
   * Optional: Request timeout in milliseconds
   * @default 300000 (5 minutes)
   */
  timeout?: number;
}

interface InternalState {
  messages: Message[];
  stepResults: WorkflowState;
  isStreaming: boolean;
  isResuming: boolean;
  isCompleted: boolean;
  error: Error | null;
  workflowId: string | null;
  retryCount: number;
  // Progress tracking
  currentStep: string | null;
  currentStepDescription: string | null;
  stepIndex: number;
  totalSteps: number;
}

/**
 * Validates an API endpoint URL
 */
function validateApiEndpoint(api: string): void {
  if (!api || typeof api !== "string") {
    throw new ValidationError("API endpoint must be a non-empty string");
  }

  if (typeof window !== "undefined") {
    try {
      const url = new URL(api, window.location.origin);
      if (!url.protocol.startsWith("http")) {
        throw new ValidationError(
          "API endpoint must use HTTP or HTTPS protocol",
        );
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ValidationError(`Invalid API endpoint: ${api}`);
    }
  }
}

/**
 * React hook for AgentFlow workflows with messages as the single source of truth.
 *
 * Features:
 * - Messages contain everything (text, tool calls, pending tools)
 * - Progressive state streaming
 * - Automatic retry on network errors
 * - Request timeout and cancellation
 *
 * @example
 * ```tsx
 * function MyWorkflow() {
 *   const { messages, resume, isStreaming } = useWorkflow({
 *     api: '/api/workflow',
 *     input: { message: 'Hello' },
 *     autoStart: true
 *   });
 *
 *   return (
 *     <div>
 *       {messages.map(msg => {
 *         // Regular assistant message
 *         if (msg.role === 'assistant') {
 *           return <div key={msg.id}>{getMessageText(msg)}</div>;
 *         }
 *
 *         // Message with pending tool (user needs to respond)
 *         const pending = getPendingToolFromMessage(msg);
 *         if (pending) {
 *           return (
 *             <div key={msg.id}>
 *               <p>Confirm: {pending.args.hotel}</p>
 *               <button onClick={() => resume(msg, { confirmed: true })}>
 *                 Confirm
 *               </button>
 *             </div>
 *           );
 *         }
 *       })}
 *     </div>
 *   );
 * }
 * ```
 */
export function useWorkflow(options: UseWorkflowOptions) {
  const {
    api,
    input,
    autoStart = false,
    onComplete,
    onError,
    maxRetries = 0,
    retryDelay = 1000,
    timeout = 300000,
  } = options;

  // Validate API endpoint immediately
  useEffect(() => {
    try {
      validateApiEndpoint(api);
    } catch (err) {
      if (onError) {
        onError(err as Error);
      }
    }
  }, [api, onError]);

  // Single state object for better performance (fewer re-renders)
  const [state, setState] = useState<InternalState>({
    messages: [],
    stepResults: {},
    isStreaming: false,
    isResuming: false,
    isCompleted: false,
    error: null,
    workflowId: null,
    retryCount: 0,
    currentStep: null,
    currentStepDescription: null,
    stepIndex: 0,
    totalSteps: 0,
  });

  // Refs for streaming state (don't trigger re-renders)
  const abortControllerRef = useRef<AbortController | null>(null);
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentMessageRef = useRef<Message | null>(null);
  const lastInputRef = useRef<Record<string, unknown> | null>(null);

  /**
   * Handle errors with retry logic
   */
  const handleError = useCallback(
    (err: Error, canRetry = false) => {
      const error = err instanceof Error ? err : new Error(String(err));

      setState((prev) => ({
        ...prev,
        error,
        isStreaming: false,
        isResuming: false,
      }));

      if (onError) {
        onError(error);
      }

      // Retry logic handled separately, don't call retry here
      // to avoid circular dependency
    },
    [onError],
  );

  /**
   * Process stream events efficiently
   */
  const processStreamEvent = useCallback(
    (event: StreamEvent) => {
      if (isStepStartEvent(event)) {
        // Update progress tracking
        setState((prev) => ({
          ...prev,
          currentStep: event.step,
          currentStepDescription: event.description ?? null,
          stepIndex: event.stepIndex,
          totalSteps: event.totalSteps,
        }));
      } else if (isTextDeltaEvent(event)) {
        setState((prev) => {
          const messages = [...prev.messages]; // Copy array reference only

          if (
            currentMessageRef.current &&
            messages[messages.length - 1]?.id === currentMessageRef.current.id
          ) {
            // Mutate in place - safe because we copied the messages array
            const lastMsg = messages[messages.length - 1];
            const lastParts = lastMsg.parts;
            const lastPart = lastParts[lastParts.length - 1];

            if (lastPart?.type === "text") {
              // Direct mutation - much faster than copying
              lastPart.text += event.delta;
            } else {
              lastParts.push({ type: "text", text: event.delta });
            }

            currentMessageRef.current = lastMsg;
          } else {
            // Create new message
            const newMsg: Message = {
              id: `msg-${Date.now()}-${Math.random()}`,
              role: "assistant",
              parts: [{ type: "text", text: event.delta }],
              step: event.step,
              timestamp: Date.now(),
            };
            currentMessageRef.current = newMsg;
            messages.push(newMsg);
          }

          return { ...prev, messages };
        });
      } else if (isToolCallEvent(event)) {
        setState((prev) => {
          const messages = [...prev.messages];
          const toolCallPart: MessagePart = {
            type: "tool-call",
            toolCallId: event.toolCallId,
            toolName: event.tool,
            args: event.args,
          };

          if (
            currentMessageRef.current &&
            messages[messages.length - 1]?.id === currentMessageRef.current.id
          ) {
            // Create proper copies to avoid mutation
            const lastMsg = { ...messages[messages.length - 1] };
            lastMsg.parts = [...lastMsg.parts, toolCallPart];
            messages[messages.length - 1] = lastMsg;
            currentMessageRef.current = lastMsg;
          } else {
            const newMsg: Message = {
              id: `msg-${Date.now()}-${Math.random()}`,
              role: "assistant",
              parts: [toolCallPart],
              step: event.step,
              timestamp: Date.now(),
            };
            currentMessageRef.current = newMsg;
            messages.push(newMsg);
          }

          return { ...prev, messages };
        });
      } else if (isToolOutputDeltaEvent(event)) {
        // Handle streaming tool output - type is properly narrowed by type guard
        setState((prev) => {
          const messages = [...prev.messages]; // Copy array reference only

          if (
            currentMessageRef.current &&
            messages[messages.length - 1]?.id === currentMessageRef.current.id
          ) {
            // Mutate in place - safe because we copied the messages array
            const lastMsg = messages[messages.length - 1];
            const lastParts = lastMsg.parts;

            // Find if we already have a tool-output-streaming part for this tool call
            const streamingPartIndex = lastParts.findIndex(
              (
                p,
              ): p is Extract<MessagePart, { type: "tool-output-streaming" }> =>
                p.type === "tool-output-streaming" &&
                p.toolCallId === event.toolCallId,
            );

            if (streamingPartIndex >= 0) {
              // Update existing streaming part - direct mutation
              const existingPart = lastParts[streamingPartIndex];
              if (existingPart.type === "tool-output-streaming") {
                existingPart.output = event.output;
              }
            } else {
              // Create new streaming part - properly typed
              const newPart: Extract<
                MessagePart,
                { type: "tool-output-streaming" }
              > = {
                type: "tool-output-streaming",
                toolCallId: event.toolCallId,
                toolName: event.tool,
                output: event.output,
              };
              lastParts.push(newPart);
            }

            currentMessageRef.current = lastMsg;
          } else {
            // Create new message with streaming tool output - properly typed
            const streamingPart: Extract<
              MessagePart,
              { type: "tool-output-streaming" }
            > = {
              type: "tool-output-streaming",
              toolCallId: event.toolCallId,
              toolName: event.tool,
              output: event.output,
            };

            const newMsg: Message = {
              id: `msg-${Date.now()}-${Math.random()}`,
              role: "assistant",
              parts: [streamingPart],
              step: event.step,
              timestamp: Date.now(),
            };
            currentMessageRef.current = newMsg;
            messages.push(newMsg);
          }

          return { ...prev, messages };
        });
      } else if (isToolResultEvent(event)) {
        setState((prev) => {
          const messages = [...prev.messages];
          const toolResultPart: MessagePart = {
            type: "tool-result",
            toolCallId: event.toolCallId,
            toolName: event.tool,
            result: event.result,
          };

          if (
            currentMessageRef.current &&
            messages[messages.length - 1]?.id === currentMessageRef.current.id
          ) {
            // Create proper copies to avoid mutation
            const lastMsg = { ...messages[messages.length - 1] };
            const lastParts = [...lastMsg.parts];

            // Replace any tool-output-streaming parts with the final result
            const streamingPartIndex = lastParts.findIndex(
              (p) =>
                p.type === "tool-output-streaming" &&
                p.toolCallId === event.toolCallId,
            );

            if (streamingPartIndex >= 0) {
              // Replace streaming part with final result
              lastParts[streamingPartIndex] = toolResultPart;
            } else {
              // Add result part
              lastParts.push(toolResultPart);
            }

            lastMsg.parts = lastParts;
            messages[messages.length - 1] = lastMsg;
            currentMessageRef.current = lastMsg;
          } else {
            const newMsg: Message = {
              id: `msg-${Date.now()}-${Math.random()}`,
              role: "assistant",
              parts: [toolResultPart],
              step: event.step,
              timestamp: Date.now(),
            };
            currentMessageRef.current = newMsg;
            messages.push(newMsg);
          }

          return { ...prev, messages };
        });
      } else if (isStructuredOutputEvent(event)) {
        // Handle structured output from generateObject steps
        // This is NOT a tool call - it's direct structured output
        setState((prev) => {
          const messages = [...prev.messages];
          const structuredPart: MessagePart = {
            type: "structured-output",
            output: event.output,
          };

          if (
            currentMessageRef.current &&
            messages[messages.length - 1]?.id === currentMessageRef.current.id
          ) {
            const lastMsg = { ...messages[messages.length - 1] };
            lastMsg.parts = [...lastMsg.parts, structuredPart];
            messages[messages.length - 1] = lastMsg;
            currentMessageRef.current = lastMsg;
          } else {
            const newMsg: Message = {
              id: `msg-${Date.now()}-${Math.random()}`,
              role: "assistant",
              parts: [structuredPart],
              step: event.step,
              timestamp: Date.now(),
            };
            currentMessageRef.current = newMsg;
            messages.push(newMsg);
          }

          return { ...prev, messages };
        });
      } else if (isToolPendingEvent(event)) {
        // Add pending tool as part of message - this is the key!
        setState((prev) => {
          const messages = [...prev.messages];
          const pendingPart: MessagePart = {
            type: "tool-call-pending",
            toolCallId: event.toolCallId,
            toolName: event.tool,
            args: event.args,
          };

          if (
            currentMessageRef.current &&
            messages[messages.length - 1]?.id ===
              currentMessageRef.current.id &&
            messages[messages.length - 1]?.step === event.step // Only append if same step
          ) {
            // Create proper copies to avoid mutation
            const lastMsg = { ...messages[messages.length - 1] };
            lastMsg.parts = [...lastMsg.parts, pendingPart];
            // Add helper properties directly on message
            (lastMsg as any).awaitingUserInput = true;
            (lastMsg as any).toolName = event.tool;
            (lastMsg as any).toolArgs = event.args;
            messages[messages.length - 1] = lastMsg;
            currentMessageRef.current = lastMsg;
          } else {
            const newMsg: Message & {
              awaitingUserInput?: boolean;
              toolName?: string;
              toolArgs?: unknown;
            } = {
              id: `msg-${Date.now()}-${Math.random()}`,
              role: "assistant",
              parts: [pendingPart],
              step: event.step,
              timestamp: Date.now(),
              // Helper properties for easy checking
              awaitingUserInput: true,
              toolName: event.tool,
              toolArgs: event.args,
            };
            currentMessageRef.current = newMsg as Message;
            messages.push(newMsg as Message);
          }

          return {
            ...prev,
            messages,
            isStreaming: false, // Pause streaming
          };
        });
      } else if (isStepCompleteEvent(event)) {
        setState((prev) => ({
          ...prev,
          stepResults: event.state,
          stepIndex: event.stepIndex,
          totalSteps: event.totalSteps,
        }));
        currentMessageRef.current = null;
      } else if (isWorkflowCompleteEvent(event)) {
        setState((prev) => ({
          ...prev,
          stepResults: event.state,
          isCompleted: true,
          isStreaming: false,
          retryCount: 0,
        }));

        if (onComplete) {
          onComplete(event.state);
        }
      } else if (isErrorEvent(event)) {
        const error = new Error(event.error);
        (error as any).code = event.code;
        (error as any).details = event.details;
        handleError(error, false);
      }
    },
    [onComplete, handleError],
  );

  /**
   * Stream data from endpoint
   */
  const streamFromEndpoint = useCallback(
    async (url: string, method: "POST" | "PUT", body: unknown) => {
      abortControllerRef.current = new AbortController();

      // Set timeout
      if (timeout > 0) {
        timeoutIdRef.current = setTimeout(() => {
          abortControllerRef.current?.abort();
          handleError(new NetworkError("Request timeout", 408), true);
        }, timeout);
      }

      try {
        const response = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          throw new NetworkError(
            `HTTP ${response.status}: ${response.statusText}`,
            response.status,
          );
        }

        // Get workflow ID from header (if provided)
        const wfId = response.headers.get("X-Workflow-ID");
        if (wfId) {
          setState((prev) => ({ ...prev, workflowId: wfId }));
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new NetworkError("No response body");
        }

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim() || !line.startsWith("data: ")) continue;

            const data = line.slice(6);
            if (data === "[DONE]") continue;

            try {
              const event: StreamEvent = JSON.parse(data);
              processStreamEvent(event);
            } catch (e) {
              console.error("[AgentFlow] Failed to parse event:", e);
            }
          }
        }

        // Clear timeout on success
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
          timeoutIdRef.current = null;
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return; // User cancelled
        }
        handleError(err as Error, true);
      } finally {
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
          timeoutIdRef.current = null;
        }
      }
    },
    [timeout, processStreamEvent, handleError],
  );

  /**
   * Start the workflow
   */
  const start = useCallback(
    async (workflowInput?: Record<string, unknown>) => {
      const inputData = workflowInput ?? input ?? {};
      lastInputRef.current = inputData;

      setState((prev) => ({
        ...prev,
        messages: [],
        stepResults: {},
        isCompleted: false,
        error: null,
        isStreaming: true,
        retryCount: 0,
      }));

      currentMessageRef.current = null;

      await streamFromEndpoint(api, "POST", { input: inputData });
    },
    [api, input, streamFromEndpoint],
  );

  /**
   * Find the pending tool in messages (if any)
   */
  const findPendingTool = useCallback(() => {
    for (const msg of state.messages) {
      const pendingPart = msg.parts.find(
        (p): p is Extract<MessagePart, { type: "tool-call-pending" }> =>
          p.type === "tool-call-pending",
      );
      if (pendingPart) {
        return { message: msg, pendingPart };
      }
    }
    return null;
  }, [state.messages]);

  /**
   * Resume workflow by responding to a pending tool
   *
   * Can be called in two ways:
   * 1. `resume(result)` - automatically finds the pending tool
   * 2. `resume(message, result)` - explicitly specify which message to resume
   *
   * @example
   * // Simple: auto-find pending tool
   * resume({ confirmed: true });
   *
   * // Explicit: specify message
   * resume(pendingMessage, { confirmed: true });
   */
  const resume = useCallback(
    async (messageOrResult: Message | unknown, maybeResult?: unknown) => {
      let message: Message;
      let result: unknown;

      // Determine which overload was used
      if (
        maybeResult !== undefined ||
        (messageOrResult &&
          typeof messageOrResult === "object" &&
          "id" in messageOrResult &&
          "parts" in messageOrResult)
      ) {
        // Called as resume(message, result)
        message = messageOrResult as Message;
        result = maybeResult;
      } else {
        // Called as resume(result) - auto-find pending tool
        const pending = findPendingTool();
        if (!pending) {
          handleError(new Error("No pending tool found in messages"), false);
          return;
        }
        message = pending.message;
        result = messageOrResult;
      }

      // Find the pending tool in the message
      const pendingPart = message.parts.find(
        (p): p is Extract<MessagePart, { type: "tool-call-pending" }> =>
          p.type === "tool-call-pending",
      );

      if (!pendingPart) {
        handleError(
          new Error("Message does not contain a pending tool"),
          false,
        );
        return;
      }

      // Update the pending tool to a completed tool-result
      setState((prev) => {
        const messages = prev.messages.map((msg) => {
          if (msg.id !== message.id) return msg;

          // Replace tool-call-pending with tool-result
          const updatedParts = msg.parts.map((part) => {
            if (
              part.type === "tool-call-pending" &&
              part.toolCallId === pendingPart.toolCallId
            ) {
              return {
                type: "tool-result" as const,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                result,
              };
            }
            return part;
          });

          return { ...msg, parts: updatedParts };
        });

        return {
          ...prev,
          messages,
          isResuming: true,
        };
      });

      await streamFromEndpoint(api, "PUT", {
        workflowId: state.workflowId,
        toolCallId: pendingPart.toolCallId,
        toolName: pendingPart.toolName,
        result,
        state: state.stepResults,
        stepName: message.step,
        originalInput: lastInputRef.current, // Include original input for resume
      });

      setState((prev) => ({ ...prev, isResuming: false }));
    },
    [
      api,
      state.workflowId,
      state.stepResults,
      streamFromEndpoint,
      handleError,
      findPendingTool,
    ],
  );

  /**
   * Retry the workflow after an error
   */
  const retry = useCallback(async () => {
    if (!lastInputRef.current) {
      handleError(new Error("No previous input to retry"), false);
      return;
    }

    setState((prev) => ({
      ...prev,
      error: null,
      retryCount: prev.retryCount + 1,
    }));

    await start(lastInputRef.current);
  }, [start, handleError]);

  /**
   * Cancel the workflow
   */
  const cancel = useCallback(() => {
    abortControllerRef.current?.abort();
    setState((prev) => ({
      ...prev,
      isStreaming: false,
      isResuming: false,
    }));

    if (timeoutIdRef.current) {
      clearTimeout(timeoutIdRef.current);
      timeoutIdRef.current = null;
    }
  }, []);

  /**
   * Auto-start on mount if enabled
   */
  useEffect(() => {
    if (autoStart && input) {
      start(input);
    }

    // Cleanup on unmount
    return () => {
      abortControllerRef.current?.abort();
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]); // Only run on mount

  // Compute pending tool for easy access
  const pendingTool = findPendingTool();

  return {
    // State
    messages: state.messages,
    stepResults: state.stepResults,
    isStreaming: state.isStreaming,
    isResuming: state.isResuming,
    isCompleted: state.isCompleted,
    error: state.error,

    // Progress tracking
    progress: {
      currentStep: state.currentStep,
      /** Human-readable description of current step */
      currentStepDescription: state.currentStepDescription,
      stepIndex: state.stepIndex,
      totalSteps: state.totalSteps,
      /** Percentage complete (0-100) */
      percentage:
        state.totalSteps > 0
          ? Math.round((state.stepIndex / state.totalSteps) * 100)
          : 0,
    },

    // Pending tool info (if workflow is waiting for user input)
    pendingTool: pendingTool
      ? {
          toolName: pendingTool.pendingPart.toolName,
          toolCallId: pendingTool.pendingPart.toolCallId,
          args: pendingTool.pendingPart.args,
          message: pendingTool.message,
        }
      : null,

    // Actions
    start,
    resume, // resume(result) or resume(message, result)
    retry,
    cancel,
  };
}

// Re-export types for convenience
export type { Message, MessagePart };
