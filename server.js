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

// Data folder for persistent storage
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Memory storage
const streams = {};
const userStats = new Map(); // userId -> stats object
const songReactions = new Map(); // songId -> reactions object
const songDatabase = new Map(); // songId -> song data

// Load persistent data
loadPersistentData();

// Constants
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB in bytes
const MAX_DURATION = 15 * 60; // 15 minutes in seconds
const STREAM_CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes in milliseconds
const REACTION_EMOJIS = ['❤️', '🔥', '👍', '😍', '🎵', '💯'];

app.use(express.static('public'));
app.use('/songs', express.static(SONGS_DIR));
app.use(express.json());

// Load persistent data from files
function loadPersistentData() {
  try {
    const userStatsPath = path.join(DATA_DIR, 'userStats.json');
    if (fs.existsSync(userStatsPath)) {
      const data = JSON.parse(fs.readFileSync(userStatsPath, 'utf8'));
      for (const [userId, stats] of Object.entries(data)) {
        userStats.set(userId, stats);
      }
    }

    const songReactionsPath = path.join(DATA_DIR, 'songReactions.json');
    if (fs.existsSync(songReactionsPath)) {
      const data = JSON.parse(fs.readFileSync(songReactionsPath, 'utf8'));
      for (const [songId, reactions] of Object.entries(data)) {
        songReactions.set(songId, reactions);
      }
    }

    const songDatabasePath = path.join(DATA_DIR, 'songDatabase.json');
    if (fs.existsSync(songDatabasePath)) {
      const data = JSON.parse(fs.readFileSync(songDatabasePath, 'utf8'));
      for (const [songId, songData] of Object.entries(data)) {
        songDatabase.set(songId, songData);
      }
    }
  } catch (err) {
    console.error('Error loading persistent data:', err);
  }
}

// Save persistent data to files
function savePersistentData() {
  try {
    fs.writeFileSync(
      path.join(DATA_DIR, 'userStats.json'),
      JSON.stringify(Object.fromEntries(userStats), null, 2)
    );
    
    fs.writeFileSync(
      path.join(DATA_DIR, 'songReactions.json'),
      JSON.stringify(Object.fromEntries(songReactions), null, 2)
    );

    fs.writeFileSync(
      path.join(DATA_DIR, 'songDatabase.json'),
      JSON.stringify(Object.fromEntries(songDatabase), null, 2)
    );
  } catch (err) {
    console.error('Error saving persistent data:', err);
  }
}

// Initialize user stats
function initUserStats(userId, userName) {
  if (!userStats.has(userId)) {
    userStats.set(userId, {
      id: userId,
      name: userName,
      totalSongsListened: 0,
      totalListeningTime: 0,
      songsQueued: 0,
      streamsCreated: 0,
      recentlyListened: [],
      favoriteGenres: {},
      joinedAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      totalReactions: 0,
      achievements: []
    });
  }
  return userStats.get(userId);
}

// Update user listening stats
function updateUserListeningStats(userId, songData, listeningTime) {
  const stats = userStats.get(userId);
  if (!stats) return;

  stats.totalSongsListened += 1;
  stats.totalListeningTime += listeningTime;
  stats.lastActive = new Date().toISOString();

  // Add to recently listened (keep last 50)
  stats.recentlyListened.unshift({
    songId: songData.id,
    title: songData.meta.title,
    listenedAt: new Date().toISOString(),
    duration: listeningTime
  });
  stats.recentlyListened = stats.recentlyListened.slice(0, 50);

  // Check for achievements
  checkAchievements(userId);
}

// Check and award achievements
function checkAchievements(userId) {
  const stats = userStats.get(userId);
  if (!stats) return;

  const achievements = [];
  
  if (stats.totalSongsListened >= 10 && !stats.achievements.includes('music_lover')) {
    achievements.push('music_lover');
  }
  if (stats.totalSongsListened >= 100 && !stats.achievements.includes('music_addict')) {
    achievements.push('music_addict');
  }
  if (stats.streamsCreated >= 5 && !stats.achievements.includes('dj')) {
    achievements.push('dj');
  }
  if (stats.songsQueued >= 50 && !stats.achievements.includes('queue_master')) {
    achievements.push('queue_master');
  }

  stats.achievements.push(...achievements);
  return achievements;
}

// Serve player
app.get('/stream/:streamId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stream.html'));
});

