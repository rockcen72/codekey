/**
 * Maps approval decisions to stdin text.
 * Validates eventId match before allowing writes.
 */

interface PendingApproval {
  eventId: string;
  type: 'approval' | 'question';
}

export class ResponseMapper {
  private pending: PendingApproval | null = null;

  /** Record a pending event that expects a response. */
  setPending(eventId: string, type: 'approval' | 'question'): void {
    this.pending = { eventId, type };
  }

  /** Get the current pending eventId without consuming it. */
  getPending(): PendingApproval | null {
    return this.pending;
  }

  /**
   * Map (eventId, decision, message) → stdin text.
   * Returns null if eventId doesn't match, or the decision is invalid.
   * Only clears pending on a valid mappable decision.
   */
  map(eventId: string, decision: string, message?: string): string | null {
    if (!this.pending || eventId !== this.pending.eventId) return null;

    switch (this.pending.type) {
      case 'approval':
        switch (decision) {
          case 'approve':
            this.pending = null;
            return 'y\n';
          case 'deny':
            this.pending = null;
            return 'n\n';
          default:
            // pause / reply / unknown → do NOT clear pending
            return null;
        }

      case 'question':
        if (decision === 'reply' && message?.trim()) {
          this.pending = null;
          return `${message.trim()}\n`;
        }
        // deny / approve / pause → invalid for questions
        return null;

      default:
        return null;
    }
  }

  /** Clear pending without writing (e.g., on session pause). */
  clear(): void {
    this.pending = null;
  }
}
