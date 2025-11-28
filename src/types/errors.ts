/**
 * Error types for AgentFlow
 */

export class AgentFlowError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentFlowError";
  }
}

export class WorkflowExecutionError extends AgentFlowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "WORKFLOW_EXECUTION_ERROR", details);
    this.name = "WorkflowExecutionError";
  }
}

export class ToolExecutionError extends AgentFlowError {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly stepName: string,
    details?: Record<string, unknown>,
  ) {
    super(message, "TOOL_EXECUTION_ERROR", { ...details, toolName, stepName });
    this.name = "ToolExecutionError";
  }
}

export class ValidationError extends AgentFlowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", details);
    this.name = "ValidationError";
  }
}

export class ResumeError extends AgentFlowError {
  constructor(
    message: string,
    public readonly toolCallId: string,
  ) {
    super(message, "RESUME_ERROR", { toolCallId });
    this.name = "ResumeError";
  }
}

export class NetworkError extends AgentFlowError {
  constructor(
    message: string,
    public readonly statusCode?: number,
    details?: Record<string, unknown>,
  ) {
    super(message, "NETWORK_ERROR", { ...details, statusCode });
    this.name = "NetworkError";
  }
}
