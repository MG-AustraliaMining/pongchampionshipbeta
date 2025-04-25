require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// Initialize Express app
const app = express();

// Enhanced security middleware for Render
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? [process.env.CLIENT_URL, 'https://your-render-app.onrender.com'] 
    : '*',
  credentials: true
}));

// Rate limiting configuration for Render
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Higher limit for WebSocket connections
  message: 'Too many requests from this IP, please try again later'
});
app.use(limiter);

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Create HTTP server
const server = http.createServer(app);

// Configure Socket.IO for Render
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? [process.env.CLIENT_URL, 'https://your-render-app.onrender.com']
      : '*',
    methods: ["GET", "POST"],
    transports: ['websocket', 'polling'],
    credentials: true
  },
  pingInterval: 25000, // Render has a 30s timeout
  pingTimeout: 20000,
  cookie: false
});

// Game state management
class GameManager {
  constructor() {
    this.activeGames = new Map();
    this.playerSockets = new Map();
    this.cleanupInterval = setInterval(() => this.cleanupInactiveGames(), 60000);
  }

  generateGameId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  createGame(hostId, hostName) {
    const gameId = this.generateGameId();
    const gameData = {
      id: gameId,
      host: hostId,
      hostName: hostName,
      guest: null,
      guestName: null,
      ball: null,
      leftScore: 0,
      rightScore: 0,
      leftPaddle: { y: 0 },
      rightPaddle: { y: 0 },
      remainingTime: 120, // 2 minutes
      lastActivity: Date.now(),
      status: 'waiting'
    };
    this.activeGames.set(gameId, gameData);
    this.playerSockets.set(hostId, gameId);
    return gameData;
  }

  joinGame(gameId, guestId, guestName) {
    const game = this.activeGames.get(gameId);
    if (!game || game.guest) return null;
    
    game.guest = guestId;
    game.guestName = guestName;
    game.status = 'playing';
    game.lastActivity = Date.now();
    this.playerSockets.set(guestId, gameId);
    return game;
  }

  removeGame(gameId) {
    const game = this.activeGames.get(gameId);
    if (!game) return;

    this.playerSockets.delete(game.host);
    if (game.guest) this.playerSockets.delete(game.guest);
    this.activeGames.delete(gameId);
  }

  cleanupInactiveGames() {
    const now = Date.now();
    const inactiveThreshold = 1000 * 60 * 5; // 5 minutes
    
    for (const [gameId, game] of this.activeGames) {
      if (now - game.lastActivity > inactiveThreshold) {
        this.removeGame(gameId);
      }
    }
  }

  getAvailableGames() {
    return Array.from(this.activeGames.values())
      .filter(game => game.status === 'waiting')
      .map(game => ({
        id: game.id,
        name: `${game.hostName}'s Game`,
        createdAt: game.lastActivity
      }));
  }
}

const gameManager = new GameManager();

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  // Heartbeat for Render's 30s timeout
  const heartbeatInterval = setInterval(() => {
    socket.emit('ping');
  }, 15000);

  socket.on('pong', () => {
    const gameId = gameManager.playerSockets.get(socket.id);
    if (gameId) {
      const game = gameManager.activeGames.get(gameId);
      if (game) game.lastActivity = Date.now();
    }
  });

  // Game creation
  socket.on('createGame', ({ playerName }, callback) => {
    try {
      const game = gameManager.createGame(socket.id, playerName);
      socket.join(game.id);
      callback({ status: 'success', gameId: game.id });
    } catch (error) {
      callback({ status: 'error', message: 'Failed to create game' });
    }
  });

  // Game joining
  socket.on('joinGame', ({ gameId, playerName }, callback) => {
    const game = gameManager.joinGame(gameId, socket.id, playerName);
    if (!game) {
      return callback({ status: 'error', message: 'Game not found or full' });
    }

    socket.join(gameId);
    io.to(game.host).emit('gameStart', { 
      rightPlayer: playerName 
    });
    callback({ status: 'success' });
  });

  // Game cancellation
  socket.on('cancelGame', (gameId) => {
    const game = gameManager.activeGames.get(gameId);
    if (game && game.host === socket.id) {
      if (game.guest) {
        io.to(game.guest).emit('gameCancelled');
      }
      gameManager.removeGame(gameId);
    }
  });

  // Game state updates
  socket.on('paddleMove', ({ y }) => {
    const gameId = gameManager.playerSockets.get(socket.id);
    if (!gameId) return;

    const game = gameManager.activeGames.get(gameId);
    if (!game) return;

    game.lastActivity = Date.now();

    if (socket.id === game.host) {
      game.leftPaddle.y = y;
      io.to(game.guest).emit('paddleMove', { y });
    } else if (socket.id === game.guest) {
      game.rightPaddle.y = y;
      io.to(game.host).emit('paddleMove', { y });
    }
  });

  socket.on('ballUpdate', (ball) => {
    const gameId = gameManager.playerSockets.get(socket.id);
    if (!gameId) return;

    const game = gameManager.activeGames.get(gameId);
    if (!game || socket.id !== game.host) return;

    game.ball = ball;
    game.lastActivity = Date.now();
    io.to(game.guest).emit('ballUpdate', { ball });
  });

  socket.on('scoreUpdate', ({ leftScore, rightScore }) => {
    const gameId = gameManager.playerSockets.get(socket.id);
    if (!gameId) return;

    const game = gameManager.activeGames.get(gameId);
    if (!game || socket.id !== game.host) return;

    game.leftScore = leftScore;
    game.rightScore = rightScore;
    game.lastActivity = Date.now();
    io.to(game.guest).emit('scoreUpdate', { leftScore, rightScore });
  });

  socket.on('timerUpdate', ({ remainingTime }) => {
    const gameId = gameManager.playerSockets.get(socket.id);
    if (!gameId) return;

    const game = gameManager.activeGames.get(gameId);
    if (!game || socket.id !== game.host) return;

    game.remainingTime = remainingTime;
    game.lastActivity = Date.now();
    io.to(game.guest).emit('timerUpdate', { remainingTime });
  });

  socket.on('gameEnd', () => {
    const gameId = gameManager.playerSockets.get(socket.id);
    if (!gameId) return;

    const game = gameManager.activeGames.get(gameId);
    if (!game || socket.id !== game.host) return;

    io.to(gameId).emit('gameEnd');
    gameManager.removeGame(gameId);
  });

  socket.on('requestGameList', (callback) => {
    callback(gameManager.getAvailableGames());
  });

  // Disconnection handling
  socket.on('disconnect', () => {
    clearInterval(heartbeatInterval);
    const gameId = gameManager.playerSockets.get(socket.id);
    if (!gameId) return;

    const game = gameManager.activeGames.get(gameId);
    if (!game) return;

    if (socket.id === game.host) {
      if (game.guest) {
        io.to(game.guest).emit('hostDisconnected');
      }
      gameManager.removeGame(gameId);
    } else if (socket.id === game.guest) {
      game.guest = null;
      game.guestName = null;
      game.status = 'waiting';
      io.to(game.host).emit('guestDisconnected');
    }

    gameManager.playerSockets.delete(socket.id);
  });
});

// Error handling
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (process.env.NODE_ENV === 'production') {
    console.log('Production mode enabled');
  }
});
