import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  type WsMessage,
  type DeviceInfo,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  serializeMessage,
  deserializeMessage,
  createPing,
} from '@devtap/shared';

export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private deviceId: string;
  private deviceSecret: string;
  private relayUrl: string;
  private isPairing: boolean;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectAttempt = 0;
  private intentionalClose = false;
  private pendingEvents: WsMessage[] = [];
  private lastEventId: string | null = null;

  constructor(deviceId: string, token: string, relayUrl: string, isPairing = false) {
    super();
    this.deviceId = deviceId;
    this.deviceSecret = token;
    this.relayUrl = relayUrl;
    this.isPairing = isPairing;
  }

  connect(): void {
    const url = new URL('/ws', this.relayUrl);
    url.protocol = url.protocol === 'https:' || url.protocol === 'http:' ? 'wss:' : 'ws:';
    url.searchParams.set('device_id', this.deviceId);
    if (this.isPairing) {
      url.searchParams.set('device_secret', this.deviceSecret);
    } else {
      url.searchParams.set('token', this.deviceSecret);
    }

    this.intentionalClose = false;
    this.ws = new WebSocket(url.toString());

    this.ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.startHeartbeat();
      this.flushPending();
      this.emit('connected');
    });

    this.ws.on('message', (raw: ArrayBuffer) => {
      try {
        const msg = deserializeMessage(raw);
        if (msg.type === 'pong') return;
        if (msg.type === 'approval_forward') {
          this.emit('approval_forward', msg.payload);
        }
        if (msg.type === 'event_ack') {
          this.emit('event_ack', msg.payload);
        }
        if (msg.type === 'session_registered') {
          this.emit('session_registered', msg.payload);
        }
      } catch {
        // drop malformed messages silently
      }
    });

    this.ws.on('close', () => {
      this.stopHeartbeat();
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', () => {
      // close event will fire after this
    });
  }

  /** Wait until WebSocket is in OPEN state. */
  waitForConnection(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve();
      } else {
        this.once('connected', resolve);
      }
    });
  }

  /** Send serialized WS message (heartbeat). */
  private send(msg: WsMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(serializeMessage(msg));
    }
  }

  /** Send pre-serialized raw JSON string.
   *  NOTE: Unlike sendEvent, sendRaw does NOT buffer messages.
   *  Only call after WS is open — use waitForConnection() first.
   */
  sendRaw(json: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(json);
    }
  }

  sendEvent(sessionId: string, msg: WsMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(serializeMessage(msg));
    } else {
      this.pendingEvents.push(msg);
      if (this.pendingEvents.length > 100) this.pendingEvents.shift();
    }
  }

  close(): void {
    this.intentionalClose = true;
    this.ws?.close();
  }

  private flushPending(): void {
    if (this.pendingEvents.length === 0) return;
    for (const msg of this.pendingEvents) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(serializeMessage(msg));
      }
    }
    this.pendingEvents = [];
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.send(createPing());
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempt++;
    setTimeout(() => this.connect(), delay);
  }
}
