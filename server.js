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
// streams[streamId] = { queue, currentIndex, songStartTime, clients:Set(ws) }
const streams = {};

app.use(express.static('public'));
app.use('/songs', express.static(SONGS_DIR));

// Serve player
app.get('/stream/:streamId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stream.html'));
});

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
      clients: new Set()
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
