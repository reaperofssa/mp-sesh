const { Telegraf } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const http = require('http');
const WebSocket = require('ws');

const BOT_TOKEN = '7069823048:AAFeeFtSj_cbEiuSZm8uImysJIKrcYHlg4A';
const bot = new Telegraf(BOT_TOKEN);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Songs folder
const SONGS_DIR = path.join(__dirname, 'songs');
if (!fs.existsSync(SONGS_DIR)) fs.mkdirSync(SONGS_DIR);

// Memory storage
// streams[streamId] = { queue, currentIndex, songStartTime, clients:Set(ws), users:Map(userId -> {id, name, joinedAt}) }
const streams = {};

app.use(express.static('public'));
app.use('/songs', express.static(SONGS_DIR));
app.use(express.json()); // Add JSON parsing middleware

// Serve player
app.get('/stream/:streamId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stream.html'));
});

// 👥 User joined stream
app.post('/joined/:streamId', (req, res) => {
  const { streamId } = req.params;
  const { name, id } = req.body;

  // Validate input
  if (!name || !id) {
    return res.status(400).json({ error: 'Name and id are required' });
  }

  // Check if stream exists
  const stream = streams[streamId];
  if (!stream) {
    return res.status(404).json({ error: 'Stream not found' });
  }

  // Initialize users Map if it doesn't exist
  if (!stream.users) {
    stream.users = new Map();
  }

  // Add user to stream
  stream.users.set(id, {
    id,
    name,
    joinedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString()
  });

  // Broadcast user joined to all clients
  broadcastUserUpdate(streamId, 'user_joined', { id, name });

  res.json({ 
    success: true, 
    message: `User ${name} joined stream ${streamId}`,
    totalUsers: stream.users.size
  });
});

// 👤 User left stream
app.post('/left/:streamId', (req, res) => {
  const { streamId } = req.params;
  const { id } = req.body;

  // Validate input
  if (!id) {
    return res.status(400).json({ error: 'User id is required' });
  }

  // Check if stream exists
  const stream = streams[streamId];
  if (!stream) {
    return res.status(404).json({ error: 'Stream not found' });
  }

  // Initialize users Map if it doesn't exist
  if (!stream.users) {
    stream.users = new Map();
  }

  // Check if user exists in stream
  const user = stream.users.get(id);
  if (!user) {
    return res.status(404).json({ error: 'User not found in stream' });
  }

  // Remove user from stream
  stream.users.delete(id);

  // Broadcast user left to all clients
  broadcastUserUpdate(streamId, 'user_left', { id, name: user.name });

  res.json({ 
    success: true, 
    message: `User ${user.name} left stream ${streamId}`,
    totalUsers: stream.users.size
  });
});

// 📋 List all users in stream
app.get('/list/:streamId', (req, res) => {
  const { streamId } = req.params;

  // Check if stream exists
  const stream = streams[streamId];
  if (!stream) {
    return res.status(404).json({ error: 'Stream not found' });
  }

  // Initialize users Map if it doesn't exist
  if (!stream.users) {
    stream.users = new Map();
  }

  // Convert Map to array for JSON response
  const users = Array.from(stream.users.values());

  res.json({
    streamId,
    totalUsers: users.length,
    users: users
  });
});

// 💓 Heartbeat endpoint
app.post('/heartbeat/:streamId', (req, res) => {
  const { streamId } = req.params;
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const stream = streams[streamId];
  if (!stream) {
    return res.status(404).json({ error: 'Stream not found' });
  }

  // Initialize users Map if it doesn't exist
  if (!stream.users) {
    stream.users = new Map();
  }

  // Update user's last heartbeat
  const user = stream.users.get(userId);
  if (user) {
    user.lastHeartbeat = new Date().toISOString();
    res.json({ success: true, message: 'Heartbeat updated' });
  } else {
    res.status(404).json({ error: 'User not found in stream' });
  }
});

// Clean up inactive users (no heartbeat for 30 seconds)
setInterval(() => {
  const now = new Date();
  for (const streamId in streams) {
    const stream = streams[streamId];
    if (!stream.users) continue;

    const usersToRemove = [];
    for (const [userId, user] of stream.users) {
      const lastHeartbeat = new Date(user.lastHeartbeat || user.joinedAt);
      const timeSinceHeartbeat = (now - lastHeartbeat) / 1000;
      
      if (timeSinceHeartbeat > 30) { // 30 seconds timeout
        usersToRemove.push({ userId, user });
      }
    }

    // Remove inactive users
    for (const { userId, user } of usersToRemove) {
      stream.users.delete(userId);
      broadcastUserUpdate(streamId, 'user_left', { id: userId, name: user.name, reason: 'timeout' });
    }
  }
}, 15000); // Check every 15 seconds

