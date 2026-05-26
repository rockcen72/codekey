export class ScreenBuffer {
  private buffer = '';

  /** Feed raw text, extract complete lines. Incomplete trailing line is kept in buffer. */
  feed(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // Last element may be incomplete — keep in buffer
    this.buffer = lines.pop() ?? '';
    // Filter empty lines
    return lines.filter((l) => l.length > 0);
  }

  get pending(): string {
    return this.buffer;
  }

  clear(): void {
    this.buffer = '';
  }
}