// 🔍 Song search API with preview
app.get('/api/search', async (req, res) => {
  const { query, page = 1, limit = 10 } = req.query;
  
  if (!query) {
    return res.status(400).json({ error: 'Query parameter is required' });
  }

  try {
    // In a real implementation, you'd search multiple sources
    const searchResults = [];
    
    // Search using the existing API
    const apiRes = await axios.get(`https://apis.davidcyriltech.my.id/play?query=${encodeURIComponent(query)}`);
    const songData = apiRes.data.result;
    
    // Generate unique ID for this song
    const songId = crypto.createHash('md5').update(songData.video_url).digest('hex');
    
    searchResults.push({
      id: songId,
      title: songData.title,
      thumbnail: songData.thumbnail,
      duration: null, // Will be filled when song is actually processed
      views: songData.views,
      published: songData.published,
      source: songData.video_url,
      downloadUrl: songData.download_url,
      reactions: songReactions.get(songId) || { total: 0, breakdown: {} }
    });

    res.json({
      query,
      page: parseInt(page),
      limit: parseInt(limit),
      total: searchResults.length,
      results: searchResults
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// 👥 User joined stream
app.post('/joined/:streamId', (req, res) => {
  const { streamId } = req.params;
  const { name, id } = req.body;

  if (!name || !id) {
    return res.status(400).json({ error: 'Name and id are required' });
  }

  const stream = streams[streamId];
  if (!stream) {
    return res.status(404).json({ error: 'Stream not found' });
  }

  if (!stream.users) stream.users = new Map();
  if (!stream.nextVotes) stream.nextVotes = new Set();

  stream.lastActivity = Date.now();

  // Initialize user stats
  initUserStats(id, name);

  stream.users.set(id, {
    id,
    name,
    joinedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString()
  });

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

  if (!id) {
    return res.status(400).json({ error: 'User id is required' });
  }

  const stream = streams[streamId];
  if (!stream) {
    return res.status(404).json({ error: 'Stream not found' });
  }

  if (!stream.users) stream.users = new Map();

  const user = stream.users.get(id);
  if (!user) {
    return res.status(404).json({ error: 'User not found in stream' });
  }

  stream.lastActivity = Date.now();

  // Calculate listening time for this session
  const sessionTime = (Date.now() - new Date(user.joinedAt).getTime()) / 1000;
  const current = stream.queue[stream.currentIndex];
  if (current && sessionTime > 10) { // Only count if listened for more than 10 seconds
    updateUserListeningStats(id, { id: current.meta.songId || 'unknown', meta: current.meta }, Math.min(sessionTime, current.meta.duration));
  }

  stream.users.delete(id);
  if (stream.nextVotes) stream.nextVotes.delete(id);

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
  const stream = streams[streamId];
  
  if (!stream) {
    return res.status(404).json({ error: 'Stream not found' });
  }

  if (!stream.users) stream.users = new Map();

  const users = Array.from(stream.users.values());

  res.json({
    streamId,
    totalUsers: users.length,
    users: users,
    nextVotes: stream.nextVotes ? stream.nextVotes.size : 0,
    votesNeeded: Math.ceil(users.length / 2)
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

  if (!stream.users) stream.users = new Map();

  stream.lastActivity = Date.now();

  const user = stream.users.get(userId);
  if (user) {
    user.lastHeartbeat = new Date().toISOString();
    res.json({ success: true, message: 'Heartbeat updated' });
  } else {
    res.status(404).json({ error: 'User not found in stream' });
  }
});

// 🎵 React to song
app.post('/react/:streamId', (req, res) => {
  const { streamId } = req.params;
  const { userId, emoji, songId } = req.body;

  if (!userId || !emoji || !songId) {
    return res.status(400).json({ error: 'userId, emoji, and songId are required' });
  }

  if (!REACTION_EMOJIS.includes(emoji)) {
    return res.status(400).json({ error: 'Invalid emoji reaction' });
  }

  const stream = streams[streamId];
  if (!stream) {
    return res.status(404).json({ error: 'Stream not found' });
  }

  // Get or create reaction data for this song
  if (!songReactions.has(songId)) {
    songReactions.set(songId, { total: 0, breakdown: {}, userReactions: {} });
  }

  const reactions = songReactions.get(songId);
  
  // Remove previous reaction from this user if exists
  if (reactions.userReactions[userId]) {
    const prevEmoji = reactions.userReactions[userId];
    reactions.breakdown[prevEmoji] = Math.max(0, (reactions.breakdown[prevEmoji] || 0) - 1);
    reactions.total = Math.max(0, reactions.total - 1);
  }

  // Add new reaction
  reactions.userReactions[userId] = emoji;
  reactions.breakdown[emoji] = (reactions.breakdown[emoji] || 0) + 1;
  reactions.total += 1;

  // Update user stats
  const userStat = userStats.get(userId);
  if (userStat) {
    userStat.totalReactions += 1;
  }

  // Broadcast reaction to all clients
  broadcastReactionUpdate(streamId, { songId, emoji, userId, reactions });

  savePersistentData();

  res.json({ success: true, reactions });
});

// 🗳️ Vote for next song
app.post('/vote-next/:streamId', (req, res) => {
  const { streamId } = req.params;
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const stream = streams[streamId];
  if (!stream) {
    return res.status(404).json({ error: 'Stream not found' });
  }

  if (!stream.users) stream.users = new Map();
  if (!stream.nextVotes) stream.nextVotes = new Set();

  // Check if user is in the stream
  if (!stream.users.has(userId)) {
    return res.status(403).json({ error: 'User must be in stream to vote' });
  }

  // Check if there are more songs to skip to
  if (stream.queue.length <= 1) {
    return res.status(400).json({ error: 'No more songs in queue to skip to' });
  }

  // Toggle vote
  if (stream.nextVotes.has(userId)) {
    stream.nextVotes.delete(userId);
  } else {
    stream.nextVotes.add(userId);
  }

  const votesNeeded = Math.ceil(stream.users.size / 2);
  const currentVotes = stream.nextVotes.size;

  // Check if enough votes to skip
  if (currentVotes >= votesNeeded) {
    // Skip to next song
    stream.currentIndex = (stream.currentIndex + 1) % stream.queue.length;
    stream.songStartTime = Date.now();
    stream.lastActivity = Date.now();
    stream.nextVotes.clear(); // Reset votes

    sendStreamUpdate(streamId);

    res.json({
      success: true,
      skipped: true,
      message: 'Song skipped by popular vote!',
      votes: currentVotes,
      needed: votesNeeded
    });
  } else {
    res.json({
      success: true,
      skipped: false,
      votes: currentVotes,
      needed: votesNeeded,
      message: `${currentVotes}/${votesNeeded} votes to skip`
    });
  }

  // Broadcast vote update
  broadcastVoteUpdate(streamId, { votes: currentVotes, needed: votesNeeded });
});

// 👤 User info API
app.get('/api/user/:userId', (req, res) => {
  const { userId } = req.params;
  const stats = userStats.get(userId);

  if (!stats) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Calculate additional stats
  const avgListeningTime = stats.totalSongsListened > 0 
    ? Math.round(stats.totalListeningTime / stats.totalSongsListened) 
    : 0;

  const topGenres = Object.entries(stats.favoriteGenres)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5)
    .map(([genre, count]) => ({ genre, count }));

  res.json({
    ...stats,
    avgListeningTime,
    topGenres,
    totalListeningHours: Math.round(stats.totalListeningTime / 3600 * 100) / 100
  });
});

// 🎵 Most liked songs API
app.get('/api/songs/popular', (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);

  // Get all songs with reactions, sorted by total reactions
  const songsWithReactions = Array.from(songReactions.entries())
    .map(([songId, reactions]) => ({
      songId,
      ...songDatabase.get(songId),
      reactions
    }))
    .filter(song => song.meta) // Only include songs we have data for
    .sort((a, b) => b.reactions.total - a.reactions.total);

  const start = (pageNum - 1) * limitNum;
  const end = start + limitNum;
  const paginatedSongs = songsWithReactions.slice(start, end);

  res.json({
    page: pageNum,
    limit: limitNum,
    total: songsWithReactions.length,
    totalPages: Math.ceil(songsWithReactions.length / limitNum),
    songs: paginatedSongs
  });
});

// 📊 Global stats API
app.get('/api/stats/global', (req, res) => {
  const totalUsers = userStats.size;
  const totalSongs = songDatabase.size;
  const totalReactions = Array.from(songReactions.values())
    .reduce((sum, reactions) => sum + reactions.total, 0);
  
  const totalListeningTime = Array.from(userStats.values())
    .reduce((sum, user) => sum + user.totalListeningTime, 0);

  const activeStreams = Object.keys(streams).length;

  // Most active users
  const topUsers = Array.from(userStats.values())
    .sort((a, b) => b.totalSongsListened - a.totalSongsListened)
    .slice(0, 10)
    .map(user => ({
      id: user.id,
      name: user.name,
      totalSongsListened: user.totalSongsListened,
      totalListeningTime: Math.round(user.totalListeningTime / 3600 * 100) / 100
    }));

  res.json({
    totalUsers,
    totalSongs,
    totalReactions,
    totalListeningHours: Math.round(totalListeningTime / 3600 * 100) / 100,
    activeStreams,
    topUsers
  });
});

// Broadcast functions
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

function broadcastReactionUpdate(streamId, reactionData) {
  const stream = streams[streamId];
  if (!stream) return;

  const payload = {
    type: 'reaction_update',
    data: reactionData,
    timestamp: new Date().toISOString()
  };

  for (const client of stream.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }
}

function broadcastVoteUpdate(streamId, voteData) {
  const stream = streams[streamId];
  if (!stream) return;

  const payload = {
    type: 'vote_update',
    data: voteData,
    timestamp: new Date().toISOString()
  };

  for (const client of stream.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }
}

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
      
      if (timeSinceHeartbeat > 30) {
        usersToRemove.push({ userId, user });
      }
    }

    for (const { userId, user } of usersToRemove) {
      stream.users.delete(userId);
      if (stream.nextVotes) stream.nextVotes.delete(userId);
      broadcastUserUpdate(streamId, 'user_left', { id: userId, name: user.name, reason: 'timeout' });
    }
  }
}, 15000);

// Clean up empty streams and save data periodically
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

  for (const streamId of streamsToDelete) {
    const stream = streams[streamId];
    
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
    
    delete streams[streamId];
    console.log(`🧹 Cleaned up empty stream: ${streamId}`);
  }

  // Save persistent data every 10 minutes
  savePersistentData();
}, 10 * 60 * 1000);

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

  stream.clients.add(ws);
  stream.lastActivity = Date.now();

  sendStreamUpdate(streamId);

  ws.on('close', () => {
    stream.clients.delete(ws);
  });
});

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
    current: current ? {
      file: `/songs/${current.fileName}`,
      meta: current.meta,
      reactions: songReactions.get(current.meta.songId) || { total: 0, breakdown: {} }
    } : null,
    next: nextSong ? { 
      file: `/songs/${nextSong.fileName}`, 
      meta: nextSong.meta 
    } : null,
    queue: stream.queue,
    votes: {
      current: stream.nextVotes ? stream.nextVotes.size : 0,
      needed: Math.ceil((stream.users?.size || 0) / 2)
    }
  };

  for (const client of stream.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }
}

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

