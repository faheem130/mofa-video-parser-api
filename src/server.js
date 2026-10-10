require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Transform, Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const crypto = require("node:crypto");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || "";
const YOUTUBE_KEY = process.env.YOUTUBE_DATA_API_KEY || "";
const ORIGINS = (process.env.ALLOWED_ORIGIN || "").split(",").map(s=>s.trim()).filter(Boolean);
const MEDIA_HOSTS = new Set((process.env.AUTHORIZED_MEDIA_HOSTS || "").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean));
const MAX_BYTES = Math.max(1, Number(process.env.MAX_DOWNLOAD_BYTES || 52428800));

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: ORIGINS.length ? ORIGINS : false }));
app.use(express.json({limit:"20kb"}));
app.use(express.urlencoded({extended:false,limit:"20kb"}));
app.use("/api", rateLimit({windowMs:60000,limit:30,standardHeaders:"draft-7",legacyHeaders:false}));

function requireApiKey(req,res,next) {
  const supplied = req.get("x-api-key") || "";
  if (!API_KEY) return res.status(503).json({success:false,error:"API_KEY is not configured."});
  const a=Buffer.from(supplied), b=Buffer.from(API_KEY);
  if (a.length!==b.length || !crypto.timingSafeEqual(a,b))
    return res.status(401).json({success:false,error:"Invalid API key."});
  next();
}
function parseYouTubeId(input) {
  try {
    const u=new URL(input), host=u.hostname.toLowerCase().replace(/^www\./,"");
    let id=null;
    if(host==="youtu.be") id=u.pathname.split("/").filter(Boolean)[0];
    else if(["youtube.com","m.youtube.com","music.youtube.com"].includes(host)) {
      id=u.searchParams.get("v");
      if(!id) { const p=u.pathname.split("/").filter(Boolean); if(["embed","shorts","live"].includes(p[0])) id=p[1]; }
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
function isoSeconds(v) {
  if(!v) return null;
  const m=v.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  return m ? Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0) : null;
}
app.get("/",(_req,res)=>res.json({success:true,name:"Mofa Video Parser API",version:"2.0.0",endpoints:{
  health:"GET /health",youtubeMetadata:"POST /api/youtube/metadata",authorizedMediaDownload:"POST /api/media/download"
}}));
app.get("/health",(_req,res)=>res.json({success:true,service:"mofa-video-parser-api"}));

// Official YouTube Data API: metadata only; deliberately no media extraction/download URLs.
app.post("/api/youtube/metadata",requireApiKey,async(req,res)=>{
  if(!YOUTUBE_KEY) return res.status(503).json({success:false,error:"YOUTUBE_DATA_API_KEY is not configured."});
  const id=parseYouTubeId(String(req.body?.link||req.body?.url||"").trim());
  if(!id) return res.status(400).json({success:false,error:"Provide a valid YouTube video URL."});
  try {
    const u=new URL("https://www.googleapis.com/youtube/v3/videos");
    u.searchParams.set("part","snippet,contentDetails,status"); u.searchParams.set("id",id); u.searchParams.set("key",YOUTUBE_KEY);
    const r=await fetch(u,{signal:AbortSignal.timeout(12000)}), data=await r.json();
    if(!r.ok) return res.status(r.status===403?502:r.status).json({success:false,error:"YouTube Data API request failed.",reason:data?.error?.errors?.[0]?.reason||"youtube_api_error"});
    const v=data.items?.[0];
    if(!v) return res.status(404).json({success:false,error:"Video not found or not accessible through the API."});
    const s=v.snippet||{}, d=v.contentDetails||{};
    res.json({success:true,source:"YouTube Data API v3",id:v.id,title:s.title||null,description:s.description||null,
      channelTitle:s.channelTitle||null,channelId:s.channelId||null,publishedAt:s.publishedAt||null,
      thumbnails:s.thumbnails||{},duration:d.duration||null,durationSeconds:isoSeconds(d.duration),
      embeddable:v.status?.embeddable??null,watchUrl:`https://www.youtube.com/watch?v=${v.id}`});
  } catch(e) { res.status(502).json({success:false,error:"Could not reach the YouTube Data API.",detail:String(e.message||"Network error").slice(0,200)}); }
});

// Separate proxy for authorized files on explicitly allowlisted HTTPS hosts.
// Do not add YouTube/googlevideo hosts; this is not a YouTube download route.
app.post("/api/media/download",requireApiKey,async(req,res)=>{
  let u;
  try { u=new URL(String(req.body?.url||"").trim()); } catch { return res.status(400).json({success:false,error:"Provide a valid media URL."}); }
  if(u.protocol!=="https:"||u.username||u.password||!MEDIA_HOSTS.has(u.hostname.toLowerCase()))
    return res.status(403).json({success:false,error:"HTTPS host is not allowlisted. Use only sources you own or are licensed to download."});
  try {
    const upstream=await fetch(u,{redirect:"manual",signal:AbortSignal.timeout(20000),headers:{"User-Agent":"MofaAuthorizedMediaProxy/1.0"}});
    if(upstream.status>=300&&upstream.status<400) { await upstream.body?.cancel(); return res.status(502).json({success:false,error:"Redirects are disabled; use the final authorized HTTPS URL."}); }
    if(!upstream.ok||!upstream.body) return res.status(502).json({success:false,error:`Media source returned HTTP ${upstream.status}.`});
    const type=upstream.headers.get("content-type")||"application/octet-stream";
    if(!(type.startsWith("video/")||type.startsWith("audio/")||type==="application/octet-stream")) {
      await upstream.body.cancel(); return res.status(415).json({success:false,error:"Source did not return an audio/video or binary media type."});
    }
    const lenHeader=upstream.headers.get("content-length"), len=lenHeader?Number(lenHeader):null;
    if(len!==null&&Number.isFinite(len)&&len>MAX_BYTES) { await upstream.body.cancel(); return res.status(413).json({success:false,error:"Media exceeds MAX_DOWNLOAD_BYTES."}); }
    let total=0;
    const limiter=new Transform({transform(chunk,_enc,cb){total+=chunk.length;cb(total>MAX_BYTES?new Error("MAX_DOWNLOAD_BYTES exceeded"):null,chunk);}});
    const name=(u.pathname.split("/").filter(Boolean).pop()||"authorized-media").replace(/[^A-Za-z0-9._-]/g,"_").slice(0,100);
    res.setHeader("Content-Type",type); res.setHeader("Content-Disposition",`attachment; filename="${name}"`);
    if(len!==null&&Number.isFinite(len)) res.setHeader("Content-Length",String(len));
    await pipeline(Readable.fromWeb(upstream.body),limiter,res);
  } catch(e) {
    if(!res.headersSent) res.status(502).json({success:false,error:"Authorized media download failed or exceeded the configured limit.",detail:String(e.message||"Stream error").slice(0,200)});
    else res.destroy(e);
  }
});
app.use((_req,res)=>res.status(404).json({success:false,error:"Not found."}));
app.listen(PORT,"0.0.0.0",()=>console.log(`Mofa Video Parser API listening on port ${PORT}`));
