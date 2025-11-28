/**
 * Tool types for AgentFlow
 */
import { z } from "zod";

export interface ToolHandlerContext {
  /** AbortSignal for cancellation support */
  signal?: AbortSignal;
}

/**
 * Streaming chunk emitted by a streaming tool handler
 */
export interface ToolStreamChunk<TDelta = unknown> {
  /** The delta/chunk of data being streamed */
  delta: TDelta;
}

/**
 * Tool handler can return either:
 * - Promise<TResult> for non-streaming tools
 * - AsyncGenerator<ToolStreamChunk<TDelta>, TResult> for streaming tools
 */
export type ToolHandler<
  TArgs = unknown,
  TResult = unknown,
  TDelta = unknown,
> = (
  args: TArgs,
  context?: ToolHandlerContext,
) =>
  | Promise<TResult>
  | AsyncGenerator<ToolStreamChunk<TDelta>, TResult, undefined>;

/**
 * AI SDK compatible tool definition
 * Based on AI SDK's CoreTool interface
 */
export interface AiSdkTool {
  description?: string;
  inputSchema: z.ZodTypeAny;
  execute?: (args: unknown) => Promise<unknown>;
}

export interface UserInteractiveTool<
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
  TResult = z.infer<TSchema>,
> {
  type: "user-interactive";
  /** Input schema for validation (optional, defaults to empty object) */
  inputSchema?: TSchema;
  /** Output schema for validation (optional) */
  outputSchema?: z.ZodTypeAny;
  description?: string;
  handler?: never;
  _resultType?: TResult; // Phantom type for inference
  /** @deprecated Use inputSchema instead */
  schema?: TSchema;
}

export interface AutomatedTool<
  TArgs = unknown,
  TResult = unknown,
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  type: "automated";
  handler: ToolHandler<TArgs, TResult>;
  /** Input schema for validation (optional, defaults to empty object) */
  inputSchema?: TSchema;
  /** Output schema for validation (optional) */
  outputSchema?: z.ZodTypeAny;
  description?: string;
  /** Enable streaming output (handler must return AsyncGenerator) */
  streaming?: boolean;
  /** Maximum number of retries on failure (default: 0 = no retry) */
  maxRetries?: number;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  _resultType?: TResult; // Phantom type for inference
  /** @deprecated Use inputSchema instead */
  schema?: TSchema;
}

export type FlowTool =
  | UserInteractiveTool<any, any>
  | AutomatedTool<any, any, any>;

// Extract result type from a tool
export type InferToolResult<T> =
  T extends UserInteractiveTool<infer S, any>
    ? z.infer<S>
    : T extends AutomatedTool<any, infer R, any>
      ? R
      : unknown;

// Extract all tool results from a tools object
export type InferToolResults<T extends Record<string, FlowTool>> = {
  [K in keyof T]: InferToolResult<T[K]>;
};

// Extract user confirmation type from tools (finds first user-interactive tool's schema)
export type InferUserConfirmation<T extends Record<string, FlowTool>> = {
  [K in keyof T]: T[K] extends UserInteractiveTool<infer S, any>
    ? z.infer<S>
    : never;
}[keyof T] extends never
  ? undefined
  : {
      [K in keyof T]: T[K] extends UserInteractiveTool<infer S, any>
        ? z.infer<S>
        : never;
    }[keyof T];
