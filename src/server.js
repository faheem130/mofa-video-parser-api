require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const app = express();

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({
  origin: ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(",").map(s => s.trim()) : false
}));
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return ["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)
      && url.protocol === "https:";
  } catch {
    return false;
  }
}

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return res.status(503).json({
      success: false,
      error: "API key is not configured. Set API_KEY in your .env file."
    });
  }
  const supplied = req.get("x-api-key") || req.body?.auth;
  if (supplied !== API_KEY) {
    return res.status(401).json({ success: false, error: "Invalid API key." });
  }
  next();
}

function runYtDlp(url) {
  // execFile passes arguments directly (no shell interpolation).
  return execFileAsync("yt-dlp", [
    "--dump-single-json",
    "--no-warnings",
    "--no-playlist",
    "--skip-download",
    "--socket-timeout", "15",
    "--retries", "1",
    url
  ], {
    timeout: 45000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
}

function getResources(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const seen = new Set();
  return formats
    .filter(f => f.url && (f.vcodec !== "none" || f.acodec !== "none"))
    .map(f => {
      const hasVideo = f.vcodec && f.vcodec !== "none";
      const hasAudio = f.acodec && f.acodec !== "none";
      const quality = f.height ? `${f.height}p` : (hasVideo ? "Video" : "Audio");
      const format = f.ext || "unknown";
      const key = `${f.format_id}|${quality}|${format}|${hasVideo}|${hasAudio}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        formatId: f.format_id,
        quality,
        format,
        hasVideo: Boolean(hasVideo),
        hasAudio: Boolean(hasAudio),
        filesize: f.filesize || f.filesize_approx || null,
        // These media URLs may expire and may require request headers.
        url: f.url
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const ah = Number.parseInt(a.quality, 10) || 0;
      const bh = Number.parseInt(b.quality, 10) || 0;
      return bh - ah;
    })
    .slice(0, 40);
}

app.get("/health", (_req, res) => {
  res.json({ success: true, service: "mofa-video-parser-api" });
});

// Similar endpoint shape to the publicly observed Vidssave route.
// This is an independent implementation, not Vidssave's private API.
app.post("/api/contentsite_api/media/parse", requireApiKey, async (req, res) => {
  const link = String(req.body?.link || "").trim();

  if (!link || !isYouTubeUrl(link)) {
    return res.status(400).json({
      success: false,
      error: "Provide a valid HTTPS YouTube or youtu.be URL in the 'link' field."
    });
  }

  try {
    const { stdout } = await runYtDlp(link);
    const info = JSON.parse(stdout);
    const resources = getResources(info);

    return res.json({
      success: true,
      title: info.title || null,
      thumbnail: info.thumbnail || null,
      duration: info.duration || null,
      uploader: info.uploader || null,
      webpageUrl: info.webpage_url || link,
      resources
    });
  } catch (err) {
    const detail = String(err.stderr || err.message || "Unknown extraction error")
      .replace(/\s+/g, " ")
      .slice(0, 500);

    return res.status(502).json({
      success: false,
      error: "Could not parse this video. It may be private, restricted, unavailable, or yt-dlp may need updating.",
      detail
    });
  }
});

app.use((_req, res) => res.status(404).json({ success: false, error: "Not found." }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mofa Video Parser API listening on port ${PORT}`);
});
