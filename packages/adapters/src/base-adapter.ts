import { EventEmitter } from 'node:events';
import type { AgentEventPayload, AgentType } from '@codekey/shared';

export interface AdapterOptions {
  cwd?: string;
}

export abstract class BaseAdapter extends EventEmitter {
  abstract readonly agentType: AgentType;
  protected options: AdapterOptions;

  constructor(options: AdapterOptions = {}) {
    super();
    this.options = options;
  }

  abstract processOutput(line: string): void;

  abstract processExit(code: number | null): void;

  protected emitEvent(event: AgentEventPayload): void {
    this.emit('agent_event', event);
  }
}
