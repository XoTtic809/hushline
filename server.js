const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const Database   = require('better-sqlite3');

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
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    description   TEXT    NOT NULL DEFAULT '',
    type          TEXT    NOT NULL DEFAULT 'community',
    is_private    INTEGER NOT NULL DEFAULT 0,
    room_password TEXT,
    created_by    INTEGER,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
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

  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT    NOT NULL DEFAULT 'dm',
    name       TEXT,
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS conv_members (
    conv_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (conv_id, user_id),
    FOREIGN KEY (conv_id) REFERENCES conversations(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS conv_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    conv_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    username   TEXT    NOT NULL,
    color      TEXT    NOT NULL,
    text       TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (conv_id) REFERENCES conversations(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS friends (
    user_id    INTEGER NOT NULL,
    friend_id  INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, friend_id),
    FOREIGN KEY (user_id)   REFERENCES users(id),
    FOREIGN KEY (friend_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS friend_requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id    INTEGER NOT NULL,
    to_id      INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (from_id, to_id),
    FOREIGN KEY (from_id) REFERENCES users(id),
    FOREIGN KEY (to_id)   REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_conv_messages ON conv_messages(conv_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_conv_members  ON conv_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_friends       ON friends(user_id);
  CREATE INDEX IF NOT EXISTS idx_freq_to       ON friend_requests(to_id);
`);

function addCol(table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch {}
}
addCol('rooms', 'is_private',    'INTEGER NOT NULL DEFAULT 0');
addCol('rooms', 'room_password', 'TEXT');

['music', 'tech', 'creative', 'random'].forEach(name => {
  const row = db.prepare('SELECT id FROM rooms WHERE name = ? AND type = ?').get(name, 'community');
  if (row) {
    db.prepare('DELETE FROM messages WHERE room_id = ?').run(row.id);
    db.prepare('DELETE FROM rooms WHERE id = ?').run(row.id);
  }
});
db.prepare('INSERT OR IGNORE INTO rooms (name, description, type) VALUES (?,?,?)').run('general', 'Main hangout for everyone', 'community');

// ── Helpers ────────────────────────────────────────────────────────────────
const COLORS = ['#FF6B6B','#4ECDC4','#FFE66D','#A8E6CF','#FF8B94','#FFA502','#7BED9F','#70A1FF','#FF6348','#ECCC68','#5352ED','#2ED573','#1E90FF','#FF6B81','#C56CF0','#F8A5C2','#63CDDA','#EA8685'];
function randomColor() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }
function makeToken(u) { return jwt.sign({ id: u.id, username: u.username, color: u.color }, JWT_SECRET, { expiresIn: '30d' }); }
function verifyToken(t) { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } }
function socketsForUser(uid) { return [...io.sockets.sockets.values()].filter(s => s.user?.id === uid); }

function getRoomList() {
  return db.prepare('SELECT id, name, description, type, is_private, created_by FROM rooms ORDER BY type ASC, name ASC').all().map(r => {
    const last = db.prepare('SELECT username, color, text, created_at FROM messages WHERE room_id=? ORDER BY created_at DESC LIMIT 1').get(r.id);
    const onlineCount = onlineRooms[r.name] ? onlineRooms[r.name].size : 0;
    return { ...r, onlineCount, lastMessage: last || null };
  });
}

function getUserConvs(userId) {
  return db.prepare(`
    SELECT c.id, c.type, c.name, c.created_by FROM conversations c
    JOIN conv_members cm ON cm.conv_id = c.id AND cm.user_id = ?
    ORDER BY (SELECT created_at FROM conv_messages WHERE conv_id = c.id ORDER BY created_at DESC LIMIT 1) DESC, c.created_at DESC
  `).all(userId).map(c => ({
    ...c,
    members: db.prepare('SELECT u.id, u.username, u.color FROM conv_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conv_id = ?').all(c.id),
    lastMessage: db.prepare('SELECT username, text, created_at FROM conv_messages WHERE conv_id = ? ORDER BY created_at DESC LIMIT 1').get(c.id) || null
  }));
}

function getFriendData(userId) {
  const friends = db.prepare('SELECT u.id, u.username, u.color FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ? ORDER BY u.username').all(userId);
  const sent    = db.prepare('SELECT u.id, u.username, u.color FROM friend_requests fr JOIN users u ON u.id = fr.to_id WHERE fr.from_id = ?').all(userId);
  const received= db.prepare('SELECT u.id, u.username, u.color FROM friend_requests fr JOIN users u ON u.id = fr.from_id WHERE fr.to_id = ?').all(userId);
  return { friends, sent, received };
}

function getRelationship(meId, theirId) {
  const isFriend  = !!db.prepare('SELECT 1 FROM friends WHERE user_id=? AND friend_id=?').get(meId, theirId);
  const iSent     = !!db.prepare('SELECT 1 FROM friend_requests WHERE from_id=? AND to_id=?').get(meId, theirId);
  const theySent  = !!db.prepare('SELECT 1 FROM friend_requests WHERE from_id=? AND to_id=?').get(theirId, meId);
  return { isFriend, iSent, theySent };
}

// ── Auth REST ──────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const u = username.trim().slice(0, 30);
  if (u.length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters.' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  if (!/^[a-zA-Z0-9_.\-]+$/.test(u)) return res.status(400).json({ error: 'Username can only contain letters, numbers, _ . -' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(u)) return res.status(409).json({ error: 'That username is taken.' });
  const hash = bcrypt.hashSync(password, 10), color = randomColor();
  const info = db.prepare('INSERT INTO users (username, password, color) VALUES (?,?,?)').run(u, hash, color);
  const user = { id: info.lastInsertRowid, username: u, color };
  res.json({ token: makeToken(user), user: { id: user.id, username: user.username, color: user.color } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Invalid username or password.' });
  res.json({ token: makeToken(user), user: { id: user.id, username: user.username, color: user.color } });
});

// Profile lookup REST endpoint
app.get('/api/profile/:username', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const me = verifyToken(token);
  if (!me) return res.status(401).json({ error: 'Not authenticated.' });
  const user = db.prepare('SELECT id, username, color, created_at FROM users WHERE username = ?').get(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const rel = getRelationship(me.id, user.id);
  const friendCount = db.prepare('SELECT COUNT(*) as c FROM friends WHERE user_id = ?').get(user.id).c;
  res.json({ ...user, ...rel, friendCount, isSelf: me.id === user.id });
});

// ── Socket auth ────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Not authenticated'));
  const payload = verifyToken(token);
  if (!payload) return next(new Error('Invalid token'));
  socket.user = payload;
  next();
});

const onlineRooms = {};
function getRoomOnline(roomName) { const m = onlineRooms[roomName]; return m ? [...m.values()] : []; }

// ── Socket events ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const user = socket.user;
  console.log(`[+] ${user.username} connected`);

  db.prepare('SELECT conv_id FROM conv_members WHERE user_id = ?').all(user.id)
    .forEach(({ conv_id }) => socket.join(`conv_${conv_id}`));

  socket.emit('room_list',   getRoomList());
  socket.emit('conv_list',   getUserConvs(user.id));
  socket.emit('user_list',   db.prepare('SELECT id, username, color FROM users WHERE id != ? ORDER BY username ASC').all(user.id));
  socket.emit('friend_data', getFriendData(user.id));

  // Notify friends this user came online
  getFriendData(user.id).friends.forEach(f => {
    socketsForUser(f.id).forEach(s => s.emit('friend_online', { userId: user.id, username: user.username }));
  });

  socket.on('get_user_list', () => {
    socket.emit('user_list', db.prepare('SELECT id, username, color FROM users WHERE id != ? ORDER BY username ASC').all(user.id));
  });

  // ── Rooms ──
  socket.on('join_room', ({ room, password }) => {
    const roomRow = db.prepare('SELECT * FROM rooms WHERE name = ?').get(room);
    if (!roomRow) return;
    if (roomRow.is_private && roomRow.room_password) {
      if (!password || !bcrypt.compareSync(password, roomRow.room_password))
        return socket.emit('room_password_error', { room, error: 'Incorrect password.' });
    }
    if (socket.currentRoom) {
      const prev = socket.currentRoom;
      socket.leave(prev);
      if (onlineRooms[prev]) { onlineRooms[prev].delete(socket.id); if (!onlineRooms[prev].size) delete onlineRooms[prev]; }
      io.to(prev).emit('system_message', { text: `${user.username} left`, timestamp: Date.now() });
      io.to(prev).emit('room_online', getRoomOnline(prev));
    }
    socket.currentRoom = room;
    socket.join(room);
    if (!onlineRooms[room]) onlineRooms[room] = new Map();
    onlineRooms[room].set(socket.id, { username: user.username, color: user.color, userId: user.id });
    const msgs = db.prepare('SELECT m.id, m.username, m.color, m.text, m.created_at as timestamp FROM messages m WHERE m.room_id = ? ORDER BY m.created_at DESC LIMIT 100').all(roomRow.id).reverse();
    socket.emit('message_history', msgs);
    socket.emit('room_join_ok', { room });
    io.to(room).emit('system_message', { text: `${user.username} joined`, timestamp: Date.now() });
    io.to(room).emit('room_online', getRoomOnline(room));
    io.emit('room_list', getRoomList());
  });

  socket.on('send_message', ({ text }) => {
    if (!socket.currentRoom) return;
    const t = text?.trim().slice(0, 2000); if (!t) return;
    const roomRow = db.prepare('SELECT id FROM rooms WHERE name = ?').get(socket.currentRoom);
    if (!roomRow) return;
    const info = db.prepare('INSERT INTO messages (room_id, user_id, username, color, text) VALUES (?,?,?,?,?)').run(roomRow.id, user.id, user.username, user.color, t);
    io.to(socket.currentRoom).emit('new_message', { id: info.lastInsertRowid, username: user.username, color: user.color, text: t, timestamp: Math.floor(Date.now()/1000) });
    io.emit('room_list', getRoomList());
  });

  socket.on('create_room', ({ name, description, isPrivate, password }) => {
    const n = name?.trim().toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,30);
    if (!n || n.length < 2) return socket.emit('room_error', 'Room name must be 2+ letters/numbers.');
    if (db.prepare('SELECT id FROM rooms WHERE name = ?').get(n)) return socket.emit('room_error', 'Room already exists.');
    const d = (description||'').trim().slice(0,100), priv = isPrivate ? 1 : 0;
    if (isPrivate && !password?.trim()) return socket.emit('room_error', 'Private rooms need a password.');
    const pwHash = (isPrivate && password?.trim()) ? bcrypt.hashSync(password.slice(0,100), 10) : null;
    db.prepare('INSERT INTO rooms (name, description, type, is_private, room_password, created_by) VALUES (?,?,?,?,?,?)').run(n, d, 'user', priv, pwHash, user.id);
    io.emit('room_list', getRoomList());
    socket.emit('room_created', { name: n, password: isPrivate ? password : null });
  });

  socket.on('delete_room', ({ name }) => {
    const room = db.prepare('SELECT * FROM rooms WHERE name = ?').get(name);
    if (!room) return socket.emit('room_error', 'Room not found.');
    if (room.type === 'community') return socket.emit('room_error', 'Cannot delete community rooms.');
    if (room.created_by !== user.id) return socket.emit('room_error', 'You can only delete rooms you created.');
    if (onlineRooms[name]) { io.to(name).emit('room_deleted', { name }); delete onlineRooms[name]; }
    db.prepare('DELETE FROM messages WHERE room_id = ?').run(room.id);
    db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
    io.emit('room_list', getRoomList());
  });

  socket.on('typing', () => { if (socket.currentRoom) socket.to(socket.currentRoom).emit('user_typing', { username: user.username }); });

  // ── DMs ──
  socket.on('start_dm', ({ userId }) => {
    const target = db.prepare('SELECT id, username, color FROM users WHERE id = ?').get(Number(userId));
    if (!target || target.id === user.id) return;
    const existing = db.prepare(`SELECT c.id FROM conversations c JOIN conv_members cm1 ON cm1.conv_id=c.id AND cm1.user_id=? JOIN conv_members cm2 ON cm2.conv_id=c.id AND cm2.user_id=? WHERE c.type='dm' AND (SELECT COUNT(*) FROM conv_members WHERE conv_id=c.id)=2`).get(user.id, target.id);
    if (existing) { socket.emit('conv_list', getUserConvs(user.id)); socket.emit('open_conv', { convId: existing.id }); return; }
    const info = db.prepare('INSERT INTO conversations (type, created_by) VALUES (?,?)').run('dm', user.id);
    const convId = info.lastInsertRowid;
    db.prepare('INSERT INTO conv_members (conv_id, user_id) VALUES (?,?)').run(convId, user.id);
    db.prepare('INSERT INTO conv_members (conv_id, user_id) VALUES (?,?)').run(convId, target.id);
    socket.join(`conv_${convId}`);
    socketsForUser(target.id).forEach(s => { s.join(`conv_${convId}`); s.emit('conv_list', getUserConvs(target.id)); });
    socket.emit('conv_list', getUserConvs(user.id));
    socket.emit('open_conv', { convId });
  });

  socket.on('create_group_dm', ({ name, userIds }) => {
    if (!Array.isArray(userIds) || !userIds.length) return socket.emit('dm_error', 'Select at least one person.');
    const allIds = [...new Set([user.id, ...userIds.map(Number)])].filter(id => db.prepare('SELECT 1 FROM users WHERE id=?').get(id));
    if (allIds.length < 2) return socket.emit('dm_error', 'Select at least one valid user.');
    const info = db.prepare('INSERT INTO conversations (type, name, created_by) VALUES (?,?,?)').run('group', name?.trim().slice(0,50)||null, user.id);
    const convId = info.lastInsertRowid;
    allIds.forEach(uid => {
      db.prepare('INSERT INTO conv_members (conv_id, user_id) VALUES (?,?)').run(convId, uid);
      socketsForUser(uid).forEach(s => { s.join(`conv_${convId}`); s.emit('conv_list', getUserConvs(uid)); });
    });
    socket.emit('open_conv', { convId });
  });

  socket.on('join_conv', ({ convId }) => {
    if (!db.prepare('SELECT 1 FROM conv_members WHERE conv_id=? AND user_id=?').get(convId, user.id)) return;
    socket.currentConv = convId;
    const msgs = db.prepare('SELECT id, username, color, text, created_at as timestamp FROM conv_messages WHERE conv_id=? ORDER BY created_at DESC LIMIT 100').all(convId).reverse();
    socket.emit('dm_history', { convId, messages: msgs });
  });

  socket.on('send_dm', ({ text }) => {
    if (!socket.currentConv) return;
    const t = text?.trim().slice(0, 2000); if (!t) return;
    if (!db.prepare('SELECT 1 FROM conv_members WHERE conv_id=? AND user_id=?').get(socket.currentConv, user.id)) return;
    const info = db.prepare('INSERT INTO conv_messages (conv_id, user_id, username, color, text) VALUES (?,?,?,?,?)').run(socket.currentConv, user.id, user.username, user.color, t);
    const msg = { id: info.lastInsertRowid, username: user.username, color: user.color, text: t, timestamp: Math.floor(Date.now()/1000) };
    io.to(`conv_${socket.currentConv}`).emit('new_dm', { convId: socket.currentConv, message: msg });
    db.prepare('SELECT user_id FROM conv_members WHERE conv_id=?').all(socket.currentConv)
      .forEach(({ user_id }) => socketsForUser(user_id).forEach(s => s.emit('conv_list', getUserConvs(user_id))));
  });

  socket.on('dm_typing', () => { if (socket.currentConv) socket.to(`conv_${socket.currentConv}`).emit('dm_user_typing', { convId: socket.currentConv, username: user.username }); });

  // ── Friends ──
  socket.on('send_friend_request', ({ toUserId }) => {
    const target = db.prepare('SELECT id, username FROM users WHERE id=?').get(Number(toUserId));
    if (!target || target.id === user.id) return;
    if (db.prepare('SELECT 1 FROM friends WHERE user_id=? AND friend_id=?').get(user.id, target.id)) return;
    // If they already sent us one, auto-accept
    const theirReq = db.prepare('SELECT 1 FROM friend_requests WHERE from_id=? AND to_id=?').get(target.id, user.id);
    if (theirReq) {
      db.prepare('DELETE FROM friend_requests WHERE from_id=? AND to_id=?').run(target.id, user.id);
      db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?,?)').run(user.id, target.id);
      db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?,?)').run(target.id, user.id);
      socket.emit('friend_data', getFriendData(user.id));
      socketsForUser(target.id).forEach(s => { s.emit('friend_data', getFriendData(target.id)); s.emit('friend_notify', { type: 'accepted', username: user.username }); });
      return;
    }
    try { db.prepare('INSERT INTO friend_requests (from_id, to_id) VALUES (?,?)').run(user.id, target.id); } catch {}
    socket.emit('friend_data', getFriendData(user.id));
    socketsForUser(target.id).forEach(s => { s.emit('friend_data', getFriendData(target.id)); s.emit('friend_notify', { type: 'request', username: user.username, fromId: user.id }); });
  });

  socket.on('accept_friend_request', ({ fromUserId }) => {
    const from = db.prepare('SELECT id, username FROM users WHERE id=?').get(Number(fromUserId));
    if (!from) return;
    const req = db.prepare('SELECT 1 FROM friend_requests WHERE from_id=? AND to_id=?').get(from.id, user.id);
    if (!req) return;
    db.prepare('DELETE FROM friend_requests WHERE from_id=? AND to_id=?').run(from.id, user.id);
    db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?,?)').run(user.id, from.id);
    db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?,?)').run(from.id, user.id);
    socket.emit('friend_data', getFriendData(user.id));
    socketsForUser(from.id).forEach(s => { s.emit('friend_data', getFriendData(from.id)); s.emit('friend_notify', { type: 'accepted', username: user.username }); });
  });

  socket.on('decline_friend_request', ({ fromUserId }) => {
    db.prepare('DELETE FROM friend_requests WHERE from_id=? AND to_id=?').run(Number(fromUserId), user.id);
    socket.emit('friend_data', getFriendData(user.id));
  });

  socket.on('remove_friend', ({ userId: fid }) => {
    db.prepare('DELETE FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)').run(user.id, Number(fid), Number(fid), user.id);
    socket.emit('friend_data', getFriendData(user.id));
    socketsForUser(Number(fid)).forEach(s => s.emit('friend_data', getFriendData(Number(fid))));
  });

  socket.on('cancel_friend_request', ({ toUserId }) => {
    db.prepare('DELETE FROM friend_requests WHERE from_id=? AND to_id=?').run(user.id, Number(toUserId));
    socket.emit('friend_data', getFriendData(user.id));
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${user.username} disconnected`);
    if (socket.currentRoom) {
      const r = socket.currentRoom;
      if (onlineRooms[r]) { onlineRooms[r].delete(socket.id); if (!onlineRooms[r].size) delete onlineRooms[r]; }
      io.to(r).emit('system_message', { text: `${user.username} disconnected`, timestamp: Date.now() });
      io.to(r).emit('room_online', getRoomOnline(r));
    }
    io.emit('room_list', getRoomList());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`HushLine running on port ${PORT}`));
