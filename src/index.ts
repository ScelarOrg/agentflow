// Core workflow builder
export { flow, WorkflowBuilder } from "./core/workflow-builder";
export { userInteractive, automatedTool } from "./core/user-interactive";
export { WorkflowExecutor } from "./core/workflow-executor";

// Re-export LanguageModel type from AI SDK for convenience
export type { LanguageModel } from "ai";

// Server SDK (use in API routes)
export { streamWorkflow, resumeWorkflow } from "./server";
export type { StreamWorkflowOptions } from "./server";

// Client SDK (use in React components)
export { useWorkflow } from "./client";
export type { UseWorkflowOptions, Message, MessagePart } from "./client";

// Types
export type {
  FlowStep,
  FlowTool,
  WorkflowState,
  StreamEvent,
  PendingToolCall,
  ResumePayload,
  UserInteractiveTool,
  AutomatedTool,
  ConditionalResult,
  StepResult,
  StepData,
  ToolHandler,
  ToolHandlerContext,
} from "./types";

// Type guards
export {
  isTextPart,
  isToolCallPart,
  isToolOutputStreamingPart,
  isToolResultPart,
  isToolCallPendingPart,
  isTextDeltaEvent,
  isToolCallEvent,
  isToolPendingEvent,
  isToolOutputDeltaEvent,
  isToolResultEvent,
  isStepStartEvent,
  isStepCompleteEvent,
  isWorkflowCompleteEvent,
  isErrorEvent,
} from "./types";

// Error classes
export {
  AgentFlowError,
  WorkflowExecutionError,
  ToolExecutionError,
  ValidationError,
  ResumeError,
  NetworkError,
} from "./types";

// Validation schemas
export {
  ResumePayloadSchema,
  WorkflowInputSchema,
  StreamConfigSchema,
} from "./types";

// Logger (for configuring debug output)
export { logger } from "./core/logger";

// TOON serialization utilities (for token optimization)
export { ToonSerializer } from "./utils/toon-serializer";
