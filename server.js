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
// streams[streamId] = { queue, currentIndex, songStartTime, clients:Set(ws), users:Map(userId -> {id, name, joinedAt}), ownerId, lastActivity, isPlaying }
const streams = {};

// Constants
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB in bytes
const MAX_DURATION = 15 * 60; // 15 minutes in seconds
const STREAM_CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes in milliseconds

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

  // Update stream activity
  stream.lastActivity = Date.now();

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

  // Update stream activity
  stream.lastActivity = Date.now();

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

  // Update stream activity
  stream.lastActivity = Date.now();

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

// Clean up empty streams after 30 minutes of inactivity
setInterval(() => {
  const now = Date.now();
  const streamsToDelete = [];

  for (const streamId in streams) {
    const stream = streams[streamId];
    const timeSinceActivity = now - (stream.lastActivity || 0);
    const hasNoUsers = !stream.users || stream.users.size === 0;
    
    if (hasNoUsers && timeSinceActivity > STREAM_CLEANUP_INTERVAL) {
      streamsToDelete.push(streamId);
    }
  }

  // Clean up streams and their files
  for (const streamId of streamsToDelete) {
    const stream = streams[streamId];
    
    // Delete audio files
    for (const song of stream.queue) {
      const filePath = path.join(SONGS_DIR, song.fileName);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.error(`Failed to delete file ${filePath}:`, err);
        }
      }
    }
    
    // Delete stream
    delete streams[streamId];
    console.log(`🧹 Cleaned up empty stream: ${streamId}`);
  }
}, 10 * 60 * 1000); // Check every 10 minutes

// Function to notify all users in a stream about new song
async function notifyUsersAboutNewSong(streamId, songData, queuedBy) {
  const stream = streams[streamId];
  if (!stream || !stream.users) return;

  const duration = Math.floor(songData.meta.duration / 60) + ':' + Math.floor(songData.meta.duration % 60).toString().padStart(2, '0');
  const caption = `🎵 **New Song Added to Stream!**

🎶 **Title:** ${songData.meta.title}
⏱️ **Duration:** ${duration}
👤 **Added by:** ${queuedBy}
📊 **Stream ID:** \`${streamId}\`
📝 **Queue Position:** #${stream.queue.length}

🎧 The song will play automatically when it's its turn!`;

  // Send to all users in the stream (except the one who added it)
  for (const [userId, user] of stream.users) {
    try {
      await bot.telegram.sendPhoto(userId, songData.meta.thumbnail, {
        caption: caption,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🎧 Open Stream',
                url: `https://mp-sesh.onrender.com/stream/${streamId}`
              }
            ]
          ]
        }
      });
    } catch (err) {
      console.error(`Failed to notify user ${userId}:`, err.message);
      // If user blocked the bot, remove them from stream
      if (err.code === 403) {
        stream.users.delete(userId);
        broadcastUserUpdate(streamId, 'user_left', { id: userId, name: user.name, reason: 'blocked_bot' });
      }
    }
  }
}

// Broadcast user updates to WebSocket clients (lightweight)
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

// Lightweight queue update notification (only sends new song info, not full queue)
function broadcastQueueUpdate(streamId, newSong, queueLength) {
  const stream = streams[streamId];
  if (!stream) return;

  const payload = {
    type: 'song_queued',
    data: {
      song: newSong,
      queueLength: queueLength,
      position: queueLength
    },
    timestamp: new Date().toISOString()
  };

  for (const client of stream.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }
}

// WebSocket for real-time sync - Updated to match frontend expectations
wss.on('connection', (ws, req) => {
  const urlParts = req.url.split('/');
  const streamId = urlParts[urlParts.length - 1];

  // Handle frontend WebSocket path format: /stream-ws/:streamId
  let actualStreamId = streamId;
  if (req.url.includes('/stream-ws/')) {
    actualStreamId = req.url.split('/stream-ws/')[1];
  }

  const stream = streams[actualStreamId];
  if (!stream) {
    ws.send(JSON.stringify({ type: 'error', message: 'Stream not found' }));
    ws.close();
    return;
  }

  // Save client
  if (!stream.clients) {
    stream.clients = new Set();
  }
  stream.clients.add(ws);

  // Update stream activity
  stream.lastActivity = Date.now();

  // Send initial state
  sendStreamUpdate(actualStreamId);

  ws.on('close', () => {
    stream.clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    stream.clients.delete(ws);
  });
});

