const { Telegraf } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');

const bot = new Telegraf('7069823048:AAFeeFtSj_cbEiuSZm8uImysJIKrcYHlg4A');
const app = express();

// Songs folder
const SONGS_DIR = path.join(__dirname, 'songs');
if (!fs.existsSync(SONGS_DIR)) fs.mkdirSync(SONGS_DIR);

// Memory storage: streamId -> { queue: [ { fileName, meta } ], currentIndex, songStartTime }
const streams = {};

app.use(express.static('public'));
app.use('/songs', express.static(SONGS_DIR));

// Serve player page
app.get('/stream/:streamId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stream.html'));
});

// Current track metadata endpoint
app.get('/stream/:streamId/currentTrack', (req, res) => {
  const stream = streams[req.params.streamId];
  if (!stream) return res.status(404).send('Stream not found');

  const now = Date.now();
  const current = stream.queue[stream.currentIndex];
  const elapsed = (now - stream.songStartTime) / 1000;

  const nextIndex = (stream.currentIndex + 1) % stream.queue.length;
  const nextSong = stream.queue[nextIndex];

  res.json({
    elapsed,
    currentIndex: stream.currentIndex,
    current: {
      file: `/songs/${current.fileName}`,
      meta: current.meta
    },
    next: nextSong
      ? {
          file: `/songs/${nextSong.fileName}`,
          meta: nextSong.meta
        }
      : null,
    queue: stream.queue
  });
});

// Utility: fetch audio metadata
function getAudioMeta(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const format = metadata.format;
      resolve({
        duration: format.duration,
        size: format.size,
        bit_rate: format.bit_rate
      });
    });
  });
}

// 🎵 Start a new stream with API search: /stream <song name>
bot.command('stream', async (ctx) => {
  const query = ctx.message.text.split(' ').slice(1).join(' ');
  if (!query) return ctx.reply('Usage: /stream <song name>');

  try {
    // 🔎 Search from API
    const apiRes = await axios.get(`https://apis.davidcyriltech.my.id/play?query=${encodeURIComponent(query)}`);
    const songData = apiRes.data.result;

    // Download audio
    const ext = '.mp3';
    const fileName = crypto.randomUUID() + ext;
    const filePath = path.join(SONGS_DIR, fileName);

    const writer = fs.createWriteStream(filePath);
    const response = await axios({ url: songData.download_url, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    await new Promise(resolve => writer.on('finish', resolve));

    // Get metadata
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
      songStartTime: Date.now()
    };

    ctx.reply(`🎶 Your stream has started: https://yourdomain.com/stream/${streamId}`);
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Failed to start stream.');
  }
});

// 🎶 Queue another song: /queue <streamId> <song name>
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

    // Download audio
    const ext = '.mp3';
    const fileName = crypto.randomUUID() + ext;
    const filePath = path.join(SONGS_DIR, fileName);

    const writer = fs.createWriteStream(filePath);
    const response = await axios({ url: songData.download_url, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    await new Promise(resolve => writer.on('finish', resolve));

    // Get metadata
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

    ctx.reply(`✅ Added "${songData.title}" to stream ${streamId}`);
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Failed to add song to queue.');
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
    }
  }
}, 1000);

// Start bot + server
bot.launch();
app.listen(3000, () => console.log('🚀 Server running on port 3000'));
