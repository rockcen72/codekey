import type { WsMessage } from './types.js';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export function serializeMessage(msg: WsMessage): Uint8Array {
  return TEXT_ENCODER.encode(JSON.stringify(msg));
}

export function deserializeMessage(data: ArrayBuffer | Uint8Array): WsMessage {
  const text = data instanceof Uint8Array ? TEXT_DECODER.decode(data) : TEXT_DECODER.decode(data);
  return JSON.parse(text) as WsMessage;
}

export function createPing(): WsMessage {
  return { type: 'ping', ts: new Date().toISOString() };
}

export function createPong(): WsMessage {
  return { type: 'pong', ts: new Date().toISOString() };
}