// GET current track endpoint for frontend fallback
app.get('/stream/:streamId/currentTrack', (req, res) => {
  const { streamId } = req.params;
  const stream = streams[streamId];
  
  if (!stream) {
    return res.status(404).json({ error: 'Stream not found' });
  }

  const now = Date.now();
  const current = stream.queue[stream.currentIndex];
  const elapsed = current ? (now - stream.songStartTime) / 1000 : 0;

  res.json({
    streamId,
    queue: stream.queue,
    currentIndex: stream.currentIndex,
    elapsed: elapsed,
    isPlaying: stream.isPlaying !== false,
    current: current ? {
      file: `/songs/${current.fileName}`,
      meta: current.meta
    } : null
  });
});

// Broadcast helper - optimized to reduce payload size
function sendStreamUpdate(streamId) {
  const stream = streams[streamId];
  if (!stream || stream.queue.length === 0) return;

  const now = Date.now();
  const current = stream.queue[stream.currentIndex];
  const elapsed = (now - stream.songStartTime) / 1000;

  // Check if there's a next song (no looping)
  const nextIndex = stream.currentIndex + 1;
  const nextSong = nextIndex < stream.queue.length ? stream.queue[nextIndex] : null;

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
    queue: stream.queue, // Frontend expects full queue for display
    queueLength: stream.queue.length,
    isPlaying: stream.isPlaying !== false // Default to true for backwards compatibility
  };

  if (!stream.clients) {
    stream.clients = new Set();
  }

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

// Generate 10-digit numeric stream ID
function generateStreamId() {
  return Math.floor(1000000000 + Math.random() * 9000000000).toString();
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

    // Check file size
    if (audioMeta.size > MAX_FILE_SIZE) {
      fs.unlinkSync(filePath); // Delete the file
      return ctx.reply('❌ **File too large!**\n\nThis file is over 15MB. Please choose a shorter song or a different version.');
    }

    // Check duration
    if (audioMeta.duration > MAX_DURATION) {
      fs.unlinkSync(filePath); // Delete the file
      return ctx.reply('❌ **Song too long!**\n\nThis song is over 15 minutes long. Please choose a shorter song.');
    }

    const streamId = generateStreamId();
    const ownerId = ctx.from.id; // Save the stream creator's user ID
    
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
      users: new Map(),
      ownerId: ownerId, // Store stream owner
      lastActivity: Date.now(), // Track stream activity
      isPlaying: true // Track playing state
    };

    // Send message with WebApp button and copyable stream ID
    const streamUrl = `https://mp-sesh.onrender.com/stream/${streamId}`;
    const messageText = `🎶 **Stream Created Successfully!**

🎵 **Now Playing:** ${songData.title}
⏱️ **Duration:** ${Math.floor(audioMeta.duration / 60)}:${Math.floor(audioMeta.duration % 60).toString().padStart(2, '0')}
👥 **Share this Stream ID with friends:**

\`${streamId}\`

**Stream Owner Commands:**
• Use /next to skip to next song (DM only)
• Others can add songs with /queue ${streamId} <song name>

Click the button below to open your stream player, or share the Stream ID with others so they can join!`;

    await ctx.reply(messageText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🎧 Open Stream Player',
              web_app: { url: streamUrl }
            }
          ],
          [
            {
              text: '📋 Copy Stream Link',
              url: streamUrl
            }
          ]
        ]
      }
    });

  } catch (err) {
    console.error(err);
    ctx.reply('❌ Failed to start stream. Please try again.');
  }
});

