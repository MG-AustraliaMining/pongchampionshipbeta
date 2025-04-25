const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // Allow all origins (change in production)
    methods: ["GET", "POST"]
  }
});

// Game state storage
const activeGames = new Map(); // gameId -> gameData
const playerSockets = new Map(); // socketId -> gameId

// Game configuration
const GAME_TIME = 120; // 2 minutes in seconds

// Helper functions
const generateGameId = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

const removeGame = (gameId) => {
  activeGames.delete(gameId);
  console.log(`Game ${gameId} removed`);
};

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  // Handle game creation
  socket.on('createGame', ({ playerName }) => {
    const gameId = generateGameId();
    const gameData = {
      id: gameId,
      host: socket.id,
      hostName: playerName,
      guest: null,
      guestName: null,
      ball: null,
      leftScore: 0,
      rightScore: 0,
      leftPaddle: { y: 0 },
      rightPaddle: { y: 0 },
      remainingTime: GAME_TIME,
      startTime: null,
      status: 'waiting'
    };

    activeGames.set(gameId, gameData);
    playerSockets.set(socket.id, gameId);

    socket.join(gameId);
    socket.emit('gameCreated', gameId);
    console.log(`Game created: ${gameId} by ${playerName}`);
  });

  // Handle game joining
  socket.on('joinGame', ({ gameId, playerName }) => {
    const game = activeGames.get(gameId);
    
    if (!game) {
      socket.emit('gameNotFound');
      return;
    }

    if (game.guest) {
      socket.emit('gameFull');
      return;
    }

    game.guest = socket.id;
    game.guestName = playerName;
    game.status = 'starting';
    playerSockets.set(socket.id, gameId);

    socket.join(gameId);
    io.to(game.host).emit('gameStart', { 
      rightPlayer: playerName 
    });
    console.log(`Player ${playerName} joined game ${gameId}`);
  });

  // Handle game cancellation
  socket.on('cancelGame', (gameId) => {
    const game = activeGames.get(gameId);
    if (game && game.host === socket.id) {
      if (game.guest) {
        io.to(game.guest).emit('gameCancelled');
      }
      removeGame(gameId);
    }
  });

  // Handle paddle movement
  socket.on('paddleMove', ({ y }) => {
    const gameId = playerSockets.get(socket.id);
    if (!gameId) return;

    const game = activeGames.get(gameId);
    if (!game) return;

    if (socket.id === game.host) {
      game.leftPaddle.y = y;
      io.to(game.guest).emit('paddleMove', { y });
    } else if (socket.id === game.guest) {
      game.rightPaddle.y = y;
      io.to(game.host).emit('paddleMove', { y });
    }
  });

  // Handle ball updates (from host)
  socket.on('ballUpdate', (ball) => {
    const gameId = playerSockets.get(socket.id);
    if (!gameId) return;

    const game = activeGames.get(gameId);
    if (!game || socket.id !== game.host) return;

    game.ball = ball;
    io.to(game.guest).emit('ballUpdate', { ball });
  });

  // Handle score updates (from host)
  socket.on('scoreUpdate', ({ leftScore, rightScore }) => {
    const gameId = playerSockets.get(socket.id);
    if (!gameId) return;

    const game = activeGames.get(gameId);
    if (!game || socket.id !== game.host) return;

    game.leftScore = leftScore;
    game.rightScore = rightScore;
    io.to(game.guest).emit('scoreUpdate', { leftScore, rightScore });
  });

  // Handle timer updates (from host)
  socket.on('timerUpdate', ({ remainingTime }) => {
    const gameId = playerSockets.get(socket.id);
    if (!gameId) return;

    const game = activeGames.get(gameId);
    if (!game || socket.id !== game.host) return;

    game.remainingTime = remainingTime;
    io.to(game.guest).emit('timerUpdate', { remainingTime });
  });

  // Handle game end
  socket.on('gameEnd', () => {
    const gameId = playerSockets.get(socket.id);
    if (!gameId) return;

    const game = activeGames.get(gameId);
    if (!game || socket.id !== game.host) return;

    io.to(gameId).emit('gameEnd');
    removeGame(gameId);
  });

  // Handle game list requests
  socket.on('requestGameList', () => {
    const availableGames = Array.from(activeGames.values())
      .filter(game => game.status === 'waiting')
      .map(game => ({
        id: game.id,
        name: `${game.hostName}'s Game`
      }));
    
    socket.emit('gameList', availableGames);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    const gameId = playerSockets.get(socket.id);
    if (!gameId) return;

    const game = activeGames.get(gameId);
    if (!game) return;

    if (socket.id === game.host) {
      // Host disconnected
      if (game.guest) {
        io.to(game.guest).emit('hostDisconnected');
      }
      removeGame(gameId);
    } else if (socket.id === game.guest) {
      // Guest disconnected
      game.guest = null;
      game.guestName = null;
      game.status = 'waiting';
      io.to(game.host).emit('guestDisconnected');
    }

    playerSockets.delete(socket.id);
    console.log(`Player disconnected: ${socket.id}`);
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
