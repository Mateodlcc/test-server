// ---------- UI ----------
const wsUrlEl = document.getElementById("wsUrl");
const robotIdEl = document.getElementById("robotId");
const stunEl = document.getElementById("stunUrl");
const modeEl = document.getElementById("mode");
const hfovEl = document.getElementById("hfov");
const vfovEl = document.getElementById("vfov");
const video360Sel = document.getElementById("video360Sel");
const webcamResEl = document.getElementById("webcamRes");
const webcamFpsEl = document.getElementById("webcamFps");

const btnConnect = document.getElementById("btnConnect");
const btnDisconnect = document.getElementById("btnDisconnect");
const btnStartMedia = document.getElementById("btnStartMedia");
const btnStopAll = document.getElementById("btnStopAll");

const wsStatusEl = document.getElementById("wsStatus");
const pcStatusEl = document.getElementById("pcStatus");
const mediaStatusEl = document.getElementById("mediaStatus");

const selStatusEl = document.getElementById("selStatus");
const fpsEl = document.getElementById("FPS");
const netRttEl = document.getElementById("netRtt");
const netJitterEl = document.getElementById("netJitter");
const capResEl = document.getElementById("capRes");

const rawLog = document.getElementById("rawLog");
const controlsLog = document.getElementById("controlsLog");
const sigLog = document.getElementById("sigLog");
const preview = document.getElementById("preview");

function setStatus(el, text, state) {
  const dot = el.querySelector(".status-dot");
  dot.className = "status-dot " + (state==="ok" ? "status-ok" : state==="bad" ? "status-bad" : "status-idle");
  el.childNodes[1].nodeValue = " " + text;
}

function log(el, msg) {
  const t = new Date().toLocaleTimeString();
  el.textContent += `[${t}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function guessWsUrl() {
  const { protocol, host } = window.location;
  if (protocol === "https:") return `wss://${host}`;
  if (protocol === "http:") return `ws://${host}`;
  return "ws://localhost:3000";
}
wsUrlEl.value = guessWsUrl();

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
function normalizeYaw(y){
  while (y < -180) y += 360;
  while (y > 180) y -= 360;
  return y;
}

// Parse "1280x720" etc.
function parseRes(value) {
  if (!value || value === "auto") return null;
  const m = value.match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!m) return null;
  return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
}

function getCurrentWebcamTarget() {
  const fps = parseInt(webcamFpsEl.value, 10) || 60;
  const res = parseRes(webcamResEl.value);
  return { fps, res };
}

function updateCaptureLabel() {
  try {
    if (!localStream) { capResEl.textContent = "Capture: --"; return; }
    const track = localStream.getVideoTracks()?.[0];
    if (!track) { capResEl.textContent = "Capture: --"; return; }
    const s = track.getSettings ? track.getSettings() : {};
    const w = s.width ?? "--";
    const h = s.height ?? "--";
    const fps = s.frameRate ?? "--";
    capResEl.textContent = `Capture: ${w}×${h}@${fps}`;
  } catch {
    capResEl.textContent = "Capture: --";
  }
}

function fmtMs(v) {
  if (v == null || Number.isNaN(v)) return "--";
  return (v * 1000).toFixed(1) + "ms";
}