// 🎵 Handle /start command with stream ID
bot.command('start', async (ctx) => {
  const args = ctx.message.text.split(' ');
  
  if (args.length === 1) {
    // Regular start command
    return ctx.reply(`🎵 **Welcome to Kaizen Music Streams!**

**Available Commands:**
• /stream <song name> - Create a new music stream
• /queue <stream_id> <song name> - Add song to existing stream

**How to join a stream:**
1. Get a Stream ID from a friend
2. Use /start <stream_id> to join
3. Or use inline: @Kaizen_Aibot <stream_id>

Start creating your music experience! 🎶`, {
      parse_mode: 'Markdown'
    });
  }

  // Handle /start with stream ID parameter
  const streamId = args[1];
  const stream = streams[streamId];
  
  if (!stream) {
    return ctx.reply(`❌ **Stream not found!**

The Stream ID \`${streamId}\` doesn't exist or has expired.

**Create your own stream:**
Use /stream <song name> to start a new stream!`, {
      parse_mode: 'Markdown'
    });
  }

  const currentSong = stream.queue[stream.currentIndex];
  const streamUrl = `https://mp-sesh.onrender.com/stream/${streamId}`;
  
  const messageText = `🎵 **Join Music Stream**

🎶 **Currently Playing:** ${currentSong?.meta?.title || 'Unknown'}
👥 **Active Listeners:** ${stream.users.size}
📝 **Queue Length:** ${stream.queue.length} songs

**Stream ID:** \`${streamId}\`

**How to add songs:**
Send: \`/queue ${streamId} <song name>\`

Example: \`/queue ${streamId} never gonna give you up\``;

  await ctx.reply(messageText, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '🎧 Join Stream',
            web_app: { url: streamUrl }
          }
        ]
      ]
    }
  });
});

// 📻 Inline query handler
bot.on('inline_query', async (ctx) => {
  const query = ctx.inlineQuery.query.trim();
  
  // Check if query is a stream ID (10 digits)
  if (!/^\d{10}$/.test(query)) {
    return ctx.answerInlineQuery([
      {
        type: 'article',
        id: 'help',
        title: '🎵 Enter a 10-digit Stream ID',
        description: 'Type a valid Stream ID to share',
        input_message_content: {
          message_text: '🎵 **How to use Kaizen Music Streams:**\n\n1. Get a Stream ID from someone\n2. Type @Kaizen_Aibot <stream_id>\n3. Share the stream with others!\n\nCreate your own: /stream <song name>',
          parse_mode: 'Markdown'
        }
      }
    ]);
  }
  
  const streamId = query;
  const stream = streams[streamId];
  
  if (!stream) {
    return ctx.answerInlineQuery([
      {
        type: 'article',
        id: 'not_found',
        title: '❌ Stream Not Found',
        description: `Stream ID ${streamId} doesn't exist`,
        input_message_content: {
          message_text: `❌ **Stream Not Found**\n\nThe Stream ID \`${streamId}\` doesn't exist or has expired.\n\nCreate a new stream with /stream <song name>`,
          parse_mode: 'Markdown'
        }
      }
    ]);
  }
  
  const currentSong = stream.queue[stream.currentIndex];
  
  const results = [
    {
      type: 'article',
      id: streamId,
      title: `🎵 Join Music Stream`,
      description: `Now Playing: ${currentSong?.meta?.title || 'Unknown'} • ${stream.users.size} listeners`,
      thumbnail_url: currentSong?.meta?.thumbnail || 'https://via.placeholder.com/150x150/1db954/ffffff?text=🎵',
      input_message_content: {
        message_text: `🎵 **Join this Music Stream!**\n\n🎶 **Now Playing:** ${currentSong?.meta?.title || 'Unknown'}\n👥 **Listeners:** ${stream.users.size}\n📝 **Songs in Queue:** ${stream.queue.length}\n\n**Stream ID:** \`${streamId}\`\n\nTap the button below to join the live stream!`,
        parse_mode: 'Markdown'
      },
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🎧 Join Stream',
              url: `https://t.me/Kaizen_Aibot?start=${streamId}`
            }
          ]
        ]
      }
    }
  ];
  
  ctx.answerInlineQuery(results, {
    cache_time: 10,
    is_personal: true
  });
});

