type WsEvent = 'connected' | 'disconnected' | 'auth_failed' | 'device_online' | 'device_offline';
type MessageHandler = (payload?: any) => void;

const RECONNECT_INTERVAL_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 5000;

export class WsClient {
  private ws: WebSocket | null = null;
  private destroyed = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private listeners = new Map<WsEvent, Set<MessageHandler>>();

  constructor(
    private relayUrl: string,
    private deviceId: string,
    private token: string,
  ) {}

  connect(): void {
    if (!this.relayUrl) {
      console.error('[WsClient] no relayUrl configured — check VITE_RELAY_URL');
      return;
    }
    if (this.destroyed) return;

    const wsUrl = this.relayUrl.replace(/^http/, 'ws');
    const url = `${wsUrl}/ws?device_id=${this.deviceId}&token=${this.token}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.startHeartbeat();
      this.emit('connected');
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'pong') return;
        if (msg.type === 'auth_failed') {
          this.emit('auth_failed', msg.payload || { code: msg.code || 'unknown' });
          return;
        }
        if (msg.type === 'device_online' || msg.type === 'device_offline') {
          this.emit(msg.type, msg.payload || msg);
        }
      } catch {
        // drop malformed messages silently
      }
    };

    this.ws.onclose = (event: CloseEvent) => {
      this.stopHeartbeat();
      this.clearReconnectTimer();
      this.ws = null;
      this.emit('disconnected');

      // Close code 4001 = auth failure (device unbound / replaced).
      // Token is revoked — don't reconnect. Emit auth_failed as fallback
      // in case the message frame before close was lost or not parsed.
      if (event.code === 4001) {
        this.destroyed = true;
        this.emit('auth_failed', { code: 'DEVICE_UNBOUND' });
        return;
      }

      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_INTERVAL_MS);
      }
    };

    this.ws.onerror = () => {
      // close event fires after error — handled there
    };
  }

  disconnect(): void {
    this.destroyed = true;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.ws?.close();
    this.ws = null;
  }

  on(event: WsEvent, handler: MessageHandler): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  off(event: WsEvent, handler: MessageHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  private emit(event: WsEvent, payload?: any): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach((fn) => fn(payload));
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping', ts: new Date().toISOString() }));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
