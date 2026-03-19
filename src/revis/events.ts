/** ACP transcript helpers used for relays and operator-facing status. */

import type { SessionEvent } from "sandbox-agent";

/** Extract text fragments from prompt arrays used by some ACP envelopes. */
function fromPromptArray(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const parts: string[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const text = (item as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) {
      parts.push(text.trim());
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

/** Extract assistant text from incremental session updates. */
function fromSessionUpdate(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const update = value as {
    content?: unknown;
    sessionUpdate?: unknown;
  };

  if (update.sessionUpdate !== "agent_message_chunk") {
    return null;
  }

  const content = update.content;
  if (!content || typeof content !== "object") {
    return null;
  }

  const text = (content as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

/** Extract readable text from one persisted ACP envelope. */
export function extractEventText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return String(payload ?? "");
  }

  const envelope = payload as {
    error?: unknown;
    method?: unknown;
    params?: unknown;
    result?: unknown;
  };

  // Prefer the structured request/update payloads before falling back to raw JSON.
  const params = envelope.params;
  if (params && typeof params === "object") {
    const updateText = fromSessionUpdate((params as { update?: unknown }).update);
    if (typeof updateText === "string") {
      return updateText;
    }

    const text = (params as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) {
      return text.trim();
    }

    const prompt = fromPromptArray((params as { prompt?: unknown }).prompt);
    if (prompt) {
      return prompt;
    }
  }

  const result = envelope.result;
  if (result && typeof result === "object") {
    const text = (result as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) {
      return text.trim();
    }
  }

  if (envelope.error) {
    return JSON.stringify(envelope.error, null, 2);
  }

  if (typeof envelope.method === "string") {
    return envelope.method;
  }

  return JSON.stringify(payload, null, 2);
}

/** Collect the assistant text emitted in one prompt turn. */
export function assistantTurnText(events: readonly SessionEvent[]): string {
  const parts: string[] = [];

  for (const event of events) {
    if (event.sender !== "agent") {
      continue;
    }

    const text = extractEventText(event.payload).trim();
    if (text.length === 0) {
      continue;
    }

    parts.push(text);
  }

  return parts.join("").trim();
}

/** Best-effort question detection for raw transcript events. */
export function questionFromEvent(event: SessionEvent): {
  readonly id: string;
  readonly options: string[];
  readonly prompt: string;
} | null {
  const payload = event.payload as {
    method?: unknown;
    params?: {
      update?: {
        data?: {
          options?: unknown;
          prompt?: unknown;
          question_id?: unknown;
        };
        type?: unknown;
      };
    };
  };

  // The SDK persists this payload as loosely typed JSON, so narrow it inline.
  const update = payload.params?.update;
  if (!update || update.type !== "question.requested") {
    return null;
  }

  const data = update.data;
  if (!data) {
    return null;
  }

  const id = data.question_id;
  const prompt = data.prompt;
  const options = data.options;

  if (typeof id !== "string" || typeof prompt !== "string" || !Array.isArray(options)) {
    return null;
  }

  return {
    id,
    options: options.filter((value): value is string => typeof value === "string"),
    prompt
  };
}

/** Truncate one relay without splitting on empty strings first. */
export function trimForRelay(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
