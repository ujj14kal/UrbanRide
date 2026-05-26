// socket.js — Singleton Socket.io module
// Initialized once in server.js, shared across all modules (vc.js, etc.)

let io;

/**
 * Initialize Socket.io with an existing HTTP server.
 * Must be called before getIO().
 */
function init(httpServer) {
  const { Server } = require('socket.io');
  io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });
  return io;
}

/**
 * Returns the initialized io instance.
 * Throws if called before init().
 */
function getIO() {
  if (!io) {
    throw new Error('❌ Socket.io not initialized! Call init(httpServer) first.');
  }
  return io;
}

module.exports = { init, getIO };
