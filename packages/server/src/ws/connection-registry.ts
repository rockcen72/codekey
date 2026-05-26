import type { WebSocket } from 'ws';

export interface WsClient {
  socket: WebSocket;
  deviceId: string;
  tokenType: 'device' | 'client';
  sessionId?: string;
}

export interface PairingClient {
  socket: WebSocket;
  deviceId: string;
}

export const pcClients = new Map<string, WsClient>();
export const clientClients = new Map<string, Set<WsClient>>();
export const pairingClients = new Map<string, PairingClient>();
