const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Explicitly serve static files and the index.html page
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let waitingPlayer = null;
const rooms = {};

io.on('connection', (socket) => {
    console.log('A player connected:', socket.id);

    // Matchmaking: Pair players up into rooms of 2
    if (!waitingPlayer) {
        waitingPlayer = socket;
        socket.emit('waiting_for_opponent');
    } else {
        const roomId = `room_${Math.random().toString(36).substring(2, 9)}`;
        socket.join(roomId);
        waitingPlayer.join(roomId);

        rooms[roomId] = {
            p1: waitingPlayer.id,
            p2: socket.id
        };

        // Assign roles (Player 1 = UK / South, Player 2 = Germany / North)
        io.to(waitingPlayer.id).emit('assigned_role', { playerIndex: 1, roomId });
        io.to(socket.id).emit('assigned_role', { playerIndex: 2, roomId });

        // Start match for both
        io.to(roomId).emit('start_match');

        waitingPlayer = null;
    }

    // Real-time unit movement synchronization
    socket.on('player_move', (data) => {
        socket.to(data.roomId).emit('opponent_move', data);
    });

    // Projectile firing synchronization
    socket.on('fire_projectile', (data) => {
        socket.to(data.roomId).emit('opponent_fire', data);
    });

    // Base building synchronization
    socket.on('place_panel', (data) => {
        socket.to(data.roomId).emit('opponent_build', data);
    });

    // Unit destruction synchronization
    socket.on('destroy_unit', (data) => {
        socket.to(data.roomId).emit('opponent_destroy', data);
    });

    // Game over checking
    socket.on('check_game_over', (data) => {
        io.to(data.roomId).emit('trigger_game_over', data);
    });

    // Restart game request
    socket.on('request_restart', (data) => {
        io.to(data.roomId).emit('restart_game');
    });

    // Handle disconnects
    socket.on('disconnect', () => {
        console.log('A player disconnected:', socket.id);
        if (waitingPlayer === socket) {
            waitingPlayer = null;
        }
        for (const roomId in rooms) {
            if (rooms[roomId].p1 === socket.id || rooms[roomId].p2 === socket.id) {
                io.to(roomId).emit('opponent_disconnected');
                delete rooms[roomId];
            }
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server is running smoothly on http://localhost:${PORT}`);
});