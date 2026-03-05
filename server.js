const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { Pool }   = require('pg');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'hushline-dev-secret-change-me';

// ── Database ───────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  // Users
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL  PRIMARY KEY,
      username   TEXT    NOT NULL,
      password   TEXT    NOT NULL,
      color      TEXT    NOT NULL DEFAULT '#D4860A',
      created_at INTEGER NOT NULL DEFAULT floor(extract(epoch from now()))::integer
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (LOWER(username))
  `);

  // Rooms
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id            SERIAL  PRIMARY KEY,
      name          TEXT    NOT NULL,
      description   TEXT    NOT NULL DEFAULT '',
      type          TEXT    NOT NULL DEFAULT 'community',
      is_private    INTEGER NOT NULL DEFAULT 0,
      room_password TEXT,
      created_by    INTEGER REFERENCES users(id),
      created_at    INTEGER NOT NULL DEFAULT floor(extract(epoch from now()))::integer
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_name ON rooms (LOWER(name))
  `);

  // Messages
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL  PRIMARY KEY,
      room_id    INTEGER NOT NULL REFERENCES rooms(id),
      user_id    INTEGER NOT NULL REFERENCES users(id),
      username   TEXT    NOT NULL,
      color      TEXT    NOT NULL,
      text       TEXT    NOT NULL,
      created_at INTEGER NOT NULL DEFAULT floor(extract(epoch from now()))::integer
    )
  `);

  // Conversations
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id         SERIAL  PRIMARY KEY,
      type       TEXT    NOT NULL DEFAULT 'dm',
      name       TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL DEFAULT floor(extract(epoch from now()))::integer
    )
  `);

  // Conversation members
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conv_members (
      conv_id INTEGER NOT NULL REFERENCES conversations(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (conv_id, user_id)
    )
  `);

  // Conversation messages
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conv_messages (
      id         SERIAL  PRIMARY KEY,
      conv_id    INTEGER NOT NULL REFERENCES conversations(id),
      user_id    INTEGER NOT NULL REFERENCES users(id),
      username   TEXT    NOT NULL,
      color      TEXT    NOT NULL,
      text       TEXT    NOT NULL,
      created_at INTEGER NOT NULL DEFAULT floor(extract(epoch from now()))::integer
    )
  `);

  // Friends
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friends (
      user_id    INTEGER NOT NULL REFERENCES users(id),
      friend_id  INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL DEFAULT floor(extract(epoch from now()))::integer,
      PRIMARY KEY (user_id, friend_id)
    )
  `);

  // Friend requests
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id         SERIAL  PRIMARY KEY,
      from_id    INTEGER NOT NULL REFERENCES users(id),
      to_id      INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL DEFAULT floor(extract(epoch from now()))::integer,
      UNIQUE (from_id, to_id)
    )
  `);

  // Indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_conv_messages ON conv_messages(conv_id, created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_conv_members  ON conv_members(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_friends       ON friends(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_freq_to       ON friend_requests(to_id)`);

  // Seed default community room
  await pool.query(`
    INSERT INTO rooms (name, description, type)
    VALUES ('general', 'Main hangout for everyone', 'community')
    ON CONFLICT DO NOTHING
  `);

  console.log('Database ready');
}

// ── Helpers ────────────────────────────────────────────────────────────────
const COLORS = ['#FF6B6B','#4ECDC4','#FFE66D','#A8E6CF','#FF8B94','#FFA502','#7BED9F','#70A1FF','#FF6348','#ECCC68','#5352ED','#2ED573','#1E90FF','#FF6B81','#C56CF0','#F8A5C2','#63CDDA','#EA8685'];
function randomColor() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }
function makeToken(u) { return jwt.sign({ id: u.id, username: u.username, color: u.color }, JWT_SECRET, { expiresIn: '30d' }); }
function verifyToken(t) { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } }
function socketsForUser(uid) { return [...io.sockets.sockets.values()].filter(s => s.user?.id === uid); }

