
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const https = require("https");
const path = require("path");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 10000;

const API_KEY = process.env.API_KEY || "";
const YOUTUBE_API_KEY = process.env.YOUTUBE_DATA_API_KEY || "";

const ALLOWED_HOSTS = (process.env.AUTHORIZED_MEDIA_HOSTS || "")
  .split(",")
  .map(host => host.trim().toLowerCase())
  .filter(Boolean);

const MAX_BYTES = Math.max(
  1024,
  Number(process.env.MAX_DOWNLOAD_BYTES || 52428800)
);

app.disable("x-powered-by");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || true
}));
app.use(express.json({ limit: "32kb" }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

app.use(express.static(path.join(__dirname, "../public")));

// -------------------- API AUTHENTICATION --------------------

function apiAuth(req, res, next) {
  if (!API_KEY || req.get("X-API-Key") !== API_KEY) {
    return res.status(401).json({
      success: false,
      error: "Invalid or missing API key."
    });
  }

  next();
}

// -------------------- YOUTUBE URL VALIDATION --------------------

function getVideoId(input) {
  if (typeof input !== "string") return null;

  const value = input.trim();

  if (/^[A-Za-z0-9_-]{11}$/.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    if (host === "youtu.be" || host === "www.youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
    }

    const validHosts = [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com"
    ];

    if (!validHosts.includes(host)) return null;

    const match = url.pathname.match(
      /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/
    );

    const id = url.searchParams.get("v") || match?.[1];

    return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
  } catch {
    return null;
  }
}

// -------------------- YOUTUBE METADATA --------------------

async function fetchYouTubeMetadata(req, res) {
  if (!YOUTUBE_API_KEY) {
    return res.status(503).json({
      success: false,
      error: "YOUTUBE_DATA_API_KEY is not configured on the server."
    });
  }

  const id = getVideoId(req.body?.url || req.body?.videoId);

  if (!id) {
    return res.status(400).json({
      success: false,
      error: "Enter a valid YouTube URL or 11-character video ID."
    });
  }

  try {
    const endpoint = new URL(
      "https://www.googleapis.com/youtube/v3/videos"
    );

    endpoint.search = new URLSearchParams({
      part: "snippet,contentDetails,status",
      id,
      key: YOUTUBE_API_KEY
    }).toString();

    const response = await fetch(endpoint);
    const data = await response.json();

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        error: data.error?.message || "YouTube API request failed."
      });
    }

    const video = data.items?.[0];

    if (!video) {
      return res.status(404).json({
        success: false,
        error: "Video not found or unavailable."
      });
    }

    const duration = video.contentDetails?.duration || "PT0S";
    const parts = duration.match(
      /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/
    );

    const durationSeconds = parts
      ? Number(parts[1] || 0) * 3600 +
        Number(parts[2] || 0) * 60 +
        Number(parts[3] || 0)
      : null;

    return res.json({
      success: true,
      source: "YouTube Data API v3",
      id,
      title: video.snippet?.title || "",
      description: video.snippet?.description || "",
      channelTitle: video.snippet?.channelTitle || "",
      channelId: video.snippet?.channelId || "",
      publishedAt: video.snippet?.publishedAt || "",
      thumbnails: video.snippet?.thumbnails || {},
      duration,
      durationSeconds,
      embeddable: Boolean(video.status?.embeddable),
      watchUrl: `https://www.youtube.com/watch?v=${id}`
    });
  } catch (error) {
    console.error("YouTube metadata error:", error.message);

    return res.status(502).json({
      success: false,
      error: "Unable to contact YouTube Data API."
    });
  }
}

// Website endpoint: API key remains on the server.
app.post("/api/site/metadata", fetchYouTubeMetadata);

// Protected endpoint for your own API clients.
app.post("/api/youtube/metadata", apiAuth, fetchYouTubeMetadata);

// -------------------- AUTHORIZED MEDIA DOWNLOADS --------------------

function downloadAuthorizedMedia(req, res) {
  let mediaUrl;

  try {
    mediaUrl = new URL(req.body?.url);
  } catch {
    return res.status(400).json({
      success: false,
      error: "Provide a valid direct media URL."
    });
  }

  if (
    mediaUrl.protocol !== "https:" ||
    mediaUrl.username ||
    mediaUrl.password ||
    !ALLOWED_HOSTS.includes(mediaUrl.hostname.toLowerCase())
  ) {
    return res.status(403).json({
      success: false,
      error: "This HTTPS media host is not allowlisted by the server owner."
    });
  }

  const upstream = https.get(mediaUrl, {
    timeout: 15000,
    headers: {
      "User-Agent": "MofaMediaClient/1.0"
    }
  }, remote => {
    if (remote.statusCode !== 200) {
      remote.resume();

      return res.status(502).json({
        success: false,
        error: "Media host did not return a downloadable file."
      });
    }

    const contentType = String(
      remote.headers["content-type"] || "application/octet-stream"
    ).split(";")[0].toLowerCase();

    const validTypes =
      contentType.startsWith("video/") ||
      contentType.startsWith("audio/") ||
      contentType === "application/octet-stream";

    if (!validTypes) {
      remote.resume();

      return res.status(415).json({
        success: false,
        error: "The URL does not appear to be a video or audio file."
      });
    }

    const length = Number(remote.headers["content-length"] || 0);

    if (length > MAX_BYTES) {
      remote.resume();

      return res.status(413).json({
        success: false,
        error: "File exceeds the configured download limit."
      });
    }

    let bytesReceived = 0;
    let stopped = false;

    remote.on("data", chunk => {
      bytesReceived += chunk.length;

      if (!stopped && bytesReceived > MAX_BYTES) {
        stopped = true;
        remote.destroy();

        if (!res.headersSent) {
          res.status(413).json({
            success: false,
            error: "File exceeds the configured download limit."
          });
        } else {
          res.destroy();
        }
      }
    });

    remote.on("error", () => {
      if (!res.headersSent) {
        res.status(502).json({
          success: false,
          error: "The media download was interrupted."
        });
      } else {
        res.destroy();
      }
    });

    if (stopped) return;

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="mofa-media-file"'
    );
    res.setHeader("X-Content-Type-Options", "nosniff");

    remote.pipe(res);
  });

  upstream.on("timeout", () => {
    upstream.destroy(new Error("Media request timed out"));
  });

  upstream.on("error", error => {
    console.error("Media download error:", error.message);

    if (!res.headersSent) {
      res.status(502).json({
        success: false,
        error: "Unable to fetch this media file."
      });
    } else {
      res.destroy();
    }
  });

  res.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });
}

// Public website route; still rate-limited and host-restricted.
app.post("/api/site/media-download", downloadAuthorizedMedia);

// Protected endpoint for API clients.
app.post("/api/media/download", apiAuth, downloadAuthorizedMedia);

// -------------------- HEALTH AND ROUTES --------------------

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    status: "ok",
    service: "Mofa Video Parser API"
  });
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      success: false,
      error: "API endpoint not found."
    });
  }

  res.sendFile(path.join(__dirname, "../public/index.html"), error => {
    if (error) next(error);
  });
});

app.use((error, _req, res, _next) => {
  console.error("Server error:", error.message);

  if (!res.headersSent) {
    res.status(500).json({
      success: false,
      error: "Internal server error."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Mofa Video Parser listening on port ${PORT}`);
});