// ⏭️ Next command (stream owner only, DM only)
bot.command('next', async (ctx) => {
  // Check if it's a private message (DM)
  if (ctx.chat.type !== 'private') {
    return ctx.reply('⚠️ The /next command can only be used in direct messages with the bot.');
  }
  
  const userId = ctx.from.id;
  
  // Find streams owned by this user
  const ownedStreams = Object.entries(streams).filter(([_, stream]) => stream.ownerId === userId);
  
  if (ownedStreams.length === 0) {
    return ctx.reply('❌ You don\'t own any active streams.\n\nCreate a stream with /stream <song name>');
  }
  
  if (ownedStreams.length === 1) {
    // If user owns only one stream, skip to next song
    const [streamId, stream] = ownedStreams[0];
    
    if (stream.currentIndex + 1 >= stream.queue.length) {
      return ctx.reply('⚠️ No more songs in the queue to skip to.');
    }
    
    // Skip to next song
    stream.currentIndex = stream.currentIndex + 1;
    stream.songStartTime = Date.now();
    stream.lastActivity = Date.now();
    stream.isPlaying = true;
    
    // Notify all clients via WebSocket
    sendStreamUpdate(streamId);
    
    const nextSong = stream.queue[stream.currentIndex];
    return ctx.reply(`⏭️ **Skipped to next song!**\n\n🎵 **Now Playing:** ${nextSong?.meta?.title || 'Unknown'}\n📊 **Stream:** \`${streamId}\``);
  }
  
  // If user owns multiple streams, show list to choose from
  const keyboard = ownedStreams.map(([streamId, stream]) => {
    const currentSong = stream.queue[stream.currentIndex];
    return [{
      text: `🎵 ${currentSong?.meta?.title || 'Stream'} (${streamId})`,
      callback_data: `next_${streamId}`
    }];
  });
  
  ctx.reply('🎛️ **Select which stream to skip:**', {
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
});

// Handle next song callback
bot.action(/^next_(.+)$/, async (ctx) => {
  const streamId = ctx.match[1];
  const stream = streams[streamId];
  const userId = ctx.from.id;
  
  if (!stream) {
    return ctx.answerCbQuery('❌ Stream not found', true);
  }
  
  if (stream.ownerId !== userId) {
    return ctx.answerCbQuery('❌ You can only control your own streams', true);
  }
  
  if (stream.currentIndex + 1 >= stream.queue.length) {
    return ctx.answerCbQuery('⚠️ No more songs in the queue', true);
  }
  
  // Skip to next song
  stream.currentIndex = stream.currentIndex + 1;
  stream.songStartTime = Date.now();
  stream.lastActivity = Date.now();
  stream.isPlaying = true;
  
  // Notify all clients via WebSocket
  sendStreamUpdate(streamId);
  
  const nextSong = stream.queue[stream.currentIndex];
  
  ctx.answerCbQuery('⏭️ Skipped to next song!', false);
  ctx.editMessageText(`⏭️ **Skipped to next song!**\n\n🎵 **Now Playing:** ${nextSong?.meta?.title || 'Unknown'}\n📊 **Stream:** \`${streamId}\``, {
    parse_mode: 'Markdown'
  });
});

// 🎶 Queue another song - OPTIMIZED to prevent lag
bot.command('queue', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Usage: /queue <streamId> <song name>');

  const streamId = args[1];
  const query = args.slice(2).join(' ');
  const stream = streams[streamId];
  if (!stream) return ctx.reply('❌ Stream not found.');

  const queuedBy = ctx.from.first_name || ctx.from.username || 'Unknown User';

  try {
    ctx.reply('🔍 Searching for your song...');

    const apiRes = await axios.get(`https://apis.davidcyriltech.my.id/play?query=${encodeURIComponent(query)}`);
    const songData = apiRes.data.result;

    const fileName = crypto.randomUUID() + '.mp3';
    const filePath = path.join(SONGS_DIR, fileName);

    const writer = fs.createWriteStream(filePath);
    const response = await axios({ url: songData.download_url, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    await new Promise(resolve => writer.on('finish', resolve));

    const audioMeta = await getAudioMeta(filePath);

    // Check file size
    if (audioMeta.size > MAX_FILE_SIZE) {
      fs.unlinkSync(filePath); // Delete the file
      return ctx.reply('❌ **File too large!**\n\nThis is not a suitable song - it\'s over 15MB. Please choose a shorter song or a different version.');
    }

    // Check duration
    if (audioMeta.duration > MAX_DURATION) {
      fs.unlinkSync(filePath); // Delete the file
      return ctx.reply('❌ **Song too long!**\n\nThis is not a suitable song - it\'s over 15 minutes long. Please choose a shorter song.');
    }

    const songInfo = {
      fileName,
      meta: {
        title: songData.title,
        thumbnail: songData.thumbnail,
        duration: audioMeta.duration,
        views: songData.views,
        published: songData.published,
        source: songData.video_url
      }
    };

    // Add song to queue
    stream.queue.push(songInfo);
    stream.lastActivity = Date.now();

    // If stream was stopped (no current song playing), start playing the new song
    if (!stream.isPlaying || stream.currentIndex >= stream.queue.length - 1) {
      stream.currentIndex = stream.queue.length - 1;
      stream.songStartTime = Date.now();
      stream.isPlaying = true;
      // Send full update when starting playback
      sendStreamUpdate(streamId);
    } else {
      // Send lightweight queue update to prevent interruption during playback
      const lightPayload = {
        type: 'song_queued',
        data: {
          song: songInfo,
          queueLength: stream.queue.length,
          position: stream.queue.length,
          queue: stream.queue // Include full queue for frontend display
        },
        timestamp: new Date().toISOString()
      };

      if (!stream.clients) {
        stream.clients = new Set();
      }

      for (const client of stream.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(lightPayload));
        }
      }
    }

    // Send confirmation to the person who queued the song
    const duration = Math.floor(audioMeta.duration / 60) + ':' + Math.floor(audioMeta.duration % 60).toString().padStart(2, '0');
    await ctx.replyWithPhoto(songData.thumbnail, {
      caption: `✅ **Song Added Successfully!**\n\n🎵 **Title:** ${songData.title}\n⏱️ **Duration:** ${duration}\n📊 **Stream:** \`${streamId}\`\n📝 **Queue Position:** #${stream.queue.length}\n\n🎧 Your song will play automatically when it's its turn!`,
      parse_mode: 'Markdown'
    });

    // Notify all other users in the stream
    await notifyUsersAboutNewSong(streamId, songInfo, queuedBy);

  } catch (err) {
    console.error(err);
    ctx.reply('❌ Failed to add song. Please try again.');
  }
});

// Auto-advance - FIXED to stop looping
setInterval(() => {
  for (const streamId in streams) {
    const stream = streams[streamId];
    const current = stream.queue[stream.currentIndex];
    if (!current || !stream.isPlaying) continue;

    const elapsed = (Date.now() - stream.songStartTime) / 1000;
    if (elapsed >= current.meta.duration) {
      // Check if there's a next song (don't loop)
      if (stream.currentIndex + 1 < stream.queue.length) {
        // Move to next song
        stream.currentIndex = stream.currentIndex + 1;
        stream.songStartTime = Date.now();
        stream.lastActivity = Date.now();
        stream.isPlaying = true;
        sendStreamUpdate(streamId);
      } else {
        // No more songs - stop playing and wait
        stream.isPlaying = false;
        
        // Notify clients that playback has stopped
        const payload = {
          type: 'playback_stopped',
          message: 'No more songs in queue. Add more songs to continue!',
          timestamp: new Date().toISOString()
        };

        for (const client of stream.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(payload));
          }
        }
        
        console.log(`🛑 Stream ${streamId} stopped - no more songs in queue`);
      }
    }
  }
}, 1000);

// Start
bot.launch();
server.listen(3000, () => console.log('🚀 Server + WS running on port 3000'));
