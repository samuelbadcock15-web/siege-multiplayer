const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 6 Fixed 2-Player Combat Lobbies
const rooms = {};
for (let i = 1; i <= 6; i++) {
    const roomId = `room_${i}`;
    rooms[roomId] = {
        id: roomId,
        name: `Arena 0${i}`,
        players: {}, // socketId: { playerIndex: 1|2, team: 'blue'|'dark', ready: false }
        status: 'open' // 'open' | 'in_game'
    };
}

let totalOnlinePlayers = 0;

function getLobbiesSummary() {
    const list = [];
    for (const rId in rooms) {
        const r = rooms[rId];
        const pKeys = Object.keys(r.players);
        list.push({
            id: r.id,
            name: r.name,
            playerCount: pKeys.length,
            status: r.status,
            players: pKeys.map(id => ({
                id,
                ready: r.players[id].ready,
                team: r.players[id].team,
                playerIndex: r.players[id].playerIndex
            }))
        });
    }
    return list;
}

function broadcastLobbyState() {
    io.emit('lobbies_update', getLobbiesSummary());
    io.emit('update_counts', { totalOnline: totalOnlinePlayers, inQueue: 0 });
}

function removePlayerFromCurrentRoom(socket) {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        if (room.players[socket.id]) {
            delete room.players[socket.id];
            socket.leave(roomId);

            if (room.status === 'in_game') {
                io.to(roomId).emit('opponent_disconnected');
                room.status = 'open';
                room.players = {};
            }
            broadcastLobbyState();
            break;
        }
    }
}

io.on('connection', (socket) => {
    totalOnlinePlayers++;
    console.log('Player connected:', socket.id);

    socket.emit('lobbies_update', getLobbiesSummary());
    broadcastLobbyState();

    socket.on('join_room', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;

        if (room.status === 'in_game') {
            socket.emit('lobby_error', 'This battle is currently in progress!');
            return;
        }

        const currentPlayers = Object.keys(room.players);
        if (currentPlayers.length >= 2) {
            socket.emit('lobby_error', 'This arena is already full!');
            return;
        }

        removePlayerFromCurrentRoom(socket);

        let assignedIndex = 1;
        let assignedTeam = 'blue';
        if (currentPlayers.length === 1) {
            const existingP = room.players[currentPlayers[0]];
            assignedIndex = existingP.playerIndex === 1 ? 2 : 1;
            assignedTeam = assignedIndex === 1 ? 'blue' : 'dark';
        }

        room.players[socket.id] = {
            playerIndex: assignedIndex,
            team: assignedTeam,
            ready: false
        };

        socket.roomID = roomId;
        socket.join(roomId);

        socket.emit('room_joined', {
            roomId: room.id,
            name: room.name,
            playerIndex: assignedIndex,
            team: assignedTeam
        });

        broadcastLobbyState();
    });

    socket.on('leave_room', () => {
        removePlayerFromCurrentRoom(socket);
        socket.roomID = null;
        socket.emit('left_room_success');
        broadcastLobbyState();
    });

    socket.on('toggle_ready', (roomId) => {
        const room = rooms[roomId];
        if (!room || !room.players[socket.id]) return;

        room.players[socket.id].ready = !room.players[socket.id].ready;
        broadcastLobbyState();

        const playerIds = Object.keys(room.players);
        const allReady = playerIds.length === 2 && playerIds.every(id => room.players[id].ready);

        if (allReady) {
            room.status = 'in_game';
            broadcastLobbyState();

            const p1 = playerIds[0];
            const p2 = playerIds[1];

            io.to(p1).emit('start_match_countdown', { roomId, playerIndex: room.players[p1].playerIndex });
            io.to(p2).emit('start_match_countdown', { roomId, playerIndex: room.players[p2].playerIndex });
        }
    });

    // In-game Relay Events
    socket.on('player_move', (data) => {
        socket.to(data.roomId).emit('opponent_move', data);
    });

    socket.on('fire_projectile', (data) => {
        socket.to(data.roomId).emit('opponent_fire', data);
    });

    socket.on('place_panel', (data) => {
        socket.to(data.roomId).emit('opponent_build', data);
    });

    socket.on('destroy_unit', (data) => {
        socket.to(data.roomId).emit('opponent_destroy', data);
    });

    socket.on('check_game_over', (data) => {
        io.to(data.roomId).emit('trigger_game_over', data);
    });

    socket.on('request_restart', (data) => {
        io.to(data.roomId).emit('restart_game');
    });

    socket.on('send_chat', (data) => {
        io.to(data.roomId).emit('receive_chat', {
            sender: data.sender,
            message: data.message
        });
    });

    socket.on('disconnect', () => {
        totalOnlinePlayers = Math.max(0, totalOnlinePlayers - 1);
        console.log('Player disconnected:', socket.id);
        removePlayerFromCurrentRoom(socket);
        broadcastLobbyState();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});
