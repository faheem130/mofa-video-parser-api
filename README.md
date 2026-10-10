# Mofa Video Parser API

A starter Node.js + Express API that parses metadata and available media formats for YouTube URLs. It is inspired by the general request/response pattern of a video parser, but is an independent implementation—not Vidssave's source code or private backend.

Use it only for videos you own or are authorized to download, and follow YouTube's terms and applicable copyright law. Do not use it to bypass access controls or restrictions.

## Requirements

- Node.js 20+
- `yt-dlp` installed and available on your PATH
- npm

Install yt-dlp using its official instructions: https://github.com/yt-dlp/yt-dlp#installation

## Run locally

```bash
npm install
cp .env.example .env
```

Edit `.env` and set a strong random `API_KEY`. Then run:

```bash
npm start
```

Health check: `GET http://localhost:3000/health`

## Parse endpoint

`POST http://localhost:3000/api/contentsite_api/media/parse`

Headers:
```http
Content-Type: application/json
X-API-Key: your-secret-key
```

Body:
```json
{
  "link": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

It also accepts `application/x-www-form-urlencoded` bodies with `link` and `auth` fields for basic compatibility with form-based clients. Prefer `X-API-Key` in production.

Example response shape:
```json
{
  "success": true,
  "title": "Example title",
  "thumbnail": "https://...",
  "duration": 123,
  "uploader": "Channel",
  "webpageUrl": "https://www.youtube.com/watch?v=VIDEO_ID",
  "resources": [
    {
      "formatId": "18",
      "quality": "360p",
      "format": "mp4",
      "hasVideo": true,
      "hasAudio": true,
      "filesize": 12345678,
      "url": "https://..."
    }
  ]
}
```

Media URLs can expire and may require headers/cookies. This starter returns format URLs; it does not proxy or store video files. For production, add logging, monitoring, stronger quotas, HTTPS, and an explicit authorized-use policy. Do not expose the API key in browser-side JavaScript; call the API from your own backend.