function generateStreamId() {
  return Math.floor(1000000000 + Math.random() * 9000000000).toString();
}

// 🔍 Search command with preview
bot.command('search', async (ctx) => {
  const query = ctx.message.text.split(' ').slice(1).join(' ');
  if (!query) return ctx.reply('Usage: /search <song name>');

  try {
    ctx.reply('🔍 Searching...');
    
    const apiRes = await axios.get(`https://apis.davidcyriltech.my.id/play?query=${encodeURIComponent(query)}`);
    const songData = apiRes.data.result;
    
    const songId = crypto.createHash('md5').update(songData.video_url).digest('hex');
    const reactions = songReactions.get(songId) || { total: 0, breakdown: {} };
    
    const keyboard = [
      [
        { text: '🎵 Create Stream', callback_data: `create_stream_${songId}` },
        { text: '📊 View Stats', callback_data: `song_stats_${songId}` }
      ]
    ];

    await ctx.replyWithPhoto(songData.thumbnail, {
      caption: `🎵 **${songData.title}**\n\n👀 **Views:** ${songData.views}\n📅 **Published:** ${songData.published}\n${reactions.total > 0 ? `💝 **Reactions:** ${reactions.total}` : ''}\n\n🔗 [Watch on YouTube](${songData.video_url})`,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });

  } catch (err) {
    console.error(err);
    ctx.reply('❌ Search failed. Please try again.');
  }
});

