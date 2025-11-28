import { z } from "zod";
import {
  UserInteractiveTool,
  AutomatedTool,
  ValidationError,
  ToolHandler,
} from "../types";

/**
 * Marks a tool as requiring user interaction.
 * When this tool is called, the stream will pause and wait for user input.
 *
 * The result type is automatically inferred from the inputSchema!
 *
 * @example
 * ```ts
 * const confirmBooking = userInteractive({
 *   inputSchema: z.object({
 *     hotel: z.string(),
 *     dates: z.string(),
 *     price: z.number()
 *   }),
 *   description: 'Ask user to confirm hotel booking'
 * });
 * // TypeScript knows the result is { hotel: string; dates: string; price: number }
 * ```
 */
export function userInteractive<TSchema extends z.ZodObject<any>>(options: {
  inputSchema?: TSchema;
  outputSchema?: z.ZodTypeAny;
  description?: string;
  /** @deprecated Use inputSchema instead */
  schema?: TSchema;
}): UserInteractiveTool<TSchema, z.infer<TSchema>> {
  // Backward compatibility: schema -> inputSchema
  const inputSchema = options.inputSchema || options.schema;

  if (inputSchema && !(inputSchema instanceof z.ZodObject)) {
    throw new ValidationError(
      "User interactive tool inputSchema must be a ZodObject",
    );
  }

  return {
    type: "user-interactive",
    inputSchema: inputSchema,
    outputSchema: options.outputSchema,
    description: options.description,
    // Keep schema for backward compatibility
    schema: inputSchema,
  };
}

/**
 * Creates an automated tool that executes immediately without user interaction.
 *
 * Type inference works automatically:
 * - If you provide an inputSchema, TArgs is inferred from it
 * - TResult is inferred from the handler's return type
 *
 * @example
 * ```ts
 * // With inputSchema - args type is inferred, result type is inferred from handler
 * const searchHotels = automatedTool({
 *   inputSchema: z.object({
 *     city: z.string(),
 *     dates: z.string()
 *   }),
 *   handler: async (args) => {
 *     // TypeScript knows args is { city: string; dates: string }
 *     const results = await searchAPI(args.city, args.dates);
 *     return { hotels: results }; // Result type is inferred!
 *   },
 *   outputSchema: z.object({
 *     hotels: z.array(z.any())
 *   }),
 *   description: 'Search for hotels in a city'
 * });
 * ```
 */
export function automatedTool<
  TSchema extends z.ZodObject<any>,
  TResult,
>(options: {
  handler: (
    args: z.infer<TSchema>,
    context?: { signal?: AbortSignal },
  ) => Promise<TResult> | AsyncGenerator<any, TResult, any>;
  inputSchema: TSchema;
  outputSchema?: z.ZodTypeAny;
  description?: string;
  /** Enable streaming output (handler must return AsyncGenerator) */
  streaming?: boolean;
  /** Maximum number of retries on failure (default: 0 = no retry) */
  maxRetries?: number;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** @deprecated Use inputSchema instead */
  schema?: TSchema;
}): AutomatedTool<z.infer<TSchema>, TResult, TSchema>;

/**
 * Creates an automated tool without an inputSchema (args will be unknown)
 */
export function automatedTool<TResult>(options: {
  handler: (
    args: unknown,
    context?: { signal?: AbortSignal },
  ) => Promise<TResult> | AsyncGenerator<any, TResult, any>;
  outputSchema?: z.ZodTypeAny;
  description?: string;
  /** Enable streaming output (handler must return AsyncGenerator) */
  streaming?: boolean;
  /** Maximum number of retries on failure (default: 0 = no retry) */
  maxRetries?: number;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
}): AutomatedTool<unknown, TResult, z.ZodObject<any>>;

// Implementation
export function automatedTool<
  TSchema extends z.ZodObject<any> = z.ZodObject<any>,
  TResult = unknown,
>(options: {
  handler: (
    args: any,
    context?: { signal?: AbortSignal },
  ) => Promise<TResult> | AsyncGenerator<any, TResult, any>;
  inputSchema?: TSchema;
  outputSchema?: z.ZodTypeAny;
  description?: string;
  streaming?: boolean;
  maxRetries?: number;
  timeout?: number;
  /** @deprecated Use inputSchema instead */
  schema?: TSchema;
}): AutomatedTool<any, TResult, TSchema> {
  if (!options.handler || typeof options.handler !== "function") {
    throw new ValidationError("Automated tool must have a handler function");
  }

  // Backward compatibility: schema -> inputSchema
  const inputSchema = options.inputSchema || options.schema;

  if (inputSchema && !(inputSchema instanceof z.ZodObject)) {
    throw new ValidationError("Automated tool inputSchema must be a ZodObject");
  }

  return {
    type: "automated" as const,
    handler: options.handler,
    inputSchema: inputSchema,
    outputSchema: options.outputSchema,
    description: options.description,
    streaming: options.streaming,
    maxRetries: options.maxRetries,
    timeout: options.timeout,
    // Keep schema for backward compatibility
    schema: inputSchema,
  };
}
