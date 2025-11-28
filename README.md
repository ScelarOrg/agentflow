# AgentFlow

[![npm version](https://img.shields.io/npm/v/agent-flow.svg)](https://www.npmjs.com/package/agent-flow)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Structured, type-safe AI workflows for the Vercel AI SDK.**

AgentFlow brings order to complex LLM interactions. It allows you to chain prompts, handle dependencies (DAGs), run steps in parallel, and pause for human input—all while maintaining 100% TypeScript type safety from the first step to the last.

It is built on top of Vercel AI SDK 5, preserving the ability to stream text and tool calls directly to the client.

## Why AgentFlow?

Orchestrating multi-step agents often leads to "spaghetti code" full of race conditions and untyped state. AgentFlow solves this by:

*   **Enforcing Type Safety:** The output of `step A` is typed and available in the context of `step B`.
*   **Human-in-the-Loop:** Native support for pausing execution to wait for user confirmation or input, then resuming exactly where it left off.
*   **Control Flow:** Define conditional branching, loops, and retries using simple configuration objects.
*   **React Integration:** A drop-in hook that handles the complexities of streaming structured steps and tool calls.

## Installation

```bash
npm install @scelar/agentflow ai zod
```

## Core Concepts

### 1. Define the Workflow

The `flow` builder creates a directed acyclic graph (DAG). TypeScript infers the state shape automatically as you add steps.

```typescript
import { flow, automatedTool, userInteractive } from 'agent-flow';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

// 1. Define Tools
const searchHotels = automatedTool({
  description: 'Search for hotels in a city',
  inputSchema: z.object({ city: z.string(), dates: z.string() }),
  handler: async ({ city, dates }) => {
    return await db.hotels.find({ city, dates }); // Returns typed array
  },
});

const confirmBooking = userInteractive({
  description: 'Ask user to confirm booking details',
  inputSchema: z.object({ hotelId: z.string(), confirmed: z.boolean() }),
});

// 2. Build Workflow
export const bookingWorkflow = flow<{ city: string; dates: string }>()
  // Step 1: AI searches for data
  .step('search', {
    model: openai('gpt-4'),
    tools: { searchHotels },
    prompt: (state, input) => `Find hotels in ${input.city} for ${input.dates}`
  })
  // Step 2: AI processes results and asks user for confirmation
  .step('confirm', {
    model: openai('gpt-4'),
    tools: { confirmBooking },
    prompt: (state) => {
      // 'state.search' is fully typed here based on the previous step
      const count = state.search.toolResults.searchHotels.length;
      return `Found ${count} hotels. Ask the user to confirm one.`;
    }
  })
  .build();
```

### 2. Server-Side Execution (Next.js App Router)

AgentFlow manages the streaming response and state serialization.

```typescript
// app/api/workflow/route.ts
import { streamWorkflow, resumeWorkflow } from 'agent-flow/server';
import { bookingWorkflow } from './workflow';

export async function POST(req: Request) {
  const { input } = await req.json();
  
  // Starts the workflow and streams SSE events to the client
  return streamWorkflow({
    workflow: bookingWorkflow,
    input,
    onFinish: async ({ state }) => console.log('Flow complete:', state)
  }).toSSEResponse();
}

export async function PUT(req: Request) {
  const payload = await req.json();
  
  // Resumes a paused workflow from a user-interactive tool
  return resumeWorkflow({
    workflow: bookingWorkflow,
    ...payload // Contains state, stepName, toolCallId, and user result
  });
}
```

### 3. Client-Side Consumption

Use the `useWorkflow` hook to consume the stream, render messages, and handle interruptions (user inputs).

```tsx
'use client';
import { useWorkflow } from 'agent-flow/client';

export default function BookingAgent() {
  const { 
    messages, 
    isStreaming, 
    pendingTool, // specific state for when workflow pauses for human
    resume, 
    start 
  } = useWorkflow({ api: '/api/workflow' });

  return (
    <div className="chat-layout">
      {messages.map(m => <MessageBubble key={m.id} message={m} />)}

      {/* Workflow paused: waiting for human input */}
      {pendingTool?.name === 'confirmBooking' && (
        <div className="approval-ui">
          <p>Book hotel: {pendingTool.args.hotelId}?</p>
          <button onClick={() => resume({ confirmed: true, hotelId: pendingTool.args.hotelId })}>
            Approve
          </button>
          <button onClick={() => resume({ confirmed: false, hotelId: pendingTool.args.hotelId })}>
            Reject
          </button>
        </div>
      )}

      {!isStreaming && !pendingTool && (
        <button onClick={() => start({ city: 'NY', dates: 'tomorrow' })}>
          Find Hotels
        </button>
      )}
    </div>
  );
}
```

## Advanced Patterns

### Parallel Execution
Execute independent steps concurrently to reduce latency. The state merges once all parallel steps complete.

```typescript
const flow = flow()
  .parallel([
    {
      name: 'research',
      model: openai('gpt-4'),
      prompt: 'Research topic A...'
    },
    {
      name: 'analysis',
      model: openai('gpt-4'),
      prompt: 'Analyze topic B...'
    }
  ])
  .step('summary', {
    model: openai('gpt-4'),
    prompt: (state) => 
      // Access results from both branches
      `Synthesize: ${state.research.text} and ${state.analysis.text}`
  });
```

### Conditional Logic & Branching
Skip steps or jump backwards (loops) based on tool outputs or state.

```typescript
.step('validate_data', {
  model: openai('gpt-4'),
  condition: (state) => {
    if (state.prevStep.toolResults.hasError) {
      return { goto: 'correction_step' }; // Jump to specific step
    }
    if (state.prevStep.confidence < 0.5) {
      return { skip: true }; // Skip this step
    }
    return { skip: false }; // Continue normally
  },
  // ... step config
})
```

### Dependency Management (DAG)
For complex flows where step C needs data from A, but not B.

```typescript
.step('A', { ... })
.step('B', { ... })
.step('C', { 
  dependsOn: ['A'], // Waits for A, ignores B
  prompt: (state) => `Process ${state.A.result}` 
})
```

### Streaming Tool Outputs
If a tool generates a large amount of text (e.g., a search report), you can stream it back to the client in real-time rather than waiting for the tool to finish.

```typescript
const reportTool = automatedTool({
  inputSchema: z.object({ topic: z.string() }),
  streaming: true, 
  handler: async function* (args) {
    // Yield chunks as they are generated
    for (const chunk of generateLongReport(args.topic)) {
      yield { delta: chunk }; 
    }
    return { complete: true };
  }
});
```

## Configuration & Optimization

### TOON Format
AgentFlow includes an optional "TOON" serializer. This optimizes JSON payloads for token efficiency, reducing token usage by approximately 40% for large state objects.

```typescript
.step('heavy_step', {
  useTOON: true,
  model: openai('gpt-4'),
  // ...
})
```

### Error Handling
Define global error handlers to capture failures, log to observability services, or trigger specific cleanup logic.

```typescript
const workflow = flow()
  .onError((error, stepName, state) => {
    Sentry.captureException(error, { tags: { step: stepName } });
  })
  // ... steps
```

## License
MIT