// Handle song preview callbacks
bot.action(/^create_stream_(.+)$/, async (ctx) => {
  // This would create a stream with the selected song
  ctx.answerCbQuery('🎵 Creating stream...');
  // Implementation similar to /stream command
});

bot.action(/^song_stats_(.+)$/, async (ctx) => {
  const songId = ctx.match[1];
  const reactions = songReactions.get(songId) || { total: 0, breakdown: {} };
  
  let statsText = `📊 **Song Statistics**\n\n💝 **Total Reactions:** ${reactions.total}\n\n`;
  
  if (reactions.total > 0) {
    statsText += '**Reaction Breakdown:**\n';
    for (const [emoji, count] of Object.entries(reactions.breakdown)) {
      if (count > 0) {
        statsText += `${emoji} ${count}\n`;
      }
    }
  } else {
    statsText += 'No reactions yet. Be the first to react! 🎵';
  }
  
  ctx.answerCbQuery();
  ctx.editMessageCaption(statsText, { parse_mode: 'Markdown' });
});

// 📊 Stats command
bot.command('stats', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userName = ctx.from.first_name || ctx.from.username || 'Unknown';
  
  const stats = initUserStats(userId, userName);
  
  const achievements = stats.achievements.map(achievement => {
    const achievementNames = {
      music_lover: '🎵 Music Lover',
      music_addict: '🎵 Music Addict', 
      dj: '🎧 DJ Master',
      queue_master: '📝 Queue Master'
    };
    return achievementNames[achievement] || achievement;
  }).join('\n') || 'No achievements yet';

  const messageText = `📊 **Your Music Stats**

🎵 **Songs Listened:** ${stats.totalSongsListened}
⏱️ **Total Hours:** ${Math.round(stats.totalListeningTime / 3600 * 100) / 100}h
📝 **Songs Queued:** ${stats.songsQueued}
🎪 **Streams Created:** ${stats.streamsCreated}
💝 **Reactions Given:** ${stats.totalReactions}

🏆 **Achievements:**
${achievements}

📅 **Member Since:** ${new Date(stats.joinedAt).toLocaleDateString()}`;

  ctx.reply(messageText, { parse_mode: 'Markdown' });
});