// Poll sender-side stats (FPS + RTT + remote jitter)
async function measureAndDisplayStats() {
  if (!localStream || !pc) {
    fpsEl.textContent = "FPS: --";
    netRttEl.textContent = "RTT: --";
    netJitterEl.textContent = "Jitter: --";
    updateCaptureLabel();
    return;
  }

  const track = localStream.getVideoTracks()[0];
  if (!track) {
    fpsEl.textContent = "FPS: --";
    netRttEl.textContent = "RTT: --";
    netJitterEl.textContent = "Jitter: --";
    updateCaptureLabel();
    return;
  }

  try {
    const stats = await pc.getStats(track);

    let frameRate = null;
    let jitterSec = null;
    let rttSec = null;

    // If available, use nominated+succeeded pair RTT (best view of network path)
    let pairRtt = null;

    stats.forEach(report => {
      if (report.type === "outbound-rtp" && (report.kind === "video" || report.mediaType === "video")) {
        if (typeof report.framesPerSecond === "number") frameRate = report.framesPerSecond;
      }

      // Sender can see receiver feedback via remote-inbound-rtp
      if (report.type === "remote-inbound-rtp" && (report.kind === "video" || report.mediaType === "video")) {
        if (typeof report.jitter === "number") jitterSec = report.jitter; // seconds
        if (typeof report.roundTripTime === "number") rttSec = report.roundTripTime; // seconds
      }

      if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
        if (typeof report.currentRoundTripTime === "number") pairRtt = report.currentRoundTripTime; // seconds
      }
    });

    if (frameRate != null) fpsEl.textContent = `FPS: ${frameRate.toFixed(1)}`;
    else fpsEl.textContent = `FPS: --`;

    const rttUse = (pairRtt != null) ? pairRtt : rttSec;
    netRttEl.textContent = `RTT: ${rttUse != null ? fmtMs(rttUse) : "--"}`;
    netJitterEl.textContent = `Jitter: ${jitterSec != null ? fmtMs(jitterSec) : "--"}`;

    updateCaptureLabel();
  } catch (e) {
    fpsEl.textContent = "FPS: error";
    netRttEl.textContent = "RTT: error";
    netJitterEl.textContent = "Jitter: error";
    updateCaptureLabel();
  }
}
setInterval(measureAndDisplayStats, 500);

// ---------- State ----------
let ws = null;
let pc = null;

let mediaOpId = 0;
let pendingOffer = null;

// sources
let webcamStream = null;
let video360El = null;

// outgoing
let localStream = null;
let videoSender = null;

// crop machinery
let cropCanvas = null;
let cropCtx = null;
let cropTimer = null;

// viewport request from Unity (yaw/pitch)
const viewport = { yawDeg: 0, pitchDeg: 0, onChange: null };

// stats / latest control state
let countViewport = 0;
let countJoy = 0;
let countBtn = 0;
let lastControlAt = 0;

const latest = {
  viewport: { yawDeg: 0, pitchDeg: 0, hfovDeg: 120, vfovDeg: 120 },
  joy: { lx:0, ly:0, rx:0, ry:0, lt:0, rt:0 },
  btn: {} // id -> v
};

// --- Low latency WebRTC tuning ---
function preferCodecInSdp(sdp, preferred) {
  // preferred: "H264" or "VP8"
  const lines = sdp.split("\n");
  const mLineIdx = lines.findIndex(l => l.startsWith("m=video"));
  if (mLineIdx < 0) return sdp;

  const rtpmap = lines
    .filter(l => l.startsWith("a=rtpmap:"))
    .map(l => {
      const m = l.match(/^a=rtpmap:(\d+)\s+([^/]+)/);
      return m ? { pt: m[1], codec: m[2].toUpperCase() } : null;
    })
    .filter(Boolean);

  const preferredPts = rtpmap.filter(x => x.codec === preferred.toUpperCase()).map(x => x.pt);
  if (!preferredPts.length) return sdp;

  const parts = lines[mLineIdx].trim().split(" ");
  const header = parts.slice(0, 3);
  const pts = parts.slice(3);

  const newPts = [
    ...preferredPts.filter(pt => pts.includes(pt)),
    ...pts.filter(pt => !preferredPts.includes(pt))
  ];

  lines[mLineIdx] = [...header, ...newPts].join(" ");
  return lines.join("\n");
}

async function tuneSenderForLowLatency(pc, maxKbps = 6000, maxFps = 60) {
  const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
  if (!sender) return;

  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];

  p.encodings[0].maxBitrate = maxKbps * 1000;
  p.encodings[0].maxFramerate = maxFps;

  if (p.encodings[0].scaleResolutionDownBy == null) {
    p.encodings[0].scaleResolutionDownBy = 1.0;
  }

  p.degradationPreference = "maintain-framerate";

  try { await sender.setParameters(p); } catch (e) {}

  try { sender.generateKeyFrame?.(); } catch {}
}

function sendWs(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const s = JSON.stringify(obj);
  ws.send(s);
  log(rawLog, "WS -> " + s);
}

// ---------- WebRTC ----------
function ensurePc() {
  if (pc) return;

  pc = new RTCPeerConnection({
    iceServers: [{ urls: [stunEl.value || "stun:stun.l.google.com:19302"] }],
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 4
  });

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    sendWs({
      type: "candidate",
      candidate: ev.candidate.candidate,
      sdpMid: ev.candidate.sdpMid,
      sdpMLineIndex: ev.candidate.sdpMLineIndex
    });
    log(sigLog, "ICE -> candidate");
  };

  pc.onconnectionstatechange = () => {
    log(sigLog, "PC state = " + pc.connectionState);
    setStatus(pcStatusEl, "WebRTC: " + pc.connectionState, pc.connectionState === "connected" ? "ok" : "idle");
  };

  setStatus(pcStatusEl, "WebRTC: created", "ok");
}

