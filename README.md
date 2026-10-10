# Mofa Video Parser API v2

- `POST /api/youtube/metadata`: metadata through official YouTube Data API v3 only.
- `POST /api/media/download`: streams files only from allowlisted HTTPS hosts you own/control or are licensed to use. This does not download YouTube videos.

## Render deployment
Push to GitHub and deploy as a Docker Web Service using `Dockerfile`. Set:
- `API_KEY`: strong random secret
- `YOUTUBE_DATA_API_KEY`: Google Cloud API key with YouTube Data API v3 enabled
- `ALLOWED_ORIGIN`: your frontend origin, e.g. `https://yourwebsite.com`
- `AUTHORIZED_MEDIA_HOSTS`: comma-separated exact approved media hosts (do not add YouTube or googlevideo)
- `MAX_DOWNLOAD_BYTES`: e.g. `52428800` (50 MiB)
Set health check path to `/health`.

## Metadata test
curl -X POST "https://YOUR-SERVICE.onrender.com/api/youtube/metadata" \
  -H "Content-Type: application/json" -H "X-API-Key: YOUR_API_KEY" \
  -d '{"link":"https://www.youtube.com/watch?v=VIDEO_ID"}'

## Authorized media test
Only test with a direct file URL from an allowlisted host you own or are licensed to use:
curl -X POST "https://YOUR-SERVICE.onrender.com/api/media/download" \
  -H "Content-Type: application/json" -H "X-API-Key: YOUR_API_KEY" \
  -d '{"url":"https://media.yourdomain.com/sample.mp4"}' -o sample.mp4

Never commit `.env` or expose secrets in browser JavaScript. Review YouTube API Services terms and developer policies. The official YouTube Data API does not provide a general-purpose downloadable video URL.
