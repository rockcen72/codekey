import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type postgres from 'postgres';
import type { WsMessage } from '@devtap/shared';

export function wsHandler(sql: postgres.Sql) {
  return function (socket: WebSocket, req: FastifyRequest) {
    // TODO: validate token, manage session subscriptions
    console.log('WebSocket client connected');

    socket.on('message', (raw) => {
      try {
        const msg: WsMessage = JSON.parse(raw.toString());

        switch (msg.type) {
          case 'ping':
            socket.send(JSON.stringify({ type: 'pong', ts: new Date().toISOString() }));
            break;
          case 'event':
            // TODO: store event, push to mini program subscribers
            break;
          case 'response':
            // TODO: forward response to PC daemon
            break;
        }
      } catch (err) {
        console.error('WS message error:', err);
      }
    });

    socket.on('close', () => {
      console.log('WebSocket client disconnected');
    });
  };
}
