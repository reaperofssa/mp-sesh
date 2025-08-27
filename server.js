const { Telegraf } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg'); // For getting audio metadata

const bot = new Telegraf('7069823048:AAFQsVqMR04ocQpvknEHjKyboisuNR7SJ8s');
const app = express();

// Folder to store uploaded songs
const SONGS_DIR = path.join(__dirname, 'songs');
if (!fs.existsSync(SONGS_DIR)) fs.mkdirSync(SONGS_DIR);

// In-memory stream storage
// streamId -> { 
//   queue: [{fileName, title, duration, thumbnail, views, published}], 
//   currentIndex, 
//   songStartTime,
//   isPaused,
//   pausedAt 
// }
const streams = {};

// Serve public files
app.use(express.static('public'));
app.use('/songs', express.static(SONGS_DIR));
app.use(express.json());

// YouTube API integration
async function searchYouTube(query) {
  try {
    const response = await axios.get(`https://apis.davidcyriltech.my.id/play?query=${encodeURIComponent(query)}`);
    return response.data;
  } catch (error) {
    console.error('YouTube API error:', error);
    return null;
  }
}

// Download audio from YouTube
async function downloadYouTubeAudio(downloadUrl, fileName) {
  const filePath = path.join(SONGS_DIR, fileName);
  const writer = fs.createWriteStream(filePath);
  
  const response = await axios({
    url: downloadUrl,
    method: 'GET',
    responseType: 'stream'
  });
  
  response.data.pipe(writer);
  
  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(filePath));
    writer.on('error', reject);
  });
}

// Get audio duration using ffprobe
function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        // Fallback to file size estimation
        const stats = fs.statSync(filePath);
        const estimatedDuration = stats.size / (128 * 1024 / 8);
        resolve(estimatedDuration);
      } else {
        resolve(metadata.format.duration);
      }
    });
  });
}

app.get('/stream/:streamId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stream.html'));
});

// Enhanced endpoint to get current track + elapsed time + all metadata
app.get('/stream/:streamId/currentTrack', async (req, res) => {
  const stream = streams[req.params.streamId];
  if (!stream) return res.status(404).json({ error: 'Stream not found' });

  const now = Date.now();
  const currentSong = stream.queue[stream.currentIndex];
  if (!currentSong) {
    return res.json({
      song: null,
      elapsed: 0,
      duration: 0,
      queue: stream.queue,
      currentIndex: stream.currentIndex,
      isPlaying: false
    });
  }

  let elapsed = 0;
  let isPlaying = !stream.isPaused;

  if (stream.isPaused) {
    elapsed = (stream.pausedAt - stream.songStartTime) / 1000;
  } else {
    elapsed = (now - stream.songStartTime) / 1000;
  }

  // Check if song has finished
  if (elapsed >= currentSong.duration && !stream.isPaused) {
    // Auto-advance to next song
    stream.currentIndex = (stream.currentIndex + 1) % stream.queue.length;
    stream.songStartTime = Date.now();
    elapsed = 0;
    const newCurrentSong = stream.queue[stream.currentIndex];
    
    return res.json({
      song: `/songs/${newCurrentSong.fileName}`,
      elapsed: 0,
      duration: newCurrentSong.duration,
      title: newCurrentSong.title,
      thumbnail: newCurrentSong.thumbnail,
      views: newCurrentSong.views,
      published: newCurrentSong.published,
      queue: stream.queue,
      currentIndex: stream.currentIndex,
      isPlaying: true,
      autoAdvanced: true
    });
  }

  res.json({
    song: `/songs/${currentSong.fileName}`,
    elapsed: Math.min(elapsed, currentSong.duration),
    duration: currentSong.duration,
    title: currentSong.title,
    thumbnail: currentSong.thumbnail,
    views: currentSong.views,
    published: currentSong.published,
    queue: stream.queue,
    currentIndex: stream.currentIndex,
    isPlaying
  });
});

// Control playback
app.post('/stream/:streamId/control', (req, res) => {
  const stream = streams[req.params.streamId];
  if (!stream) return res.status(404).json({ error: 'Stream not found' });

  const { action, position } = req.body;

  switch (action) {
    case 'pause':
      stream.isPaused = true;
      stream.pausedAt = Date.now();
      break;
    
    case 'play':
      if (stream.isPaused) {
        const pauseDuration = Date.now() - stream.pausedAt;
        stream.songStartTime += pauseDuration;
        stream.isPaused = false;
        delete stream.pausedAt;
      }
      break;
    
    case 'seek':
      if (typeof position === 'number') {
        stream.songStartTime = Date.now() - (position * 1000);
        if (stream.isPaused) {
          stream.pausedAt = Date.now();
        }
      }
      break;
    
    case 'next':
      stream.currentIndex = (stream.currentIndex + 1) % stream.queue.length;
      stream.songStartTime = Date.now();
      stream.isPaused = false;
      delete stream.pausedAt;
      break;
    
    case 'previous':
      stream.currentIndex = (stream.currentIndex - 1 + stream.queue.length) % stream.queue.length;
      stream.songStartTime = Date.now();
      stream.isPaused = false;
      delete stream.pausedAt;
      break;
  }

  res.json({ success: true });
});