// Enhanced /stream command with user stats tracking
bot.command('stream', async (ctx) => {
  const query = ctx.message.text.split(' ').slice(1).join(' ');
  if (!query) return ctx.reply('Usage: /stream <song name>');

  const userId = ctx.from.id.toString();
  const userName = ctx.from.first_name || ctx.from.username || 'Unknown';

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

    // Check file size and duration
    if (audioMeta.size > MAX_FILE_SIZE) {
      fs.unlinkSync(filePath);
      return ctx.reply('❌ **File too large!**\n\nThis file is over 15MB. Please choose a shorter song or a different version.');
    }

    if (audioMeta.duration > MAX_DURATION) {
      fs.unlinkSync(filePath);
      return ctx.reply('❌ **Song too long!**\n\nThis song is over 15 minutes long. Please choose a shorter song.');
    }

    const streamId = generateStreamId();
    const ownerId = ctx.from.id;
    const songId = crypto.createHash('md5').update(songData.video_url).digest('hex');
    
    const songInfo = {
      fileName,
      meta: {
        songId,
        title: songData.title,
        thumbnail: songData.thumbnail,
        duration: audioMeta.duration,
        views: songData.views,
        published: songData.published,
        source: songData.video_url
      }
    };

    // Save song to database
    songDatabase.set(songId, {
      id: songId,
      meta: songInfo.meta,
      addedAt: new Date().toISOString(),
      addedBy: userId
    });
    
    streams[streamId] = {
      queue: [songInfo],
      currentIndex: 0,
      songStartTime: Date.now(),
      clients: new Set(),
      users: new Map(),
      nextVotes: new Set(),
      ownerId: ownerId,
      lastActivity: Date.now()
    };

    // Update user stats
    const stats = initUserStats(userId, userName);
    stats.streamsCreated += 1;
    checkAchievements(userId);
    savePersistentData();

    const streamUrl = `https://mp-sesh.onrender.com/stream/${streamId}`;
    const messageText = `🎶 **Stream Created Successfully!**

🎵 **Now Playing:** ${songData.title}
⏱️ **Duration:** ${Math.floor(audioMeta.duration / 60)}:${Math.floor(audioMeta.duration % 60).toString().padStart(2, '0')}
👥 **Share this Stream ID with friends:**

\`${streamId}\`

**Available Commands:**
• /next - Skip to next song (owner only in DM)
• Others can add songs with \`/queue ${streamId} <song name>\`
• Listeners can vote to skip with voting system
• React to songs with emojis! ${REACTION_EMOJIS.join(' ')}

Click the button below to open your stream player!`;

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

// Enhanced /start command
bot.command('start', async (ctx) => {
  const args = ctx.message.text.split(' ');
  
  if (args.length === 1) {
    return ctx.reply(`🎵 **Welcome to Kaizen Music Streams!**

**🎶 Create & Share Music Streams**
• /stream <song name> - Create a new music stream
• /search <song name> - Search songs with preview
• /stats - View your listening statistics

**🎧 Join Existing Streams**
• /start <stream_id> - Join a stream
• /queue <stream_id> <song name> - Add song to stream
• Use inline: @Kaizen_Aibot <stream_id>

**✨ New Features:**
• 🗳️ Vote to skip songs (no more waiting for owners!)
• ${REACTION_EMOJIS.join(' ')} React to songs with emojis
• 📊 Track your listening stats and achievements
• 🔍 Search with song previews

Start creating your music experience! 🎶`, {
      parse_mode: 'Markdown'
    });
  }

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
  const reactions = currentSong ? songReactions.get(currentSong.meta.songId) || { total: 0 } : { total: 0 };
  
  const messageText = `🎵 **Join Music Stream**

🎶 **Currently Playing:** ${currentSong?.meta?.title || 'Unknown'}
👥 **Active Listeners:** ${stream.users.size}
📝 **Queue Length:** ${stream.queue.length} songs
${reactions.total > 0 ? `💝 **Song Reactions:** ${reactions.total}` : ''}

**Stream ID:** \`${streamId}\`

**How to interact:**
• Add songs: \`/queue ${streamId} <song name>\`
• Vote to skip: Use voting in the player
• React to songs: ${REACTION_EMOJIS.join(' ')}

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

// Enhanced inline query handler
bot.on('inline_query', async (ctx) => {
  const query = ctx.inlineQuery.query.trim();
  
  if (!/^\d{10}$/.test(query)) {
    return ctx.answerInlineQuery([
      {
        type: 'article',
        id: 'help',
        title: '🎵 Enter a 10-digit Stream ID',
        description: 'Type a valid Stream ID to share',
        input_message_content: {
          message_text: '🎵 **How to use Kaizen Music Streams:**\n\n1. Get a Stream ID from someone\n2. Type @Kaizen_Aibot <stream_id>\n3. Share the stream with others!\n\n✨ **New Features:**\n• Vote to skip songs\n• React with emojis\n• Track listening stats\n\nCreate your own: /stream <song name>',
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
  const reactions = currentSong ? songReactions.get(currentSong.meta.songId) || { total: 0 } : { total: 0 };
  
  const results = [
    {
      type: 'article',
      id: streamId,
      title: `🎵 Join Music Stream`,
      description: `${currentSong?.meta?.title || 'Unknown'} • ${stream.users.size} listeners • ${reactions.total} reactions`,
      thumbnail_url: currentSong?.meta?.thumbnail || 'https://via.placeholder.com/150x150/1db954/ffffff?text=🎵',
      input_message_content: {
        message_text: `🎵 **Join this Music Stream!**\n\n🎶 **Now Playing:** ${currentSong?.meta?.title || 'Unknown'}\n👥 **Listeners:** ${stream.users.size}\n📝 **Songs in Queue:** ${stream.queue.length}\n${reactions.total > 0 ? `💝 **Reactions:** ${reactions.total}` : ''}\n\n**Stream ID:** \`${streamId}\`\n\n✨ **New Features:** Vote to skip, react with emojis, and more!\n\nTap the button below to join the live stream!`,
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

// Enhanced /next command with voting info
bot.command('next', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    return ctx.reply('⚠️ The /next command can only be used in direct messages with the bot.\n\n💡 **Tip:** Regular users can now vote to skip songs in the stream player!');
  }
  
  const userId = ctx.from.id;
  const ownedStreams = Object.entries(streams).filter(([_, stream]) => stream.ownerId === userId);
  
  if (ownedStreams.length === 0) {
    return ctx.reply('❌ You don\'t own any active streams.\n\nCreate a stream with /stream <song name>');
  }
  
  if (ownedStreams.length === 1) {
    const [streamId, stream] = ownedStreams[0];
    
    if (stream.queue.length <= 1) {
      return ctx.reply('⚠️ No more songs in the queue to skip to.');
    }
    
    stream.currentIndex = (stream.currentIndex + 1) % stream.queue.length;
    stream.songStartTime = Date.now();
    stream.lastActivity = Date.now();
    stream.nextVotes.clear(); // Reset votes
    
    sendStreamUpdate(streamId);
    
    const nextSong = stream.queue[stream.currentIndex];
    return ctx.reply(`⏭️ **Skipped to next song!**\n\n🎵 **Now Playing:** ${nextSong?.meta?.title || 'Unknown'}\n📊 **Stream:** \`${streamId}\`\n\n💡 **Tip:** Users can also vote to skip songs in the player!`, { parse_mode: 'Markdown' });
  }
  
  const keyboard = ownedStreams.map(([streamId, stream]) => {
    const currentSong = stream.queue[stream.currentIndex];
    const voteInfo = stream.nextVotes.size > 0 ? ` (${stream.nextVotes.size} votes)` : '';
    return [{
      text: `🎵 ${currentSong?.meta?.title || 'Stream'} (${streamId})${voteInfo}`,
      callback_data: `next_${streamId}`
    }];
  });
  
  ctx.reply('🎛️ **Select which stream to skip:**', {
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
});

// Enhanced next song callback
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
  
  if (stream.queue.length <= 1) {
    return ctx.answerCbQuery('⚠️ No more songs in the queue', true);
  }
  
  stream.currentIndex = (stream.currentIndex + 1) % stream.queue.length;
  stream.songStartTime = Date.now();
  stream.lastActivity = Date.now();
  stream.nextVotes.clear(); // Reset votes
  
  sendStreamUpdate(streamId);
  
  const nextSong = stream.queue[stream.currentIndex];
  
  ctx.answerCbQuery('⏭️ Skipped to next song!', false);
  ctx.editMessageText(`⏭️ **Owner Skip Activated!**\n\n🎵 **Now Playing:** ${nextSong?.meta?.title || 'Unknown'}\n📊 **Stream:** \`${streamId}\`\n\n💡 **Note:** Vote skips were reset. Users can start voting again!`, {
    parse_mode: 'Markdown'
  });
});

// Enhanced queue command with better notifications
bot.command('queue', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Usage: /queue <streamId> <song name>');

  const streamId = args[1];
  const query = args.slice(2).join(' ');
  const stream = streams[streamId];
  if (!stream) return ctx.reply('❌ Stream not found.');

  const userId = ctx.from.id.toString();
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

    if (audioMeta.size > MAX_FILE_SIZE) {
      fs.unlinkSync(filePath);
      return ctx.reply('❌ **File too large!**\n\nThis file is over 15MB. Please choose a shorter song or a different version.');
    }

    if (audioMeta.duration > MAX_DURATION) {
      fs.unlinkSync(filePath);
      return ctx.reply('❌ **Song too long!**\n\nThis song is over 15 minutes long. Please choose a shorter song.');
    }

    const songId = crypto.createHash('md5').update(songData.video_url).digest('hex');
    
    const songInfo = {
      fileName,
      meta: {
        songId,
        title: songData.title,
        thumbnail: songData.thumbnail,
        duration: audioMeta.duration,
        views: songData.views,
        published: songData.published,
        source: songData.video_url
      }
    };

    // Save song to database
    songDatabase.set(songId, {
      id: songId,
      meta: songInfo.meta,
      addedAt: new Date().toISOString(),
      addedBy: userId
    });

    stream.queue.push(songInfo);
    stream.lastActivity = Date.now();

    // Update user stats
    const stats = initUserStats(userId, queuedBy);
    stats.songsQueued += 1;
    const newAchievements = checkAchievements(userId);
    savePersistentData();

    sendStreamUpdate(streamId);

    const duration = Math.floor(audioMeta.duration / 60) + ':' + Math.floor(audioMeta.duration % 60).toString().padStart(2, '0');
    const reactions = songReactions.get(songId) || { total: 0, breakdown: {} };
    
    let confirmationText = `✅ **Song Added Successfully!**\n\n🎵 **Title:** ${songData.title}\n⏱️ **Duration:** ${duration}\n📊 **Stream:** \`${streamId}\`\n📝 **Queue Position:** #${stream.queue.length}\n${reactions.total > 0 ? `💝 **Previous Reactions:** ${reactions.total}` : ''}\n\n🎧 Your song will play automatically when it's its turn!`;
    
    // Add achievement notification
    if (newAchievements.length > 0) {
      const achievementNames = {
        music_lover: '🎵 Music Lover',
        music_addict: '🎵 Music Addict', 
        dj: '🎧 DJ Master',
        queue_master: '📝 Queue Master'
      };
      const newAchievementsList = newAchievements.map(a => achievementNames[a]).join(', ');
      confirmationText += `\n\n🏆 **New Achievement(s):** ${newAchievementsList}`;
    }

    await ctx.replyWithPhoto(songData.thumbnail, {
      caption: confirmationText,
      parse_mode: 'Markdown'
    });

    await notifyUsersAboutNewSong(streamId, songInfo, queuedBy);

  } catch (err) {
    console.error(err);
    ctx.reply('❌ Failed to add song. Please try again.');
  }
});

