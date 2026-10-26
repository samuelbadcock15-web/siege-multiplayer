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

const PANEL_SIZE = 12;

const rooms = {};
for (let i = 1; i <= 6; i++) {
    const roomId = `room_${i}`;
    rooms[roomId] = {
        id: roomId,
        name: `Arena 0${i}`,
        players: {},
        panels: {}, // Keyed by playerIndex or separated per player to ensure team isolation
        units: {},
        status: 'open'
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
            socket.roomID = null;

            if (room.status === 'in_game') {
                io.to(roomId).emit('opponent_disconnected');
                room.status = 'open';
                room.players = {};
                room.panels = {};
                room.units = {};
            }
            broadcastLobbyState();
            break;
        }
    }
}

function isLegalTerritory(playerIndex, targetZ, panelDepth = PANEL_SIZE) {
    const halfDepth = panelDepth / 2;
    if (playerIndex === 1) {
        return (targetZ - halfDepth) >= 5.0;
    } else {
        return (targetZ + halfDepth) <= -5.0;
    }
}

io.on('connection', (socket) => {
    totalOnlinePlayers++;
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
            room.panels = {};
            room.units = {};
            broadcastLobbyState();

            const p1 = playerIds[0];
            const p2 = playerIds[1];

            io.to(p1).emit('start_match_countdown', { roomId, playerIndex: room.players[p1].playerIndex });
            io.to(p2).emit('start_match_countdown', { roomId, playerIndex: room.players[p2].playerIndex });
        }
    });

    socket.on('place_panel', (data) => {
        const room = rooms[data.roomId];
        const player = room?.players[socket.id];
        if (!room || !player) return;

        if (!isLegalTerritory(player.playerIndex, data.pos.z, PANEL_SIZE)) {
            socket.emit('build_error', 'Cannot build across the river line into enemy territory!');
            return;
        }

        data.playerIndex = player.playerIndex;
        room.panels[data.id] = data;
        socket.to(data.roomId).emit('opponent_build', data);
    });

    socket.on('extend_ramp', (data) => {
        const room = rooms[data.roomId];
        const player = room?.players[socket.id];
        if (!room || !player) return;

        const panel = room.panels[data.id];
        if (panel) {
            panel.rampSegments = data.rampSegments;
            socket.to(data.roomId).emit('opponent_extend_ramp', data);
        }
    });

    socket.on('shorten_ramp', (data) => {
        const room = rooms[data.roomId];
        const player = room?.players[socket.id];
        if (!room || !player) return;

        const panel = room.panels[data.id];
        if (panel) {
            panel.rampSegments = data.rampSegments;
            socket.to(data.roomId).emit('opponent_shorten_ramp', data);
        }
    });

    socket.on('remove_panel', (data) => {
        const room = rooms[data.roomId];
        if (room && room.panels[data.id]) {
            delete room.panels[data.id];
            socket.to(data.roomId).emit('opponent_remove_panel', data);
        }
    });

    socket.on('player_move', (data) => {
        socket.to(data.roomId).emit('opponent_move', data);
    });

    socket.on('fire_projectile', (data) => {
        socket.to(data.roomId).emit('opponent_fire', data);
    });

    socket.on('destroy_unit', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        io.to(data.roomId).emit('opponent_destroy', data);
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
        removePlayerFromCurrentRoom(socket);
        broadcastLobbyState();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});