async function handleOffer(msg) {
  ensurePc();

  if (!localStream) {
    log(sigLog, "Offer received before media. Queued until Start/Apply Mode.");
    pendingOffer = msg;
    return;
  }

  await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });

  const answer = await pc.createAnswer();

  // Prefer VP8 for now (you observed better behavior). Switch back later if needed.
  let sdp = answer.sdp;
  sdp = preferCodecInSdp(sdp, "VP8");
  answer.sdp = sdp;

  await pc.setLocalDescription(answer);

  await tuneSenderForLowLatency(pc, 6000, 60);

  sendWs({ type: "answer", sdp: pc.localDescription.sdp });
  log(sigLog, "Answer sent");
}

async function handleCandidate(msg) {
  if (!pc) return;
  try {
    await pc.addIceCandidate({
      candidate: msg.candidate,
      sdpMid: msg.sdpMid,
      sdpMLineIndex: msg.sdpMLineIndex
    });
    log(sigLog, "ICE <- candidate added");
  } catch (e) {
    log(sigLog, "addIceCandidate error: " + e.message);
  }
}

// ---------- Crop ----------
function stopCropLoop() {
  if (cropTimer) { clearInterval(cropTimer); cropTimer = null; }
  viewport.onChange = null;

  if (cropCanvas) {
    try { cropCanvas.remove(); } catch {}
  }
  cropCanvas = null;
  cropCtx = null;
}

function drawWrapped(video, ctx,
  srcW, srcH,
  sx, sy, sw, sh,
  dstW, dstH,
  dx, dy, dw, dh)
{
  const sxNorm = ((sx % srcW) + srcW) % srcW;
  const dxNorm = ((dx % dstW) + dstW) % dstW;

  const srcWraps = (sxNorm + sw > srcW);
  const dstWraps = (dxNorm + dw > dstW);

  if (!srcWraps && !dstWraps) {
    ctx.drawImage(video, sxNorm, sy, sw, sh, dxNorm, dy, dw, dh);
    return;
  }

  const srcLeftW = Math.min(sw, srcW - sxNorm);
  const srcRightW = sw - srcLeftW;

  const ratio = srcLeftW / sw;
  const dstLeftW = dw * ratio;
  const dstRightW = dw - dstLeftW;

  ctx.drawImage(video, sxNorm, sy, srcLeftW, sh, dxNorm, dy, dstLeftW, dh);

  if (srcRightW > 0.001) {
    ctx.drawImage(video, 0, sy, srcRightW, sh, 0, dy, dstRightW, dh);
  }
}

