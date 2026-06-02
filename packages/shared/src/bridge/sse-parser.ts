/**
 * Simple SSE (Server-Sent Events) stream parser.
 * Buffers partial chunks and emits complete events.
 */
export interface SSEEvent {
  type: string;
  properties: Record<string, unknown>;
}

export function createEventStreamParser() {
  let buffer = '';

  return {
    /** Feed raw SSE data and return any completed events. */
    feed(chunk: string): SSEEvent[] {
      buffer += chunk;

      // SSE events are separated by double newlines
      const parts = buffer.split('\n\n');
      // The last element may be incomplete — keep it in buffer
      buffer = parts.pop() ?? '';

      const events: SSEEvent[] = [];

      for (const block of parts) {
        const parsed = parseSSEBlock(block);
        if (parsed) events.push(parsed);
      }

      return events;
    },
  };
}

function parseSSEBlock(block: string): SSEEvent | null {
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  let eventType = '';
  let data = '';

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data = line.slice(5).trim();
    }
  }

  if (!eventType || !data) return null;

  let properties: Record<string, unknown> = {};
  try {
    properties = JSON.parse(data);
  } catch {
    // If data isn't JSON, wrap as text
    properties = { text: data };
  }

  return { type: eventType, properties };
}