// Enhanced notification function
async function notifyUsersAboutNewSong(streamId, songData, queuedBy) {
  const stream = streams[streamId];
  if (!stream || !stream.users) return;

  const duration = Math.floor(songData.meta.duration / 60) + ':' + Math.floor(songData.meta.duration % 60).toString().padStart(2, '0');
  const reactions = songReactions.get(songData.meta.songId) || { total: 0, breakdown: {} };
  
  let caption = `🎵 **New Song Added to Stream!**

🎶 **Title:** ${songData.meta.title}
⏱️ **Duration:** ${duration}
👤 **Added by:** ${queuedBy}
📊 **Stream ID:** \`${streamId}\`
📝 **Queue Position:** #${stream.queue.length}`;

  if (reactions.total > 0) {
    caption += `\n💝 **Previous Reactions:** ${reactions.total}`;
  }

  caption += `\n\n🎧 The song will play automatically when it's its turn!
✨ React with ${REACTION_EMOJIS.join(' ')} and vote to skip!`;

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
      if (err.code === 403) {
        stream.users.delete(userId);
        broadcastUserUpdate(streamId, 'user_left', { id: userId, name: user.name, reason: 'blocked_bot' });
      }
    }
  }
}

// 🏆 Top command to see popular songs
bot.command('top', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const limit = Math.min(parseInt(args[1]) || 10, 20); // Max 20 songs
  
  const topSongs = Array.from(songReactions.entries())
    .map(([songId, reactions]) => ({
      songId,
      reactions,
      songData: songDatabase.get(songId)
    }))
    .filter(item => item.songData)
    .sort((a, b) => b.reactions.total - a.reactions.total)
    .slice(0, limit);

  if (topSongs.length === 0) {
    return ctx.reply('📊 **No songs with reactions yet!**\n\nBe the first to react to songs in streams!');
  }

  let message = `🏆 **Top ${limit} Most Reacted Songs**\n\n`;
  
  topSongs.forEach((song, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
    message += `${medal} **${song.songData.meta.title}**\n`;
    message += `   💝 ${song.reactions.total} reactions\n\n`;
  });

  ctx.reply(message, { parse_mode: 'Markdown' });
});

