/** A streamed update surfaced to the chat UI. */
export type AssistantStreamEvent = { type: "text"; text: string };

/** Thrown by {@link AssistantSession.stream} until a real backend is wired up. */
export class AssistantNotImplementedError extends Error {
  constructor(message = "The AI Assistant is not connected to a model backend yet.") {
    super(message);
    this.name = "AssistantNotImplementedError";
  }
}

interface AssistantTurnRecord {
  role: "user" | "assistant";
  text: string;
}

/**
 * A long-lived chat session holding conversation history across {@link stream}
 * calls. `stream` is currently a placeholder: it records the prompt and always
 * throws {@link AssistantNotImplementedError} rather than fabricating a reply.
 * Replace its body with a real request to a model backend when one exists —
 * the history/abort plumbing and the async-generator shape are already the
 * seam a streaming implementation needs, so the panel's send/cancel/clear
 * logic won't need to change again.
 */
export class AssistantSession {
  private history: AssistantTurnRecord[] = [];
  private controller: AbortController | null = null;

  /** Cancel the in-flight request, if any. */
  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /** Drop conversation history and cancel any in-flight request. */
  reset(): void {
    this.cancel();
    this.history = [];
  }

  /**
   * Send a user prompt and stream back events. Placeholder implementation:
   * records the prompt in history, then throws before yielding anything.
   *
   * @param prompt The user's natural-language request.
   * @yields {@link AssistantStreamEvent} updates once a real backend exists.
   */
  async *stream(prompt: string): AsyncGenerator<AssistantStreamEvent> {
    this.history.push({ role: "user", text: prompt });
    this.controller = new AbortController();
    throw new AssistantNotImplementedError();
  }
}