function startBlackEquirectWithViewport(videoEl, outW = 2048, outH = 1024) {
  stopCropLoop();

  cropCanvas = document.createElement("canvas");
  cropCanvas.width = outW;
  cropCanvas.height = outH;
  cropCanvas.style.position = "fixed";
  cropCanvas.style.left = "-10000px";
  cropCanvas.style.top = "-10000px";
  cropCanvas.style.width = "1px";
  cropCanvas.style.height = "1px";
  cropCanvas.style.opacity = "0";
  document.body.appendChild(cropCanvas);

  cropCtx = cropCanvas.getContext("2d", { alpha: false });

  const tmpStream = cropCanvas.captureStream(0);
  const track = tmpStream.getVideoTracks()[0];
  localStream = new MediaStream([track]);

  let dirty = true;

  function drawFrame() {
    if (!videoEl.videoWidth || !videoEl.videoHeight) return;

    const yaw = normalizeYaw(viewport.yawDeg);
    const pitch = clamp(viewport.pitchDeg, -85, 85);

    const hfov = clamp(parseFloat(hfovEl.value || "120"), 20, 180);
    const vfov = clamp(parseFloat(vfovEl.value || "120"), 20, 160);

    const srcW = videoEl.videoWidth;
    const srcH = videoEl.videoHeight;

    cropCtx.fillStyle = "black";
    cropCtx.fillRect(0, 0, outW, outH);

    const srcCx = (yaw + 180) / 360 * srcW;
    const srcCy = (90 - pitch) / 180 * srcH;

    const srcCropW = (hfov / 360) * srcW;
    const srcCropH = (vfov / 180) * srcH;

    let sx = srcCx - srcCropW / 2;
    let sy = srcCy - srcCropH / 2;
    sy = clamp(sy, 0, srcH - srcCropH);

    const dstCx = (yaw + 180) / 360 * outW;
    const dstCy = (90 - pitch) / 180 * outH;

    const dstCropW = (hfov / 360) * outW;
    const dstCropH = (vfov / 180) * outH;

    let dx = dstCx - dstCropW / 2;
    let dy = dstCy - dstCropH / 2;
    dy = clamp(dy, 0, outH - dstCropH);

    drawWrapped(
      videoEl, cropCtx,
      srcW, srcH,
      sx, sy, srcCropW, srcCropH,
      outW, outH,
      dx, dy, dstCropW, dstCropH
    );

    if (typeof track.requestFrame === "function") {
      track.requestFrame();
    }
  }

  function loop() {
    if (dirty) {
      dirty = false;
      drawFrame();
    }
    requestAnimationFrame(loop);
  }

  viewport.onChange = () => { dirty = true; };
  cropTimer = setInterval(() => { dirty = true; }, 250);

  requestAnimationFrame(loop);

  return localStream;
}

// ---------- Media control ----------
async function stopMediaOnly(myOp=null) {
  stopCropLoop();

  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
    webcamStream = null;
  }

  if (video360El) {
    if (myOp === null || myOp === mediaOpId) {
      try { video360El.pause(); } catch {}
    }
    video360El = null;
  }

  localStream = null;
  preview.srcObject = null;

  capResEl.textContent = "Capture: --";
  setStatus(mediaStatusEl, "Media: off", "idle");
}

function sendUnityRenderMode() {
  const m = modeEl.value;
  let renderMode = "flat2d";
  if (m === "full360") renderMode = "full360";
  if (m === "crop360") renderMode = "crop360";
  if (m === "webcam2d") renderMode = "flat2d";

  sendWs({ type:"streamMode", mode: renderMode });
  log(sigLog, "Sent streamMode=" + renderMode);
}

async function applyModeAndStartMedia() {
  const myOp = ++mediaOpId;

  btnStartMedia.disabled = true;
  modeEl.disabled = true;

  try {
    await stopMediaOnly(myOp);
    if (myOp !== mediaOpId) return;

    ensurePc();
    const m = modeEl.value;

    if (m === "webcam2d") {
      const { fps, res } = getCurrentWebcamTarget();

      const videoConstraints = {
        frameRate: { ideal: fps, min: Math.min(30, fps) },
      };

      if (res) {
        videoConstraints.width = { ideal: res.w };
        videoConstraints.height = { ideal: res.h };
      } else {
        videoConstraints.width = { ideal: 1280 };
        videoConstraints.height = { ideal: 720 };
      }

      webcamStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false
      });
      if (myOp !== mediaOpId) return;

      localStream = webcamStream;
      preview.srcObject = localStream;

      updateCaptureLabel();

      sendUnityRenderMode();
      setStatus(mediaStatusEl, `Media: webcam (2D)`, "ok");
    }
    else {
      video360El = document.createElement("video");
      const videoFile = video360Sel.value === "360_2" ? "/360_2.mp4" : "/360.mp4";
      video360El.src = videoFile;
      video360El.loop = true;
      video360El.muted = true;
      video360El.playsInline = true;

      await new Promise((resolve, reject) => {
        const onLoaded = () => { cleanup(); resolve(); };
        const onErr = () => { cleanup(); reject(new Error(`Failed to load ${videoFile}`)); };
        const cleanup = () => {
          video360El.removeEventListener("loadedmetadata", onLoaded);
          video360El.removeEventListener("error", onErr);
        };
        video360El.addEventListener("loadedmetadata", onLoaded);
        video360El.addEventListener("error", onErr);
      });

      if (myOp !== mediaOpId) return;

      await video360El.play();
      if (myOp !== mediaOpId) return;

      if (m === "full360") {
        localStream = video360El.captureStream(30);
        preview.srcObject = localStream;

        sendUnityRenderMode();
        setStatus(mediaStatusEl, "Media: 360 (skybox)", "ok");
      } else {
        const canvasW = 2048;
        const canvasH = 1024;
        localStream = startBlackEquirectWithViewport(video360El, canvasW, canvasH);
        preview.srcObject = localStream;

        sendUnityRenderMode();
        setStatus(mediaStatusEl, "Media: crop360 (black equirect)", "ok");
      }

      updateCaptureLabel();
    }

    const track = localStream.getVideoTracks()[0];
    if (!track) throw new Error("No video track to send");

    if (!videoSender) {
      videoSender = pc.addTrack(track, localStream);
      log(sigLog, "addTrack(video)");
    } else {
      await videoSender.replaceTrack(track);
      log(sigLog, "replaceTrack(video)");
    }

    // after addTrack/replaceTrack
    await tuneSenderForLowLatency(pc, 6000, 60);

    // Keep your existing crop360 scaling safety
    const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
    if (sender) {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];

      if (modeEl.value === "crop360") {
        p.encodings[0].scaleResolutionDownBy = 2.0;
        p.encodings[0].maxBitrate = 4500 * 1000;
        p.encodings[0].maxFramerate = 60;
      } else {
        p.encodings[0].scaleResolutionDownBy = 1.0;
        p.encodings[0].maxBitrate = 6000 * 1000;
        p.encodings[0].maxFramerate = 60;
      }
      p.degradationPreference = "maintain-framerate";
      try { await sender.setParameters(p); } catch {}
    }

    if (pendingOffer) {
      const offer = pendingOffer;
      pendingOffer = null;
      await handleOffer(offer);
    }
  } catch (e) {
    if (myOp === mediaOpId) {
      setStatus(mediaStatusEl, "Media: error", "bad");
      log(sigLog, "Media error: " + e.message);
    }
  } finally {
    if (myOp === mediaOpId) {
      btnStartMedia.disabled = false;
      modeEl.disabled = false;
    }
  }
}

