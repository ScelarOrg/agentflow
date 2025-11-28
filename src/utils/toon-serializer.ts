/**
 * TOON (Token-Oriented Object Notation) Serializer
 * Reduces AI token usage by ~40% for uniform data structures
 *
 * Use cases:
 * 1. Tool schemas sent to LLM (biggest impact)
 * 2. Workflow state in resume scenarios
 * 3. Arrays of uniform objects in prompts
 */

import { encode } from "@toon-format/toon";

/**
 * Serializes data to TOON format for reduced token usage
 */
export class ToonSerializer {
  /**
   * Convert tool schemas to TOON format
   * This is the biggest win - tool schemas are sent on every step
   */
  static serializeToolSchemas(tools: Record<string, any>): string {
    try {
      // Convert AI SDK tool format to TOON
      const toolData = Object.entries(tools).map(([name, tool]) => ({
        name,
        description: tool.description || "",
        // Serialize parameters schema as JSON string for now
        // TOON works best with uniform objects, not complex schemas
        parameters: JSON.stringify(tool.parameters || {}),
      }));

      const toonOutput = encode(toolData);
      return `Tools available (TOON format):\n${toonOutput}`;
    } catch (error) {
      // Fallback to JSON if TOON fails
      return `Tools available (JSON fallback):\n${JSON.stringify(tools, null, 2)}`;
    }
  }

  /**
   * Convert workflow state to TOON format for resume scenarios
   * State typically contains uniform StepResult objects
   */
  static serializeWorkflowState(state: Record<string, any>): string {
    try {
      // Extract step results into a uniform array
      const stateArray = Object.entries(state).map(([stepName, stepData]) => ({
        step: stepName,
        text: stepData.text || "",
        hasToolResults: Object.keys(stepData.toolResults || {}).length > 0,
        toolResultKeys: Object.keys(stepData.toolResults || {}).join(","),
      }));

      const toonOutput = encode(stateArray);
      return `Workflow State (TOON format):\n${toonOutput}`;
    } catch (error) {
      // Fallback to JSON if TOON fails
      return `Workflow State (JSON fallback):\n${JSON.stringify(state, null, 2)}`;
    }
  }

  /**
   * Generic TOON serialization for any uniform data
   * Use this for arrays of objects with consistent structure
   */
  static serialize(data: any): string {
    try {
      if (Array.isArray(data)) {
        return encode(data);
      }

      // Convert object to array format for TOON
      if (typeof data === "object" && data !== null) {
        const dataArray = Object.entries(data).map(([key, value]) => ({
          key,
          value:
            typeof value === "object" ? JSON.stringify(value) : String(value),
        }));
        return encode(dataArray);
      }

      // Fallback for primitives
      return String(data);
    } catch (error) {
      // Fallback to JSON
      return JSON.stringify(data, null, 2);
    }
  }

  /**
   * Format tool results as TOON for embedding in prompts
   * This is useful when passing previous step results to next steps
   */
  static serializeToolResults(toolResults: Record<string, any>): string {
    try {
      // Check if any tool result is an array of uniform objects
      for (const [toolName, result] of Object.entries(toolResults)) {
        if (Array.isArray(result) && result.length > 0) {
          // Check if objects have consistent keys
          const firstKeys = Object.keys(result[0] || {});
          const isUniform = result.every(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              Object.keys(item).length === firstKeys.length,
          );

          if (isUniform) {
            const toonArray = encode(result);
            return `${toolName} results (TOON format):\n${toonArray}`;
          }
        }
      }

      // Fallback to JSON for non-uniform data
      return JSON.stringify(toolResults, null, 2);
    } catch (error) {
      return JSON.stringify(toolResults, null, 2);
    }
  }

  /**
   * Calculate estimated token savings
   * TOON typically saves ~40% tokens for uniform data
   */
  static estimateTokenSavings(originalJson: string): {
    original: number;
    toon: number;
    saved: number;
    percentage: number;
  } {
    // Simple token estimation: ~4 chars per token
    const originalTokens = Math.ceil(originalJson.length / 4);
    const estimatedToonTokens = Math.ceil(originalTokens * 0.6); // ~40% reduction
    const saved = originalTokens - estimatedToonTokens;
    const percentage = Math.round((saved / originalTokens) * 100);

    return {
      original: originalTokens,
      toon: estimatedToonTokens,
      saved,
      percentage,
    };
  }
}