const onlineRooms = {};
function getRoomOnline(roomName) { const m = onlineRooms[roomName]; return m ? [...m.values()] : []; }

async function getRoomList() {
  const { rows: rooms } = await pool.query(
    'SELECT id, name, description, type, is_private, created_by FROM rooms ORDER BY type ASC, name ASC'
  );
  return Promise.all(rooms.map(async r => {
    const { rows: [last] } = await pool.query(
      'SELECT username, color, text, created_at FROM messages WHERE room_id=$1 ORDER BY created_at DESC LIMIT 1',
      [r.id]
    );
    const onlineCount = onlineRooms[r.name] ? onlineRooms[r.name].size : 0;
    return { ...r, onlineCount, lastMessage: last || null };
  }));
}

async function getUserConvs(userId) {
  const { rows: convs } = await pool.query(`
    SELECT c.id, c.type, c.name, c.created_by FROM conversations c
    JOIN conv_members cm ON cm.conv_id = c.id AND cm.user_id = $1
    ORDER BY (
      SELECT created_at FROM conv_messages WHERE conv_id = c.id ORDER BY created_at DESC LIMIT 1
    ) DESC NULLS LAST, c.created_at DESC
  `, [userId]);
  return Promise.all(convs.map(async c => {
    const [{ rows: members }, { rows: [lastMessage] }] = await Promise.all([
      pool.query('SELECT u.id, u.username, u.color FROM conv_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conv_id = $1', [c.id]),
      pool.query('SELECT username, text, created_at FROM conv_messages WHERE conv_id = $1 ORDER BY created_at DESC LIMIT 1', [c.id]),
    ]);
    return { ...c, members, lastMessage: lastMessage || null };
  }));
}

async function getFriendData(userId) {
  const [{ rows: friends }, { rows: sent }, { rows: received }] = await Promise.all([
    pool.query('SELECT u.id, u.username, u.color FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = $1 ORDER BY u.username', [userId]),
    pool.query('SELECT u.id, u.username, u.color FROM friend_requests fr JOIN users u ON u.id = fr.to_id WHERE fr.from_id = $1', [userId]),
    pool.query('SELECT u.id, u.username, u.color FROM friend_requests fr JOIN users u ON u.id = fr.from_id WHERE fr.to_id = $1', [userId]),
  ]);
  return { friends, sent, received };
}

async function getRelationship(meId, theirId) {
  const [{ rows: [r1] }, { rows: [r2] }, { rows: [r3] }] = await Promise.all([
    pool.query('SELECT 1 FROM friends WHERE user_id=$1 AND friend_id=$2', [meId, theirId]),
    pool.query('SELECT 1 FROM friend_requests WHERE from_id=$1 AND to_id=$2', [meId, theirId]),
    pool.query('SELECT 1 FROM friend_requests WHERE from_id=$1 AND to_id=$2', [theirId, meId]),
  ]);
  return { isFriend: !!r1, iSent: !!r2, theySent: !!r3 };
}

// ── Rate limiting ─────────────────────────────────────────────────────────
const lastMsgTime = {}; // userId -> timestamp
const MSG_COOLDOWN = 300; // ms

function checkRateLimit(userId) {
  const now = Date.now();
  if (lastMsgTime[userId] && now - lastMsgTime[userId] < MSG_COOLDOWN) return false;
  lastMsgTime[userId] = now;
  return true;
}

// Wraps async socket handlers to catch and log unhandled errors
function ah(fn) {
  return function(...args) {
    fn.apply(this, args).catch(err => console.error('Socket error:', err));
  };
}

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: Math.floor(process.uptime()) }));