// Try to apply webcam resolution live without restarting media
async function applyWebcamResolutionLive() {
  if (!webcamStream || modeEl.value !== "webcam2d") return;

  const track = webcamStream.getVideoTracks()?.[0];
  if (!track || !track.applyConstraints) return;

  const { fps, res } = getCurrentWebcamTarget();

  const c = {
    frameRate: { ideal: fps },
  };

  if (res) {
    c.width = { ideal: res.w };
    c.height = { ideal: res.h };
  }

  try {
    await track.applyConstraints(c);
    log(sigLog, `Applied webcam constraints live: ${res ? `${res.w}x${res.h}` : "auto"} @${fps}`);
    updateCaptureLabel();

    // Nudge encoder to emit a fresh keyframe after changing constraints
    const sender = pc?.getSenders?.().find(s => s.track && s.track.kind === "video");
    try { sender?.generateKeyFrame?.(); } catch {}
  } catch (e) {
    log(sigLog, `applyConstraints failed (${e.message}). Press Start/Apply Mode to restart with new res.`);
  }
}

// ---------- Cleanup ----------
function cleanupAll() {
  pendingOffer = null;

  stopMediaOnly(null);
  setStatus(mediaStatusEl, "Media: off", "idle");

  if (pc) { try { pc.close(); } catch {} pc = null; }
  videoSender = null;
  setStatus(pcStatusEl, "WebRTC: idle", "idle");

  if (ws) { try { ws.close(); } catch {} ws = null; }
  setStatus(wsStatusEl, "WS: disconnected", "idle");

  selStatusEl.textContent = "";
  fpsEl.textContent = "";
  netRttEl.textContent = "RTT: --";
  netJitterEl.textContent = "Jitter: --";
  capResEl.textContent = "Capture: --";

  btnStartMedia.disabled = true;
  btnDisconnect.disabled = true;
  btnStopAll.disabled = true;
  btnConnect.disabled = false;

  log(sigLog, "Stopped all");
}

