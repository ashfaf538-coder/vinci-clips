const express = require('express');
const router = express.Router();
const multer = require('multer');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const Transcript = require('../models/Transcript');
const Groq = require('groq-sdk');

const upload = multer({
  dest: 'uploads/temp/',
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

const tempDir = 'uploads/temp';
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

router.post('/file', upload.single('video'), async (req, res) => {
  const videoPath = req.file.path.trim();
  const mp3Path = `${videoPath}.mp3`;
  const thumbnailPath = `${videoPath}_thumbnail.jpg`;

  let transcript = await Transcript.create({
    originalFilename: req.file.originalname,
    transcript: [],
    status: 'uploading'
  });

  console.log(`Created transcript record ${transcript._id} with status: uploading`);

  try {
    const durationCmd = `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
    let videoDuration = null;
    try {
      videoDuration = await new Promise((resolve, reject) => {
        exec(durationCmd, (error, stdout) => {
          if (error) reject(error);
          else resolve(parseFloat(stdout.trim()));
        });
      });
    } catch (e) { console.warn(`Duration error: ${e}`); }

    transcript.status = 'converting';
    transcript = await Transcript.findByIdAndUpdate(transcript._id, transcript, { new: true });
    console.log(`Updated transcript ${transcript._id} status: converting`);

    const thumbnailCmd = `ffmpeg -i "${videoPath}" -ss 00:00:01 -vframes 1 "${thumbnailPath}"`;
    const ffmpegCmd = `ffmpeg -i "${videoPath}" -vn -acodec libmp3lame -q:a 2 "${mp3Path}"`;

    try {
      await new Promise((resolve, reject) => {
        exec(thumbnailCmd, (error) => { if (error) reject(error); else resolve(); });
      });
      console.log('Thumbnail generated successfully');
    } catch (e) { console.warn(`Thumbnail error: ${e}`); }

    exec(ffmpegCmd, async (error) => {
      if (error) {
        console.error(`ffmpeg error: ${error}`);
        transcript.status = 'failed';
        await Transcript.findByIdAndUpdate(transcript._id, transcript);
        fs.unlink(videoPath, () => {});
        fs.unlink(mp3Path, () => {});
        fs.unlink(thumbnailPath, () => {});
        return res.status(500).json({ error: 'Failed to convert video to MP3.' });
      }

      const videoFileName = req.file.originalname;
      const mp3FileName = videoFileName.replace(/\.[^/.]+$/, "") + ".mp3";
      const thumbnailFileName = videoFileName.replace(/\.[^/.]+$/, "") + "_thumbnail.jpg";

      const videoDestPath = path.join(__dirname, '..', '..', 'uploads', videoFileName);
      const mp3DestPath = path.join(__dirname, '..', '..', 'uploads', mp3FileName);
      const thumbnailDestPath = path.join(__dirname, '..', '..', 'uploads', thumbnailFileName);

      try {
        fs.renameSync(videoPath, videoDestPath);
        fs.renameSync(mp3Path, mp3DestPath);
        if (fs.existsSync(thumbnailPath)) {
          fs.renameSync(thumbnailPath, thumbnailDestPath);
        }

        const videoUrl = `/uploads/${videoFileName}`;
        const mp3Url = `/uploads/${mp3FileName}`;
        const thumbnailUrl = fs.existsSync(thumbnailDestPath) ? `/uploads/${thumbnailFileName}` : null;

        transcript.status = 'transcribing';
        transcript = await Transcript.findByIdAndUpdate(transcript._id, transcript, { new: true });
        console.log(`Updated transcript ${transcript._id} status: transcribing`);

        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

        const transcriptionResult = await groq.audio.transcriptions.create({
          file: fs.createReadStream(mp3DestPath),
          model: 'whisper-large-v3',
          response_format: 'verbose_json',
          timestamp_granularities: ['word'],
        });

        const words = transcriptionResult.words || [];
        const transcriptContent = words.map(w => ({
          start: formatTime(w.start),
          end: formatTime(w.end),
          text: w.word,
          speaker: 'Speaker 1'
        }));

        transcript.transcript = transcriptContent;
        transcript.videoUrl = videoUrl;
        transcript.mp3Url = mp3Url;
        transcript.duration = videoDuration;
        transcript.thumbnailUrl = thumbnailUrl;
        transcript.status = 'completed';
        const finalTranscript = await Transcript.findByIdAndUpdate(transcript._id, transcript, { new: true });
        console.log(`Transcript ${transcript._id} completed successfully`);

        res.status(200).json({ status: 'Transcription complete.', transcript: finalTranscript });

      } catch (apiError) {
        console.error(`Groq API error: ${apiError}`);
        transcript.status = 'failed';
        await Transcript.findByIdAndUpdate(transcript._id, transcript);
        res.status(500).json({ error: 'Failed to transcribe audio.' });
      }
    });
  } catch (err) {
    console.error(`Server error: ${err}`);
    res.status(500).json({ error: 'An unexpected server error occurred.' });
  }
});

function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  const ms = Math.round((seconds % 1) * 1000).toString().padStart(3, '0');
  return `${m}:${s}:${ms}`;
}

module.exports = router;
