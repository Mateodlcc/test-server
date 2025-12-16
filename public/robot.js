// ---------- UI ----------
const wsUrlEl = document.getElementById("wsUrl");
const robotIdEl = document.getElementById("robotId");
const stunEl = document.getElementById("stunUrl");
const modeEl = document.getElementById("mode");
const hfovEl = document.getElementById("hfov");
const vfovEl = document.getElementById("vfov");

const btnConnect = document.getElementById("btnConnect");
const btnDisconnect = document.getElementById("btnDisconnect");
const btnStartMedia = document.getElementById("btnStartMedia");
const btnStopAll = document.getElementById("btnStopAll");

const wsStatusEl = document.getElementById("wsStatus");
const pcStatusEl = document.getElementById("pcStatus");
const mediaStatusEl = document.getElementById("mediaStatus");
const selStatusEl = document.getElementById("selStatus");

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

// stats
let controlCount = 0;
let lastControlAt = 0;

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
    iceServers: [{ urls: [stunEl.value || "stun:stun.l.google.com:19302"] }]
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
  await pc.setLocalDescription(answer);

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

// Full equirect (outW x outH) that is BLACK everywhere, and only the viewport is drawn.
function startBlackEquirectWithViewport(videoEl, outW = 2048, outH = 1024) {
  stopCropLoop();

  // Create + attach hidden canvas (Brave can optimize unattached canvases)
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

  // IMPORTANT: use a CanvasCaptureMediaStreamTrack so we can requestFrame()
  const tmpStream = cropCanvas.captureStream(0); // 0 => manual requestFrame()
  const track = tmpStream.getVideoTracks()[0];

  localStream = new MediaStream([track]);

  let dirty = true;

  function drawFrame() {
    if (!videoEl.videoWidth || !videoEl.videoHeight) return;

    const yaw = normalizeYaw(-viewport.yawDeg);
    const pitch = clamp(viewport.pitchDeg, -85, 85);

    // allow VFOV > 90 safely
    const hfov = clamp(parseFloat(hfovEl.value || "120"), 20, 180);
    const vfov = clamp(parseFloat(vfovEl.value || "120"), 20, 160);

    const srcW = videoEl.videoWidth;
    const srcH = videoEl.videoHeight;

    // SOURCE crop region (equirect)
    const srcCx = (yaw + 180) / 360 * srcW;
    const srcCy = (90 - pitch) / 180 * srcH;

    const srcCropW = (hfov / 360) * srcW;
    const srcCropH = (vfov / 180) * srcH;

    let sx = srcCx - srcCropW / 2;
    let sy = srcCy - srcCropH / 2;
    sy = clamp(sy, 0, srcH - srcCropH);

    // DEST placement in output equirect (same angular mapping)
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

    // 🔥 THIS is the critical Brave fix:
    // force WebRTC to emit a new frame immediately
    if (typeof track.requestFrame === "function") {
      cropCtx.fillStyle = "white";
      cropCtx.fillRect((Date.now() / 10) % outW, 0, 4, 4);

      track.requestFrame();
    }
  }

  function loop() {
    // If video is advancing, we can redraw continuously.
    // But at minimum, if viewport changed, redraw and request a frame.
    if (dirty) {
      dirty = false;
      drawFrame();
    }
    requestAnimationFrame(loop);
  }

  // redraw immediately on viewport updates
  viewport.onChange = () => { dirty = true; };

  // also force periodic redraw even if viewport is stable (optional safety)
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
      webcamStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, frameRate: 30 },
        audio: false
      });
      if (myOp !== mediaOpId) return;

      localStream = webcamStream;
      preview.srcObject = localStream;

      sendUnityRenderMode();
      setStatus(mediaStatusEl, "Media: webcam (2D)", "ok");
    }
    else {
      video360El = document.createElement("video");
      video360El.src = "/360.mp4";
      video360El.loop = true;
      video360El.muted = true;
      video360El.playsInline = true;

      await new Promise((resolve, reject) => {
        const onLoaded = () => { cleanup(); resolve(); };
        const onErr = () => { cleanup(); reject(new Error("Failed to load /360.mp4")); };
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
        // crop360: full equirect output with black fill
        localStream = startBlackEquirectWithViewport(video360El, 2048, 1024, 30);
        preview.srcObject = localStream;

        sendUnityRenderMode();
        setStatus(mediaStatusEl, "Media: crop360 (black equirect)", "ok");
      }
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
    selStatusEl.textContent = `robotId: ${robotIdEl.value.trim()} | controls: 0 | last: ∞`;

    log(sigLog, "Connected. Start media, then select this robot in Unity.");
  };

  ws.onmessage = async (ev) => {
    log(rawLog, "WS <- " + ev.data);
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "control") {
      controlCount++;
      lastControlAt = Date.now();
      log(controlsLog, JSON.stringify(msg));
      return;
    }

    // viewport from Unity for crop360
    if (msg.type === "viewport") {
      if (typeof msg.yawDeg === "number") viewport.yawDeg = msg.yawDeg;
      if (typeof msg.pitchDeg === "number") viewport.pitchDeg = msg.pitchDeg;

      // allow Unity to drive crop FOV
      if (typeof msg.hfovDeg === "number") hfovEl.value = msg.hfovDeg;
      if (typeof msg.vfovDeg === "number") vfovEl.value = msg.vfovDeg;

      if (viewport.onChange) viewport.onChange();
      return;
    }

    if (msg.type === "offer") { log(sigLog, "Offer received"); await handleOffer(msg); return; }
    if (msg.type === "candidate") { await handleCandidate(msg); return; }

    if (msg.type === "hello_ok") { log(sigLog, "hello_ok"); return; }
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

// status freshness
setInterval(() => {
  const ageMs = lastControlAt ? (Date.now() - lastControlAt) : null;
  const ageTxt = ageMs == null ? "∞" : (ageMs/1000).toFixed(2) + "s";
  selStatusEl.textContent = `robotId: ${robotIdEl.value.trim()} | controls: ${controlCount} | last: ${ageTxt}`;
}, 250);

window.addEventListener("beforeunload", () => cleanupAll());