// ---------- WS connect ----------
btnConnect.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket(wsUrlEl.value.trim());
  ws.onopen = () => {
    setStatus(wsStatusEl, "WS: connected", "ok");
    btnConnect.disabled = true;
    btnDisconnect.disabled = false;
    btnStartMedia.disabled = false;
    btnStopAll.disabled = false;

    sendWs({ type:"hello", role:"robot", robotId: robotIdEl.value.trim(), meta:{ name:"Browser Robot Sim" } });
    selStatusEl.textContent = `robotId: ${robotIdEl.value.trim()} | vp:0 | joy:0 | btn:0 | last: ∞`;

    log(sigLog, "Connected. Start media, then select this robot in Unity.");
  };

  ws.onmessage = async (ev) => {
    log(rawLog, "WS <- " + ev.data);
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "viewport") {
      countViewport++; lastControlAt = Date.now();

      if (typeof msg.yawDeg === "number") viewport.yawDeg = msg.yawDeg;
      if (typeof msg.pitchDeg === "number") viewport.pitchDeg = msg.pitchDeg;

      if (typeof msg.hfovDeg === "number") hfovEl.value = msg.hfovDeg;
      if (typeof msg.vfovDeg === "number") vfovEl.value = msg.vfovDeg;

      latest.viewport.yawDeg = viewport.yawDeg;
      latest.viewport.pitchDeg = viewport.pitchDeg;
      latest.viewport.hfovDeg = Number(hfovEl.value || 120);
      latest.viewport.vfovDeg = Number(vfovEl.value || 120);

      if (viewport.onChange) viewport.onChange();

      log(controlsLog,
        `VIEWPORT yaw=${latest.viewport.yawDeg.toFixed(1)} pitch=${latest.viewport.pitchDeg.toFixed(1)} ` +
        `hfov=${latest.viewport.hfovDeg.toFixed(0)} vfov=${latest.viewport.vfovDeg.toFixed(0)}`
      );
      return;
    }

    if (msg.type === "joy") {
      countJoy++; lastControlAt = Date.now();

      latest.joy.lx = msg.lx ?? latest.joy.lx;
      latest.joy.ly = msg.ly ?? latest.joy.ly;
      latest.joy.rx = msg.rx ?? latest.joy.rx;
      latest.joy.ry = msg.ry ?? latest.joy.ry;
      latest.joy.lt = msg.lt ?? latest.joy.lt;
      latest.joy.rt = msg.rt ?? latest.joy.rt;

      log(controlsLog,
        `JOY L=(${latest.joy.lx.toFixed(3)}, ${latest.joy.ly.toFixed(3)}) ` +
        `R=(${latest.joy.rx.toFixed(3)}, ${latest.joy.ry.toFixed(3)}) ` +
        `T=(lt:${latest.joy.lt.toFixed(3)} rt:${latest.joy.rt.toFixed(3)})`
      );
      return;
    }

    if (msg.type === "btn") {
      countBtn++; lastControlAt = Date.now();
      latest.btn[msg.id] = msg.v;
      log(controlsLog, `BTN ${msg.id}=${msg.v}`);
      return;
    }

    if (msg.type === "offer") { log(sigLog, "Offer received"); await handleOffer(msg); return; }
    if (msg.type === "candidate") { await handleCandidate(msg); return; }

    if (msg.type === "hello_ok") { log(sigLog, "hello_ok"); return; }
    if (msg.type === "viewer_attached") { log(sigLog, "viewer_attached"); return; }
    if (msg.type === "viewer_detached") { log(sigLog, "viewer_detached"); return; }
  };

  ws.onerror = () => setStatus(wsStatusEl, "WS: error", "bad");
  ws.onclose = () => setStatus(wsStatusEl, "WS: disconnected", "idle");
};

btnDisconnect.onclick = () => {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  setStatus(wsStatusEl, "WS: disconnected", "idle");
  btnConnect.disabled = false;
  btnDisconnect.disabled = true;
};

btnStartMedia.onclick = async () => { await applyModeAndStartMedia(); };
btnStopAll.onclick = cleanupAll;

// Live apply when changing webcam resolution/fps (if webcam mode is running)
webcamResEl.addEventListener("change", () => applyWebcamResolutionLive());
webcamFpsEl.addEventListener("change", () => applyWebcamResolutionLive());

setInterval(() => {
  const ageMs = lastControlAt ? (Date.now() - lastControlAt) : null;
  const ageTxt = ageMs == null ? "∞" : (ageMs/1000).toFixed(2) + "s";
  selStatusEl.textContent =
    `robotId: ${robotIdEl.value.trim()} | vp:${countViewport} | joy:${countJoy} | btn:${countBtn} | last: ${ageTxt}`;
}, 250);

window.addEventListener("beforeunload", () => cleanupAll());
