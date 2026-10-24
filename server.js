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

// 6 Fixed 2-Player Combat Arenas
const rooms = {};
for (let i = 1; i <= 6; i++) {
    const roomId = `room_${i}`;
    rooms[roomId] = {
        id: roomId,
        name: `Arena 0${i}`,
        players: {}, // socketId: { playerIndex: 1|2, team: 'blue'|'dark', ready: false }
        panels: {},  // panelId: { id, type, pos: {x,y,z}, rot: {x,y,z}, segments: 1 }
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
                room.panels = {};
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
            room.panels = {}; // Reset panel grid for a fresh battle
            broadcastLobbyState();

            const p1 = playerIds[0];
            const p2 = playerIds[1];

            io.to(p1).emit('start_match_countdown', { 
                roomId, 
                playerIndex: room.players[p1].playerIndex,
                existingPanels: Object.values(room.panels)
            });
            io.to(p2).emit('start_match_countdown', { 
                roomId, 
                playerIndex: room.players[p2].playerIndex,
                existingPanels: Object.values(room.panels)
            });
        }
    });

    // ==========================================
    // REAL-TIME BUILDING & EXTENSION EVENTS
    // ==========================================
    socket.on('place_panel', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;

        // Save panel into the room's persistent state
        const panelRecord = {
            id: data.id || Math.random().toString(),
            type: data.type,
            pos: { x: Number(data.pos.x), y: Number(data.pos.y), z: Number(data.pos.z) },
            rot: { x: Number(data.rot.x), y: Number(data.rot.y), z: Number(data.rot.z) },
            segments: 1
        };
        room.panels[panelRecord.id] = panelRecord;

        // Instant real-time broadcast to opponent screen
        socket.to(data.roomId).emit('opponent_build', panelRecord);
    });

    socket.on('extend_ramp', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;

        // Update ramp segment count in memory if it exists
        if (room.panels[data.id]) {
            room.panels[data.id].segments = (room.panels[data.id].segments || 1) + 1;
        }

        // Instant real-time broadcast to stretch opponent's ramp on their screen
        socket.to(data.roomId).emit('opponent_extend_ramp', data);
    });

    // ==========================================
    // IN-GAME COMBAT & UNIT EVENTS
    // ==========================================
    socket.on('player_move', (data) => {
        socket.to(data.roomId).emit('opponent_move', data);
    });

    socket.on('fire_projectile', (data) => {
        socket.to(data.roomId).emit('opponent_fire', data);
    });

    socket.on('destroy_unit', (data) => {
        socket.to(data.roomId).emit('opponent_destroy', data);
    });

    socket.on('check_game_over', (data) => {
        io.to(data.roomId).emit('trigger_game_over', data);
    });

    socket.on('request_restart', (data) => {
        const room = rooms[data.roomId];
        if (room) {
            room.panels = {};
            room.status = 'open';
            for (const pid in room.players) {
                room.players[pid].ready = false;
            }
        }
        io.to(data.roomId).emit('restart_game');
        broadcastLobbyState();
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
