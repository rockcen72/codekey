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
} from '../index.js';

export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private deviceId: string;
  private deviceSecret: string;
  private relayUrl: string;
  private isPairing: boolean;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private pongTimeoutTimer?: ReturnType<typeof setTimeout>;
  private connectionTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private intentionalClose = false;
  private pendingEvents: WsMessage[] = [];
  private pendingRaw: string[] = [];
  private lastEventId: string | null = null;

  /** Expose relay WS connection state for health reporting. */
  get status(): 'connected' | 'connecting' | 'disconnected' {
    if (!this.ws) return 'disconnected';
    switch (this.ws.readyState) {
      case WebSocket.OPEN: return 'connected';
      case WebSocket.CONNECTING: return 'connecting';
      default: return 'disconnected';
    }
  }

  /** Max time to wait for the WS 'open' event before aborting and retrying. */
  private static readonly CONNECT_TIMEOUT_MS = 15_000;

  constructor(deviceId: string, token: string, relayUrl: string, isPairing = false) {
    super();
    this.deviceId = deviceId;
    this.deviceSecret = token;
    this.relayUrl = relayUrl;
    this.isPairing = isPairing;
  }

  connect(): void {
    const url = new URL('/ws', this.relayUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('device_id', this.deviceId);
    if (this.isPairing) {
      url.searchParams.set('device_secret', this.deviceSecret);
    } else {
      url.searchParams.set('token', this.deviceSecret);
    }

    this.intentionalClose = false;
    this.ws = new WebSocket(url.toString());

    this.connectionTimer = setTimeout(() => {
      console.error('[relay-client] connection timeout — aborting and retrying');
      this.intentionalClose = false; // let reconnect fire
      this.clearConnectionTimer();
      this.ws?.close();
    }, RelayClient.CONNECT_TIMEOUT_MS);

    this.ws.on('open', () => {
      this.clearConnectionTimer();
      this.reconnectAttempt = 0;
      this.startHeartbeat();
      this.flushPending();
      this.emit('connected');
    });

    this.ws.on('message', (raw: ArrayBuffer) => {
      try {
        const msg = deserializeMessage(raw);
        if (msg.type === 'pong') {
          this.clearPongTimeout();
          return;
        }
        if (msg.type === 'approval_forward') {
          this.emit('approval_forward', msg.payload);
        }
        if (msg.type === 'event_ack') {
          this.emit('event_ack', msg.payload);
        }
        if (msg.type === 'session_registered') {
          this.emit('session_registered', msg.payload);
        }
        if (msg.type === 'session_deactivated') {
          this.emit('session_deactivated', msg.payload);
        }
        if (msg.type === 'attached_sessions') {
          this.emit('attached_sessions', msg.payload);
        }
        if (msg.type === 'mp_online') {
          this.emit('mp_online');
        }
        if (msg.type === 'mp_offline') {
          this.emit('mp_offline');
        }
        if (msg.type === 'command') {
          this.emit('command', msg.payload);
          return;
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

  /** Send pre-serialized raw JSON string. Queues if WS not yet connected. */
  sendRaw(json: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(json);
    } else {
      this.pendingRaw.push(json);
      if (this.pendingRaw.length > 100) this.pendingRaw.shift();
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
    this.clearPongTimeout();
    this.clearConnectionTimer();
    this.ws?.close();
  }

  /** Force-close and reconnect the WebSocket. The 'close' handler will fire
   *  intentionalClose=false so scheduleReconnect kicks in immediately. */
  reconnect(): void {
    this.clearPongTimeout();
    this.clearConnectionTimer();
    this.intentionalClose = false;
    this.reconnectAttempt = 0;
    this.ws?.close();
  }

  private flushPending(): void {
    for (const raw of this.pendingRaw) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(raw);
      }
    }
    this.pendingRaw = [];
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
      this.restartPongTimeout();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private restartPongTimeout(): void {
    this.clearPongTimeout();
    this.pongTimeoutTimer = setTimeout(() => {
      console.error('[relay-client] pong timeout — closing connection');
      this.intentionalClose = false; // let reconnect fire
      this.ws?.close();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private clearPongTimeout(): void {
    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = undefined;
    }
  }

  private clearConnectionTimer(): void {
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = undefined;
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.clearPongTimeout();
    this.clearConnectionTimer();
  }

  private scheduleReconnect(): void {
    this.clearPongTimeout();
    this.clearConnectionTimer();
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempt++;
    setTimeout(() => this.connect(), delay);
  }
}
