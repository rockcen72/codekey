type MessageHandler = (payload: any) => void;

const RECONNECT_INTERVAL = 3000;

export class WsClient {
  private socketTask: wx.SocketTask | null = null;
  private deviceId: string;
  private token: string;
  private serverUrl: string;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private destroyed = false;
  private listeners = new Map<string, Set<MessageHandler>>();

  constructor(serverUrl: string, deviceId: string, token: string) {
    this.serverUrl = serverUrl;
    this.deviceId = deviceId;
    this.token = token;
  }

  private emit(eventType: string, payload?: any): void {
    const handlers = this.listeners.get(eventType);
    if (handlers) {
      handlers.forEach(fn => fn(payload));
    }
  }

  connect(): void {
    if (this.socketTask) return;
    this.destroyed = false;
    const wsUrl = this.serverUrl.replace(/^http/, 'ws');
    this.socketTask = wx.connectSocket({
      url: `${wsUrl}/ws?device_id=${this.deviceId}&token=${this.token}`,
    });

    this.socketTask.onOpen(() => {
      this.startHeartbeat();
      this.emit('connected');
    });

    this.socketTask.onMessage((res: any) => {
      try {
        const msg = JSON.parse(res.data);
        this.emit(msg.type, msg.payload ?? msg);
        const wildcard = this.listeners.get('*');
        if (wildcard) {
          wildcard.forEach(fn => fn(msg));
        }
      } catch (e) {
        console.error('[ws] parse error:', e);
      }
    });

    this.socketTask.onClose((res: any) => {
      this.stopHeartbeat();
      this.socketTask = null;
      this.emit('disconnected');

      // Auth failure (close code 4001): don't reconnect
      if (res.code === 4001) {
        this.destroyed = true;
        this.emit('auth_failed');
        return;
      }

      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => {
          this.connect();
        }, RECONNECT_INTERVAL);
      }
    });

    this.socketTask.onError(() => {
      // onClose will fire after onError, reconnection handled there
    });
  }

  disconnect(): void {
    this.destroyed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socketTask) {
      this.socketTask.close();
      this.socketTask = null;
    }
  }

  on(eventType: string, handler: MessageHandler): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(handler);
  }

  off(eventType: string, handler: MessageHandler): void {
    this.listeners.get(eventType)?.delete(handler);
  }

  send(msg: object): void {
    if (this.socketTask) {
      this.socketTask.send({ data: JSON.stringify(msg) });
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping', ts: new Date().toISOString() });
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