// 🌍 Global stats command
bot.command('global', async (ctx) => {
  const totalUsers = userStats.size;
  const totalSongs = songDatabase.size;
  const totalReactions = Array.from(songReactions.values())
    .reduce((sum, reactions) => sum + reactions.total, 0);
  
  const totalListeningTime = Array.from(userStats.values())
    .reduce((sum, user) => sum + user.totalListeningTime, 0);

  const activeStreams = Object.keys(streams).length;

  const topUsers = Array.from(userStats.values())
    .sort((a, b) => b.totalSongsListened - a.totalSongsListened)
    .slice(0, 5);

  let message = `🌍 **Global Platform Statistics**

👥 **Total Users:** ${totalUsers}
🎵 **Total Songs:** ${totalSongs}
💝 **Total Reactions:** ${totalReactions}
⏱️ **Total Hours Played:** ${Math.round(totalListeningTime / 3600)}h
📻 **Active Streams:** ${activeStreams}

🏆 **Top Listeners:**
`;

  topUsers.forEach((user, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
    message += `${medal} ${user.name} - ${user.totalSongsListened} songs\n`;
  });

  ctx.reply(message, { parse_mode: 'Markdown' });
});

// Auto-advance with enhanced tracking
setInterval(() => {
  for (const streamId in streams) {
    const stream = streams[streamId];
    const current = stream.queue[stream.currentIndex];
    if (!current) continue;

    const elapsed = (Date.now() - stream.songStartTime) / 1000;
    if (elapsed >= current.meta.duration) {
      // Track listening for all users in stream
      if (stream.users) {
        for (const [userId] of stream.users) {
          updateUserListeningStats(userId, current, current.meta.duration);
        }
      }

      stream.currentIndex = (stream.currentIndex + 1) % stream.queue.length;
      stream.songStartTime = Date.now();
      stream.lastActivity = Date.now();
      stream.nextVotes.clear(); // Reset votes for new song
      sendStreamUpdate(streamId);
    }
  }
}, 1000);

// Save data more frequently
setInterval(savePersistentData, 5 * 60 * 1000); // Every 5 minutes

bot.launch();
server.listen(3000, () => console.log('🚀 Enhanced Music Bot Server running on port 3000'));