// ── Auth REST ──────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
    const u = username.trim().slice(0, 30);
    if (u.length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters.' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });
    if (!/^[a-zA-Z0-9_.\-]+$/.test(u)) return res.status(400).json({ error: 'Username can only contain letters, numbers, _ . -' });
    const { rows: [existing] } = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [u]);
    if (existing) return res.status(409).json({ error: 'That username is taken.' });
    const hash = await bcrypt.hash(password, 10);
    const color = randomColor();
    const { rows: [{ id }] } = await pool.query(
      'INSERT INTO users (username, password, color) VALUES ($1, $2, $3) RETURNING id',
      [u, hash, color]
    );
    const user = { id, username: u, color };
    res.json({ token: makeToken(user), user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username.trim()]);
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid username or password.' });
    res.json({ token: makeToken(user), user: { id: user.id, username: user.username, color: user.color } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.get('/api/profile/:username', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const me = verifyToken(token);
    if (!me) return res.status(401).json({ error: 'Not authenticated.' });
    const { rows: [user] } = await pool.query(
      'SELECT id, username, color, created_at FROM users WHERE LOWER(username) = LOWER($1)',
      [req.params.username]
    );
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const [rel, { rows: [fc] }] = await Promise.all([
      getRelationship(me.id, user.id),
      pool.query('SELECT COUNT(*) as c FROM friends WHERE user_id = $1', [user.id]),
    ]);
    res.json({ ...user, ...rel, friendCount: parseInt(fc.c), isSelf: me.id === user.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error.' });
  }
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

// ── Socket init (async setup on connect) ──────────────────────────────────
async function initSocket(socket, user) {
  const { rows: memberships } = await pool.query(
    'SELECT conv_id FROM conv_members WHERE user_id = $1', [user.id]
  );
  memberships.forEach(({ conv_id }) => socket.join(`conv_${conv_id}`));

  const [roomList, convList, { rows: userList }, fd] = await Promise.all([
    getRoomList(),
    getUserConvs(user.id),
    pool.query('SELECT id, username, color FROM users WHERE id != $1 ORDER BY username ASC', [user.id]),
    getFriendData(user.id),
  ]);

  socket.emit('room_list',   roomList);
  socket.emit('conv_list',   convList);
  socket.emit('user_list',   userList);
  socket.emit('friend_data', fd);

  fd.friends.forEach(f => {
    socketsForUser(f.id).forEach(s => s.emit('friend_online', { userId: user.id, username: user.username }));
  });
}

// ── Socket events ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const user = socket.user;
  console.log(`[+] ${user.username} connected`);

  // Register all event handlers first (synchronous), then do async init
  socket.on('get_user_list', ah(async () => {
    const { rows } = await pool.query('SELECT id, username, color FROM users WHERE id != $1 ORDER BY username ASC', [user.id]);
    socket.emit('user_list', rows);
  }));

  // ── Rooms ──
  socket.on('join_room', ah(async ({ room, password }) => {
    const { rows: [roomRow] } = await pool.query('SELECT * FROM rooms WHERE LOWER(name) = LOWER($1)', [room]);
    if (!roomRow) return;
    if (roomRow.is_private && roomRow.room_password) {
      if (!password || !(await bcrypt.compare(password, roomRow.room_password)))
        return socket.emit('room_password_error', { room, error: 'Incorrect password.' });
    }
    if (socket.currentRoom) {
      const prev = socket.currentRoom;
      socket.leave(prev);
      if (onlineRooms[prev]) { onlineRooms[prev].delete(socket.id); if (!onlineRooms[prev].size) delete onlineRooms[prev]; }
      io.to(prev).emit('system_message', { text: `${user.username} left`, timestamp: Date.now() });
      io.to(prev).emit('room_online', getRoomOnline(prev));
    }
    socket.currentRoom = roomRow.name;
    socket.join(roomRow.name);
    if (!onlineRooms[roomRow.name]) onlineRooms[roomRow.name] = new Map();
    onlineRooms[roomRow.name].set(socket.id, { username: user.username, color: user.color, userId: user.id });
    const { rows: msgs } = await pool.query(
      'SELECT id, username, color, text, created_at as timestamp FROM messages WHERE room_id=$1 ORDER BY created_at DESC LIMIT 100',
      [roomRow.id]
    );
    socket.emit('message_history', msgs.reverse());
    socket.emit('room_join_ok', { room: roomRow.name });
    io.to(roomRow.name).emit('system_message', { text: `${user.username} joined`, timestamp: Date.now() });
    io.to(roomRow.name).emit('room_online', getRoomOnline(roomRow.name));
    io.emit('room_list', await getRoomList());
  }));

  socket.on('send_message', ah(async ({ text }) => {
    if (!socket.currentRoom) return;
    if (!checkRateLimit(user.id)) return;
    const t = text?.trim().slice(0, 2000); if (!t) return;
    const { rows: [roomRow] } = await pool.query('SELECT id FROM rooms WHERE LOWER(name) = LOWER($1)', [socket.currentRoom]);
    if (!roomRow) return;
    const { rows: [{ id }] } = await pool.query(
      'INSERT INTO messages (room_id, user_id, username, color, text) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [roomRow.id, user.id, user.username, user.color, t]
    );
    io.to(socket.currentRoom).emit('new_message', { id, username: user.username, color: user.color, text: t, timestamp: Math.floor(Date.now() / 1000) });
    io.emit('room_list', await getRoomList());
  }));

  socket.on('create_room', ah(async ({ name, description, isPrivate, password }) => {
    const n = name?.trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
    if (!n || n.length < 2) return socket.emit('room_error', 'Room name must be 2+ letters/numbers.');
    const { rows: [existing] } = await pool.query('SELECT id FROM rooms WHERE LOWER(name) = LOWER($1)', [n]);
    if (existing) return socket.emit('room_error', 'Room already exists.');
    const d = (description || '').trim().slice(0, 100);
    if (isPrivate && !password?.trim()) return socket.emit('room_error', 'Private rooms need a password.');
    const pwHash = (isPrivate && password?.trim()) ? await bcrypt.hash(password.slice(0, 100), 10) : null;
    await pool.query(
      'INSERT INTO rooms (name, description, type, is_private, room_password, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
      [n, d, 'user', isPrivate ? 1 : 0, pwHash, user.id]
    );
    io.emit('room_list', await getRoomList());
    socket.emit('room_created', { name: n, password: isPrivate ? password : null });
  }));

  socket.on('delete_room', ah(async ({ name }) => {
    const { rows: [room] } = await pool.query('SELECT * FROM rooms WHERE LOWER(name) = LOWER($1)', [name]);
    if (!room) return socket.emit('room_error', 'Room not found.');
    if (room.type === 'community') return socket.emit('room_error', 'Cannot delete community rooms.');
    if (room.created_by !== user.id) return socket.emit('room_error', 'You can only delete rooms you created.');
    if (onlineRooms[room.name]) { io.to(room.name).emit('room_deleted', { name: room.name }); delete onlineRooms[room.name]; }
    await pool.query('DELETE FROM messages WHERE room_id = $1', [room.id]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [room.id]);
    io.emit('room_list', await getRoomList());
  }));

  socket.on('typing', () => {
    if (socket.currentRoom) socket.to(socket.currentRoom).emit('user_typing', { username: user.username });
  });

  // ── DMs ──
  socket.on('start_dm', ah(async ({ userId }) => {
    const { rows: [target] } = await pool.query('SELECT id, username, color FROM users WHERE id = $1', [Number(userId)]);
    if (!target || target.id === user.id) return;
    const { rows: [existing] } = await pool.query(`
      SELECT c.id FROM conversations c
      JOIN conv_members cm1 ON cm1.conv_id = c.id AND cm1.user_id = $1
      JOIN conv_members cm2 ON cm2.conv_id = c.id AND cm2.user_id = $2
      WHERE c.type = 'dm' AND (SELECT COUNT(*) FROM conv_members WHERE conv_id = c.id) = 2
    `, [user.id, target.id]);
    if (existing) {
      socket.emit('conv_list', await getUserConvs(user.id));
      socket.emit('open_conv', { convId: existing.id });
      return;
    }
    const { rows: [{ id: convId }] } = await pool.query(
      'INSERT INTO conversations (type, created_by) VALUES ($1, $2) RETURNING id',
      ['dm', user.id]
    );
    await pool.query('INSERT INTO conv_members (conv_id, user_id) VALUES ($1, $2)', [convId, user.id]);
    await pool.query('INSERT INTO conv_members (conv_id, user_id) VALUES ($1, $2)', [convId, target.id]);
    socket.join(`conv_${convId}`);
    const targetConvs = await getUserConvs(target.id);
    socketsForUser(target.id).forEach(s => { s.join(`conv_${convId}`); s.emit('conv_list', targetConvs); });
    socket.emit('conv_list', await getUserConvs(user.id));
    socket.emit('open_conv', { convId });
  }));

  socket.on('create_group_dm', ah(async ({ name, userIds }) => {
    if (!Array.isArray(userIds) || !userIds.length) return socket.emit('dm_error', 'Select at least one person.');
    const allIdsRaw = [...new Set([user.id, ...userIds.map(Number)])];
    const checks = await Promise.all(allIdsRaw.map(id => pool.query('SELECT 1 FROM users WHERE id=$1', [id])));
    const allIds = allIdsRaw.filter((_, i) => checks[i].rows.length > 0);
    if (allIds.length < 2) return socket.emit('dm_error', 'Select at least one valid user.');
    const { rows: [{ id: convId }] } = await pool.query(
      'INSERT INTO conversations (type, name, created_by) VALUES ($1, $2, $3) RETURNING id',
      ['group', name?.trim().slice(0, 50) || null, user.id]
    );
    for (const uid of allIds) {
      await pool.query('INSERT INTO conv_members (conv_id, user_id) VALUES ($1, $2)', [convId, uid]);
      const convList = await getUserConvs(uid);
      socketsForUser(uid).forEach(s => { s.join(`conv_${convId}`); s.emit('conv_list', convList); });
    }
    socket.emit('open_conv', { convId });
  }));

  socket.on('join_conv', ah(async ({ convId }) => {
    const { rows: [member] } = await pool.query('SELECT 1 FROM conv_members WHERE conv_id=$1 AND user_id=$2', [convId, user.id]);
    if (!member) return;
    socket.currentConv = convId;
    const { rows: msgs } = await pool.query(
      'SELECT id, username, color, text, created_at as timestamp FROM conv_messages WHERE conv_id=$1 ORDER BY created_at DESC LIMIT 100',
      [convId]
    );
    socket.emit('dm_history', { convId, messages: msgs.reverse() });
  }));

  socket.on('send_dm', ah(async ({ text }) => {
    if (!socket.currentConv) return;
    if (!checkRateLimit(user.id)) return;
    const t = text?.trim().slice(0, 2000); if (!t) return;
    const { rows: [member] } = await pool.query('SELECT 1 FROM conv_members WHERE conv_id=$1 AND user_id=$2', [socket.currentConv, user.id]);
    if (!member) return;
    const { rows: [{ id }] } = await pool.query(
      'INSERT INTO conv_messages (conv_id, user_id, username, color, text) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [socket.currentConv, user.id, user.username, user.color, t]
    );
    const msg = { id, username: user.username, color: user.color, text: t, timestamp: Math.floor(Date.now() / 1000) };
    io.to(`conv_${socket.currentConv}`).emit('new_dm', { convId: socket.currentConv, message: msg });
    const { rows: members } = await pool.query('SELECT user_id FROM conv_members WHERE conv_id=$1', [socket.currentConv]);
    for (const { user_id } of members) {
      const convList = await getUserConvs(user_id);
      socketsForUser(user_id).forEach(s => s.emit('conv_list', convList));
    }
  }));

  socket.on('dm_typing', () => {
    if (socket.currentConv) socket.to(`conv_${socket.currentConv}`).emit('dm_user_typing', { convId: socket.currentConv, username: user.username });
  });

  // ── Friends ──
  socket.on('send_friend_request', ah(async ({ toUserId }) => {
    const { rows: [target] } = await pool.query('SELECT id, username FROM users WHERE id=$1', [Number(toUserId)]);
    if (!target || target.id === user.id) return;
    const { rows: [alreadyFriends] } = await pool.query('SELECT 1 FROM friends WHERE user_id=$1 AND friend_id=$2', [user.id, target.id]);
    if (alreadyFriends) return;
    const { rows: [theirReq] } = await pool.query('SELECT 1 FROM friend_requests WHERE from_id=$1 AND to_id=$2', [target.id, user.id]);
    if (theirReq) {
      await pool.query('DELETE FROM friend_requests WHERE from_id=$1 AND to_id=$2', [target.id, user.id]);
      await pool.query('INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, target.id]);
      await pool.query('INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [target.id, user.id]);
      socket.emit('friend_data', await getFriendData(user.id));
      const targetFd = await getFriendData(target.id);
      socketsForUser(target.id).forEach(s => { s.emit('friend_data', targetFd); s.emit('friend_notify', { type: 'accepted', username: user.username }); });
      return;
    }
    try { await pool.query('INSERT INTO friend_requests (from_id, to_id) VALUES ($1, $2)', [user.id, target.id]); } catch {}
    socket.emit('friend_data', await getFriendData(user.id));
    const targetFd = await getFriendData(target.id);
    socketsForUser(target.id).forEach(s => { s.emit('friend_data', targetFd); s.emit('friend_notify', { type: 'request', username: user.username, fromId: user.id }); });
  }));

  socket.on('accept_friend_request', ah(async ({ fromUserId }) => {
    const { rows: [from] } = await pool.query('SELECT id, username FROM users WHERE id=$1', [Number(fromUserId)]);
    if (!from) return;
    const { rows: [req] } = await pool.query('SELECT 1 FROM friend_requests WHERE from_id=$1 AND to_id=$2', [from.id, user.id]);
    if (!req) return;
    await pool.query('DELETE FROM friend_requests WHERE from_id=$1 AND to_id=$2', [from.id, user.id]);
    await pool.query('INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, from.id]);
    await pool.query('INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [from.id, user.id]);
    socket.emit('friend_data', await getFriendData(user.id));
    const fromFd = await getFriendData(from.id);
    socketsForUser(from.id).forEach(s => { s.emit('friend_data', fromFd); s.emit('friend_notify', { type: 'accepted', username: user.username }); });
  }));

  socket.on('decline_friend_request', ah(async ({ fromUserId }) => {
    await pool.query('DELETE FROM friend_requests WHERE from_id=$1 AND to_id=$2', [Number(fromUserId), user.id]);
    socket.emit('friend_data', await getFriendData(user.id));
  }));

  socket.on('remove_friend', ah(async ({ userId: fid }) => {
    await pool.query(
      'DELETE FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$3 AND friend_id=$4)',
      [user.id, Number(fid), Number(fid), user.id]
    );
    socket.emit('friend_data', await getFriendData(user.id));
    const fidFd = await getFriendData(Number(fid));
    socketsForUser(Number(fid)).forEach(s => s.emit('friend_data', fidFd));
  }));

  socket.on('cancel_friend_request', ah(async ({ toUserId }) => {
    await pool.query('DELETE FROM friend_requests WHERE from_id=$1 AND to_id=$2', [user.id, Number(toUserId)]);
    socket.emit('friend_data', await getFriendData(user.id));
  }));

  socket.on('disconnect', ah(async () => {
    console.log(`[-] ${user.username} disconnected`);
    if (socket.currentRoom) {
      const r = socket.currentRoom;
      if (onlineRooms[r]) { onlineRooms[r].delete(socket.id); if (!onlineRooms[r].size) delete onlineRooms[r]; }
      io.to(r).emit('system_message', { text: `${user.username} disconnected`, timestamp: Date.now() });
      io.to(r).emit('room_online', getRoomOnline(r));
    }
    io.emit('room_list', await getRoomList());
  }));

  // Run async init after handlers are registered
  initSocket(socket, user).catch(err => console.error('Socket init error:', err));
});

const PORT = process.env.PORT || 3000;
initDB()
  .then(() => server.listen(PORT, () => console.log(`HushLine running on port ${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });