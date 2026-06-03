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

  /** Track whether the current connect() attempt should use query-token fallback. */
  private _headerAuthAttempted = false;

  /** Track whether we already retried with query token after a header auth failure. */
  private _queryFallbackRetried = false;

  connect(): void {
    const url = new URL('/ws', this.relayUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('device_id', this.deviceId);
    if (this.isPairing) {
      url.searchParams.set('device_secret', this.deviceSecret);
    } else if (this._queryFallbackRetried) {
      // Already tried header auth and failed — use query token as fallback.
      url.searchParams.set('token', this.deviceSecret);
    }

    this.intentionalClose = false;
    // Per-host TLS bypass. Empty env = strict verification (default).
    // Populated by extension.ts from CODEKEY_INSECURE_TLS_HOSTS.
    const insecureHosts = (process.env.CODEKEY_INSECURE_TLS_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    const skipVerify = insecureHosts.includes(url.hostname);

    // Build WS options. We send the auth token via the Authorization header
    // (Node `ws` supports it via the second-arg options) instead of the
    // query string, so the token never lands in access logs or referer
    // headers. The server also accepts the legacy ?token= form while the
    // mini program migrates (wx.connectSocket cannot set headers until
    // a baseline 2.x is widely deployed) and older PC clients catch up.
    const wsOptions: any = {};
    if (skipVerify) wsOptions.rejectUnauthorized = false;
    if (!this.isPairing && this.deviceSecret) {
      wsOptions.headers = { Authorization: `Bearer ${this.deviceSecret}` };
      // Legacy fallback: if the server doesn't support header auth (pre-B2),
      // the WS connection will close immediately. Retry once with the token
      // in the query string. Remove after 2026-08-01 (transition window).
      this._headerAuthAttempted = true;
    }
    this.ws = new WebSocket(url.toString(), wsOptions);

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

    this.ws.on('close', (code?: number) => {
      this.stopHeartbeat();
      this.clearConnectionTimer(); // prevent old timeout from closing a fallback
      // If header auth failed (new client, old server), retry once with
      // query token. Remove after 2026-08-01 transition window.
      if (code === 4001 && this._headerAuthAttempted && !this._queryFallbackRetried) {
        this._queryFallbackRetried = true;
        this._headerAuthAttempted = false;
        console.error('[relay-client] header auth failed (old server?), retrying with query token');
        this.connect();
        return;
      }
      // Reset the fallback flag on reconnect or non-auth close.
      this._queryFallbackRetried = false;
      this._headerAuthAttempted = false;
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