// Start a new stream: /stream or /stream <youtube_search_query>
bot.command('stream', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  const query = args.join(' ');
  
  // Check for audio/document in current message OR replied message
  const messageWithFile = ctx.message.audio || ctx.message.document || 
    (ctx.message.reply_to_message && (ctx.message.reply_to_message.audio || ctx.message.reply_to_message.document));

  let songData = null;

  try {
    if (messageWithFile) {
      // Handle uploaded file
      const fileLink = await ctx.telegram.getFileLink(messageWithFile.file_id);
      const ext = path.extname(messageWithFile.file_name || 'song.mp3');
      const fileName = crypto.randomUUID() + ext;
      const filePath = path.join(SONGS_DIR, fileName);

      const writer = fs.createWriteStream(filePath);
      const response = await axios({ url: fileLink.href, method: 'GET', responseType: 'stream' });
      response.data.pipe(writer);
      await new Promise(resolve => writer.on('finish', resolve));

      const duration = await getAudioDuration(filePath);
      
      songData = {
        fileName,
        title: messageWithFile.file_name || 'Unknown Title',
        duration,
        thumbnail: null,
        views: 0,
        published: 'Unknown'
      };
    } else if (query) {
      // Handle YouTube search
      const ytResult = await searchYouTube(query);
      if (!ytResult || !ytResult.status) {
        return ctx.reply('Failed to find song on YouTube. Please try a different search query.');
      }

      const ext = '.mp3';
      const fileName = crypto.randomUUID() + ext;
      
      await downloadYouTubeAudio(ytResult.result.download_url, fileName);
      const filePath = path.join(SONGS_DIR, fileName);
      const duration = await getAudioDuration(filePath);

      songData = {
        fileName,
        title: ytResult.result.title,
        duration: duration,
        thumbnail: ytResult.result.thumbnail,
        views: ytResult.result.views,
        published: ytResult.result.published
      };
    } else {
      return ctx.reply('Please send an audio file with the command or provide a YouTube search query.\nExample: /stream never gonna give you up');
    }

    const streamId = crypto.randomUUID();
    streams[streamId] = {
      queue: [songData],
      currentIndex: 0,
      songStartTime: Date.now(),
      isPaused: false
    };

    ctx.reply(`🎵 Your stream has started!\n🔗 Link: https://mp-sesh.onrender.com/stream/${streamId}\n🎶 Playing: ${songData.title}`);
  } catch (err) {
    console.error(err);
    ctx.reply('Failed to start stream. Please try again.');
  }
});

// Add song to existing stream: /queue <streamId> or /queue <streamId> <youtube_query>
bot.command('queue', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) return ctx.reply('Usage: /queue <streamId> with attached audio file OR /queue <streamId> <youtube_search_query>');

  const streamId = args[0];
  const stream = streams[streamId];
  if (!stream) return ctx.reply('Stream not found.');

  const query = args.slice(1).join(' ');
  
  // Check for audio/document in current message OR replied message
  const file = ctx.message.audio || ctx.message.document ||
               (ctx.message.reply_to_message && (ctx.message.reply_to_message.audio || ctx.message.reply_to_message.document));

  let songData = null;

  try {
    if (file) {
      // Handle uploaded file
      const fileLink = await ctx.telegram.getFileLink(file.file_id);
      const ext = path.extname(file.file_name || 'song.mp3');
      const fileName = crypto.randomUUID() + ext;
      const filePath = path.join(SONGS_DIR, fileName);

      const writer = fs.createWriteStream(filePath);
      const response = await axios({ url: fileLink.href, method: 'GET', responseType: 'stream' });
      response.data.pipe(writer);
      await new Promise(resolve => writer.on('finish', resolve));

      const duration = await getAudioDuration(filePath);
      
      songData = {
        fileName,
        title: file.file_name || 'Unknown Title',
        duration,
        thumbnail: null,
        views: 0,
        published: 'Unknown'
      };
    } else if (query) {
      // Handle YouTube search
      const ytResult = await searchYouTube(query);
      if (!ytResult || !ytResult.status) {
        return ctx.reply('Failed to find song on YouTube. Please try a different search query.');
      }

      const ext = '.mp3';
      const fileName = crypto.randomUUID() + ext;
      
      await downloadYouTubeAudio(ytResult.result.download_url, fileName);
      const filePath = path.join(SONGS_DIR, fileName);
      const duration = await getAudioDuration(filePath);

      songData = {
        fileName,
        title: ytResult.result.title,
        duration: duration,
        thumbnail: ytResult.result.thumbnail,
        views: ytResult.result.views,
        published: ytResult.result.published
      };
    } else {
      return ctx.reply('Please attach an audio file or provide a YouTube search query to add to the queue.\nExample: /queue ' + streamId + ' bohemian rhapsody');
    }

    stream.queue.push(songData);
    ctx.reply(`🎶 Song added to queue!\n📝 Title: ${songData.title}\n📊 Queue position: ${stream.queue.length}`);
  } catch (err) {
    console.error(err);
    ctx.reply('Failed to add song to queue.');
  }
});

// Remove the old auto-advance setInterval since we handle it in the API endpoint now

// Start bot
bot.launch();
console.log('Bot started');

// Start Express server
app.listen(3000, () => console.log('Server running on port 3000'));