// Broadcast user updates to WebSocket clients
function broadcastUserUpdate(streamId, type, userData) {
  const stream = streams[streamId];
  if (!stream) return;

  const payload = {
    type,
    data: userData,
    timestamp: new Date().toISOString()
  };

  for (const client of stream.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }
}

// WebSocket for real-time sync
wss.on('connection', (ws, req) => {
  const urlParts = req.url.split('/');
  const streamId = urlParts[urlParts.length - 1];

  const stream = streams[streamId];
  if (!stream) {
    ws.send(JSON.stringify({ type: 'error', message: 'Stream not found' }));
    ws.close();
    return;
  }

  // Save client
  stream.clients.add(ws);

  // Send initial state
  sendStreamUpdate(streamId);

  ws.on('close', () => {
    stream.clients.delete(ws);
  });
});

// Broadcast helper
function sendStreamUpdate(streamId) {
  const stream = streams[streamId];
  if (!stream) return;

  const now = Date.now();
  const current = stream.queue[stream.currentIndex];
  const elapsed = (now - stream.songStartTime) / 1000;

  const nextIndex = (stream.currentIndex + 1) % stream.queue.length;
  const nextSong = stream.queue[nextIndex];

  const payload = {
    type: 'update',
    elapsed,
    currentIndex: stream.currentIndex,
    current: {
      file: `/songs/${current.fileName}`,
      meta: current.meta
    },
    next: nextSong
      ? { file: `/songs/${nextSong.fileName}`, meta: nextSong.meta }
      : null,
    queue: stream.queue
  };

  for (const client of stream.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }
}

// Audio metadata
function getAudioMeta(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve({
        duration: metadata.format.duration,
        size: metadata.format.size,
        bit_rate: metadata.format.bit_rate
      });
    });
  });
}

// 🎵 Start stream
bot.command('stream', async (ctx) => {
  const query = ctx.message.text.split(' ').slice(1).join(' ');
  if (!query) return ctx.reply('Usage: /stream <song name>');

  try {
    const apiRes = await axios.get(`https://apis.davidcyriltech.my.id/play?query=${encodeURIComponent(query)}`);
    const songData = apiRes.data.result;

    const fileName = crypto.randomUUID() + '.mp3';
    const filePath = path.join(SONGS_DIR, fileName);

    const writer = fs.createWriteStream(filePath);
    const response = await axios({ url: songData.download_url, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    await new Promise(resolve => writer.on('finish', resolve));

    const audioMeta = await getAudioMeta(filePath);

    const streamId = crypto.randomUUID();
    streams[streamId] = {
      queue: [
        {
          fileName,
          meta: {
            title: songData.title,
            thumbnail: songData.thumbnail,
            duration: audioMeta.duration,
            views: songData.views,
            published: songData.published,
            source: songData.video_url
          }
        }
      ],
      currentIndex: 0,
      songStartTime: Date.now(),
      clients: new Set(),
      users: new Map() // Initialize users Map
    };

    ctx.reply(`🎶 Your stream: https://yourdomain.com/stream/${streamId}`);
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Failed to start stream.');
  }
});

// 🎶 Queue another song
bot.command('queue', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Usage: /queue <streamId> <song name>');

  const streamId = args[1];
  const query = args.slice(2).join(' ');
  const stream = streams[streamId];
  if (!stream) return ctx.reply('Stream not found.');

  try {
    const apiRes = await axios.get(`https://apis.davidcyriltech.my.id/play?query=${encodeURIComponent(query)}`);
    const songData = apiRes.data.result;

    const fileName = crypto.randomUUID() + '.mp3';
    const filePath = path.join(SONGS_DIR, fileName);

    const writer = fs.createWriteStream(filePath);
    const response = await axios({ url: songData.download_url, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    await new Promise(resolve => writer.on('finish', resolve));

    const audioMeta = await getAudioMeta(filePath);

    stream.queue.push({
      fileName,
      meta: {
        title: songData.title,
        thumbnail: songData.thumbnail,
        duration: audioMeta.duration,
        views: songData.views,
        published: songData.published,
        source: songData.video_url
      }
    });

    // 🔔 Notify clients
    sendStreamUpdate(streamId);

    ctx.reply(`✅ Added "${songData.title}" to stream ${streamId}`);
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Failed to add song.');
  }
});

// Auto-advance
setInterval(() => {
  for (const streamId in streams) {
    const stream = streams[streamId];
    const current = stream.queue[stream.currentIndex];
    if (!current) continue;

    const elapsed = (Date.now() - stream.songStartTime) / 1000;
    if (elapsed >= current.meta.duration) {
      stream.currentIndex = (stream.currentIndex + 1) % stream.queue.length;
      stream.songStartTime = Date.now();
      sendStreamUpdate(streamId);
    }
  }
}, 1000);

// Start
bot.launch();
server.listen(3000, () => console.log('🚀 Server + WS running on port 3000'));
