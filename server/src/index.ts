import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Server } from 'socket.io';

import { DEFAULT_PORT } from '../../shared/constants.js';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/types.js';
import { RoomManager } from './rooms.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: '*' },
});

// In production (`npm run build && npm start`) serve the built client with an SPA fallback.
const clientDist = path.resolve(moduleDir, '../../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.use((_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const roomManager = new RoomManager(io);
io.on('connection', (socket) => {
  // Latency probe: echo immediately, no room membership required.
  socket.on('net:ping', (t) => {
    if (typeof t === 'number' && Number.isFinite(t)) socket.emit('net:pong', t);
  });
  roomManager.handleConnection(socket);
});

const port = Number(process.env.PORT) || DEFAULT_PORT;
httpServer.listen(port, '0.0.0.0', () => {
  console.log(`BoomBoom server listening on http://0.0.0.0:${port}`);
});
