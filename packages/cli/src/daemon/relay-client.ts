import WebSocket from 'ws';
import {
  type WsMessage,
  type DeviceInfo,
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  serializeMessage,
  createPing,
} from '@devtap/shared';

export class RelayClient {
  private ws: WebSocket | null = null;
  private deviceToken: string;
  private relayUrl: string;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectAttempt = 0;
  private intentionalClose = false;

  constructor(deviceToken: string, relayUrl: string) {
    this.deviceToken = deviceToken;
    this.relayUrl = relayUrl;
  }

  connect(): void {
    const url = new URL('/ws', this.relayUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', this.deviceToken);

    this.ws = new WebSocket(url.toString());

    this.ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.startHeartbeat();
    });

    this.ws.on('message', (data: ArrayBuffer) => {
      // TODO: handle incoming messages
    });

    this.ws.on('close', () => {
      this.stopHeartbeat();
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', () => {
      // 'close' will fire after this
    });
  }

  send(msg: WsMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(serializeMessage(msg));
    }
  }

  close(): void {
    this.intentionalClose = true;
    this.ws?.close();
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
