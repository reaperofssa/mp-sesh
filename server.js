const { Telegraf } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const bot = new Telegraf('7069823048:AAFQsVqMR04ocQpvknEHjKyboisuNR7SJ8s');
const app = express();

// Folder to store uploaded songs
const SONGS_DIR = path.join(__dirname, 'songs');
if (!fs.existsSync(SONGS_DIR)) fs.mkdirSync(SONGS_DIR);

// In-memory stream storage
// streamId -> { queue: [fileNames], currentIndex, songStartTime }
const streams = {};

// Serve public files
app.use(express.static('public'));
app.use('/songs', express.static(SONGS_DIR));

app.get('/stream/:streamId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stream.html'));
});
// Endpoint to get current track + elapsed time
app.get('/stream/:streamId/currentTrack', (req, res) => {
  const stream = streams[req.params.streamId];
  if (!stream) return res.status(404).send('Stream not found');

  const now = Date.now();
  const currentSong = stream.queue[stream.currentIndex];
  const elapsed = (now - stream.songStartTime) / 1000;

  res.json({
    song: `/songs/${currentSong}`,
    elapsed,
    queue: stream.queue,
    currentIndex: stream.currentIndex
  });
});

// Start a new stream: /stream
bot.command('stream', async (ctx) => {
  // Check for audio/document in current message OR replied message
  const messageWithFile = ctx.message.audio || ctx.message.document || (ctx.message.reply_to_message && (ctx.message.reply_to_message.audio || ctx.message.reply_to_message.document));
  if (!messageWithFile) return ctx.reply('Please send an audio file with the command.');

  try {
    const fileLink = await ctx.telegram.getFileLink(messageWithFile.file_id);
    const ext = path.extname(messageWithFile.file_name || 'song.mp3');
    const fileName = crypto.randomUUID() + ext;
    const filePath = path.join(SONGS_DIR, fileName);

    const writer = fs.createWriteStream(filePath);
    const response = await axios({ url: fileLink.href, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    await new Promise(resolve => writer.on('finish', resolve));

    const streamId = crypto.randomUUID();
    streams[streamId] = {
      queue: [fileName],
      currentIndex: 0,
      songStartTime: Date.now()
    };

    ctx.reply(`Your stream has started: https://yourdomain.com/stream/${streamId}`);
  } catch (err) {
    console.error(err);
    ctx.reply('Failed to start stream.');
  }
});

// Add song to existing stream: /queue <streamId>
bot.command('queue', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Usage: /queue <streamId> with attached audio file');

  const streamId = args[1];
  const stream = streams[streamId];
  if (!stream) return ctx.reply('Stream not found.');

  // Check for audio/document in current message OR replied message
  const file = ctx.message.audio || ctx.message.document ||
               (ctx.message.reply_to_message && (ctx.message.reply_to_message.audio || ctx.message.reply_to_message.document));

  if (!file) return ctx.reply('Please attach an audio file or reply to one to add to the queue.');

  try {
    const fileLink = await ctx.telegram.getFileLink(file.file_id);
    const ext = path.extname(file.file_name || 'song.mp3');
    const fileName = crypto.randomUUID() + ext;
    const filePath = path.join(SONGS_DIR, fileName);

    const writer = fs.createWriteStream(filePath);
    const response = await axios({ url: fileLink.href, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    await new Promise(resolve => writer.on('finish', resolve));

    stream.queue.push(fileName);
    ctx.reply(`Song added to stream ${streamId} queue!`);
  } catch (err) {
    console.error(err);
    ctx.reply('Failed to add song to queue.');
  }
});

// Auto-advance function (runs every second)
setInterval(() => {
  for (const streamId in streams) {
    const stream = streams[streamId];
    const currentSong = stream.queue[stream.currentIndex];
    if (!currentSong) continue;

    const filePath = path.join(SONGS_DIR, currentSong);
    if (!fs.existsSync(filePath)) continue;

    const stats = fs.statSync(filePath);
    const durationSec = stats.size / (128 * 1024 / 8); // rough MP3 duration estimate
    const elapsed = (Date.now() - stream.songStartTime) / 1000;

    if (elapsed >= durationSec) {
      // Move to next song
      stream.currentIndex = (stream.currentIndex + 1) % stream.queue.length;
      stream.songStartTime = Date.now();
    }
  }
}, 1000);

// Start bot
bot.launch();

// Start Express server
app.listen(3000, () => console.log('Server running on port 3000'));
