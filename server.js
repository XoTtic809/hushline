const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const Database   = require('better-sqlite3');

// ── Setup ──────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'hushline-dev-secret-change-me';
const DATA_DIR   = process.env.DATA_DIR   || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Database ───────────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'hushline.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    password   TEXT    NOT NULL,
    color      TEXT    NOT NULL DEFAULT '#D4860A',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    description TEXT    NOT NULL DEFAULT '',
    type        TEXT    NOT NULL DEFAULT 'community',
    created_by  INTEGER,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    username   TEXT    NOT NULL,
    color      TEXT    NOT NULL,
    text       TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (room_id) REFERENCES rooms(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
`);

// ── Remove old default rooms ─────────────────────────────────────────────
['music', 'tech', 'creative', 'random'].forEach(name => {
  const row = db.prepare('SELECT id FROM rooms WHERE name = ? AND type = ?').get(name, 'community');
  if (row) {
    db.prepare('DELETE FROM messages WHERE room_id = ?').run(row.id);
    db.prepare('DELETE FROM rooms WHERE id = ?').run(row.id);
    console.log('Removed default room: ' + name);
  }
});

// ── Seed default community rooms ───────────────────────────────────────────
const defaultRooms = [
  { name: 'general', description: 'Main hangout for everyone', type: 'community' },
];

const insertRoom = db.prepare(`
  INSERT OR IGNORE INTO rooms (name, description, type) VALUES (?, ?, ?)
`);
defaultRooms.forEach(r => insertRoom.run(r.name, r.description, r.type));

// ── Helpers ────────────────────────────────────────────────────────────────
const COLORS = [
  '#FF6B6B','#4ECDC4','#FFE66D','#A8E6CF','#FF8B94','#FFA502',
  '#7BED9F','#70A1FF','#FF6348','#ECCC68','#5352ED','#2ED573',
  '#1E90FF','#FF6B81','#C56CF0','#F8A5C2','#63CDDA','#EA8685'
];
function randomColor() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }

function makeToken(user) {
  return jwt.sign({ id: user.id, username: user.username, color: user.color }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// ── Auth REST ──────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const u = username.trim().slice(0, 30);
  if (u.length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters.' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  if (!/^[a-zA-Z0-9_.\-]+$/.test(u)) return res.status(400).json({ error: 'Username can only contain letters, numbers, _ . -' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(u);
  if (existing) return res.status(409).json({ error: 'That username is taken.' });

  const hash  = bcrypt.hashSync(password, 10);
  const color = randomColor();
  const info  = db.prepare('INSERT INTO users (username, password, color) VALUES (?,?,?)').run(u, hash, color);
  const user  = { id: info.lastInsertRowid, username: u, color };
  res.json({ token: makeToken(user), user: { id: user.id, username: user.username, color: user.color } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Invalid username or password.' });
  res.json({ token: makeToken(user), user: { id: user.id, username: user.username, color: user.color } });
});

// ── Socket auth middleware ─────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Not authenticated'));
  const payload = verifyToken(token);
  if (!payload) return next(new Error('Invalid token'));
  socket.user = payload;
  next();
});

// ── Track online users per room ────────────────────────────────────────────
// roomName -> Map<socketId, { username, color }>
const onlineRooms = {};

function getRoomOnline(roomName) {
  const m = onlineRooms[roomName];
  if (!m) return [];
  return [...m.values()];
}

function getRoomList() {
  const rooms = db.prepare('SELECT id, name, description, type, created_by FROM rooms ORDER BY type ASC, name ASC').all();
  return rooms.map(r => {
    const last = db.prepare(
      'SELECT username, color, text, created_at FROM messages WHERE room_id=? ORDER BY created_at DESC LIMIT 1'
    ).get(r.id);
    const onlineCount = onlineRooms[r.name] ? onlineRooms[r.name].size : 0;
    return { ...r, onlineCount, lastMessage: last || null };
  });
}

// ── Socket events ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const user = socket.user;
  console.log(`[+] ${user.username} connected`);

  socket.emit('room_list', getRoomList());

  socket.on('join_room', ({ room }) => {
    const roomRow = db.prepare('SELECT * FROM rooms WHERE name = ?').get(room);
    if (!roomRow) return;

    // Leave previous room
    if (socket.currentRoom) {
      const prev = socket.currentRoom;
      socket.leave(prev);
      if (onlineRooms[prev]) {
        onlineRooms[prev].delete(socket.id);
        if (onlineRooms[prev].size === 0) delete onlineRooms[prev];
      }
      io.to(prev).emit('system_message', { text: `${user.username} left`, timestamp: Date.now() });
      io.to(prev).emit('room_online', getRoomOnline(prev));
    }

    socket.currentRoom = room;
    socket.join(room);
    if (!onlineRooms[room]) onlineRooms[room] = new Map();
    onlineRooms[room].set(socket.id, { username: user.username, color: user.color });

    // Send last 100 messages
    const msgs = db.prepare(`
      SELECT m.id, m.username, m.color, m.text, m.created_at as timestamp
      FROM messages m WHERE m.room_id = ?
      ORDER BY m.created_at DESC LIMIT 100
    `).all(roomRow.id).reverse();
    socket.emit('message_history', msgs);

    io.to(room).emit('system_message', { text: `${user.username} joined`, timestamp: Date.now() });
    io.to(room).emit('room_online', getRoomOnline(room));
    io.emit('room_list', getRoomList());
  });

  socket.on('send_message', ({ text }) => {
    if (!socket.currentRoom) return;
    const t = text?.trim().slice(0, 2000);
    if (!t) return;
    const roomRow = db.prepare('SELECT id FROM rooms WHERE name = ?').get(socket.currentRoom);
    if (!roomRow) return;

    const info = db.prepare(
      'INSERT INTO messages (room_id, user_id, username, color, text) VALUES (?,?,?,?,?)'
    ).run(roomRow.id, user.id, user.username, user.color, t);

    const msg = { id: info.lastInsertRowid, username: user.username, color: user.color, text: t, timestamp: Math.floor(Date.now()/1000) };
    io.to(socket.currentRoom).emit('new_message', msg);
    io.emit('room_list', getRoomList());
  });

  socket.on('create_room', ({ name, description }) => {
    const n = name?.trim().toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,30);
    if (!n || n.length < 2) return socket.emit('room_error', 'Room name must be 2+ letters/numbers.');
    const exists = db.prepare('SELECT id FROM rooms WHERE name = ?').get(n);
    if (exists) return socket.emit('room_error', 'Room already exists.');
    const d = (description || '').trim().slice(0, 100);
    db.prepare('INSERT INTO rooms (name, description, type, created_by) VALUES (?,?,?,?)').run(n, d, 'user', user.id);
    io.emit('room_list', getRoomList());
    socket.emit('room_created', { name: n });
  });


  socket.on('delete_room', ({ name }) => {
    const room = db.prepare('SELECT * FROM rooms WHERE name = ?').get(name);
    if (!room) return socket.emit('room_error', 'Room not found.');
    if (room.type === 'community') return socket.emit('room_error', 'Cannot delete community rooms.');
    if (room.created_by !== user.id) return socket.emit('room_error', 'You can only delete rooms you created.');

    // Kick everyone out of the room first
    if (onlineRooms[name]) {
      io.to(name).emit('system_message', { text: 'This room has been deleted.', timestamp: Date.now() });
      io.to(name).emit('room_deleted', { name });
      delete onlineRooms[name];
    }

    db.prepare('DELETE FROM messages WHERE room_id = ?').run(room.id);
    db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
    io.emit('room_list', getRoomList());
  });

  socket.on('typing', () => {
    if (!socket.currentRoom) return;
    socket.to(socket.currentRoom).emit('user_typing', { username: user.username });
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${user.username} disconnected`);
    if (socket.currentRoom) {
      const r = socket.currentRoom;
      if (onlineRooms[r]) {
        onlineRooms[r].delete(socket.id);
        if (onlineRooms[r].size === 0) delete onlineRooms[r];
      }
      io.to(r).emit('system_message', { text: `${user.username} disconnected`, timestamp: Date.now() });
      io.to(r).emit('room_online', getRoomOnline(r));
    }
    io.emit('room_list', getRoomList());
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`HushLine running on port ${PORT}`));
