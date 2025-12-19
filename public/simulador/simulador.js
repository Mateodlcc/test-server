// ======================
// Unity Simulator (Headset) - WS + WebRTC
// - Two joysticks:
//   * joyViewport -> sends type:"viewport" (head crop alignment)
//   * joyMove     -> sends type:"joy" (locomotion lx/ly) continuously while dragging
// - Controller button testing:
//   * pretty toggles that send btn press/release
//   * triggers sliders feed lt/rt into joy messages
// ======================

// Elements
const wsUrlEl = document.getElementById("wsUrl");
const btnConnect = document.getElementById("btnConnect");
const btnDisconnect = document.getElementById("btnDisconnect");
const robotList = document.getElementById("robotList");
const btnSelect = document.getElementById("btnSelect");
const btnStart = document.getElementById("btnStart");
const btnSendControl = document.getElementById("btnSendControl");
const btnSendViewport = document.getElementById("btnSendViewport");
const btnClearLog = document.getElementById("btnClearLog");
const btnCenterViewport = document.getElementById("btnCenterViewport");
const btnCenterMove = document.getElementById("btnCenterMove");

const vid = document.getElementById("vid");
const logEl = document.getElementById("log");

const wsStateEl = document.getElementById("wsState");
const pcStateEl = document.getElementById("pcState");

// Viewport UI
const joyViewport = document.getElementById("joyViewport");
const ctxVp = joyViewport.getContext("2d");
const vpStateEl = document.getElementById("vpState");
const yawRangeEl = document.getElementById("yawRange");
const pitchRangeEl = document.getElementById("pitchRange");
const hfovEl = document.getElementById("hfov");
const vfovEl = document.getElementById("vfov");

// Movement UI
const joyMove = document.getElementById("joyMove");
const ctxMv = joyMove.getContext("2d");
const moveStateEl = document.getElementById("moveState");
const ltSlider = document.getElementById("ltSlider");
const rtSlider = document.getElementById("rtSlider");
const ltVal = document.getElementById("ltVal");
const rtVal = document.getElementById("rtVal");
const btnPads = Array.from(document.querySelectorAll(".btnpad"));

// Helpers
function log(s){
  const line = `[${new Date().toLocaleTimeString()}] ${s}`;
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}
function setWsState(s){ wsStateEl.textContent = `WS: ${s}`; }
function setPcState(s){ pcStateEl.textContent = `PC: ${s}`; }

function guessWsUrl(){
  const {protocol, host} = window.location;
  if (protocol === "https:") return `wss://${host}`;
  if (protocol === "http:") return `ws://${host}`;
  return "ws://localhost:3000";
}
wsUrlEl.value = guessWsUrl();

// State
let ws = null;
let pc = null;
let selectedRobotId = null;
let clientId = "sim-headset";

// Latest movement + triggers state
const joyState = {
  lx: 0, ly: 0,
  rx: 0, ry: 0,
  lt: 0, rt: 0,
};

const btnState = new Map(); // id -> 0/1

// --- WS send ---
function send(obj){
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
  log(`WS -> ${JSON.stringify(obj)}`);
}

// --- WebRTC lifecycle ---
function resetWebRTC(reason = ""){
  try { if (pc) pc.ontrack = null; } catch {}
  try { if (pc) pc.onicecandidate = null; } catch {}
  try { if (pc) pc.onconnectionstatechange = null; } catch {}
  try { if (pc) pc.close(); } catch {}
  pc = null;

  try { vid.pause(); } catch {}
  vid.srcObject = null;

  setPcState("idle");
  log(`WebRTC reset${reason ? " (" + reason + ")" : ""}`);
}

function ensurePcFresh(){
  if (pc) return;

  pc = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
  });

  pc.onicecandidate = (ev)=>{
    if (!ev.candidate) return;
    send({
      type: "candidate",
      candidate: ev.candidate.candidate,
      sdpMid: ev.candidate.sdpMid,
      sdpMLineIndex: ev.candidate.sdpMLineIndex
    });
  };

  pc.ontrack = (ev)=>{
    log("ontrack: stream recibido");
    vid.srcObject = ev.streams[0];
    try { vid.play(); } catch {}
  };

  pc.onconnectionstatechange = ()=>{
    const st = pc.connectionState || "unknown";
    setPcState(st);
    log(`PC state: ${st}`);
  };

  setPcState("new");
  log("PeerConnection creado");
}

// --- WS connection ---
btnConnect.onclick = ()=>{
  const url = wsUrlEl.value.trim();
  if (!url) return;

  ws = new WebSocket(url);

  ws.onopen = ()=>{
    setWsState("connected");
    log(`WS conectado: ${url}`);
    send({ type:"hello", role:"headset", clientId });
  };

  ws.onclose = ()=>{
    setWsState("disconnected");
    log("WS cerrado");
  };

  ws.onerror = ()=>{
    setWsState("error");
    log("WS error");
  };

  ws.onmessage = async (ev)=>{
    log(`WS <- ${ev.data}`);
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    const t = msg.type;

    if (t === "robots"){
      robotList.innerHTML = "";
      for (const r of msg.robots || []){
        const opt = document.createElement("option");
        opt.value = r.robotId;
        opt.textContent = `${r.robotId} (${r.streamMode || "?"})`;
        robotList.appendChild(opt);
      }
      if ((msg.robots || []).length === 0){
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No robots connected";
        robotList.appendChild(opt);
      }
    }

    if (t === "selected_robot"){
      selectedRobotId = msg.robotId;
      log(`selectedRobotId=${selectedRobotId}`);
      resetWebRTC("robot switched");
    }

    if (t === "streamMode"){
      log(`streamMode=${msg.mode}`);
    }

    if (t === "answer"){
      ensurePcFresh();
      try{
        await pc.setRemoteDescription({ type:"answer", sdp: msg.sdp });
        log("Remote answer seteada");
      }catch(e){
        log("setRemoteDescription(answer) err: " + e.message);
      }
    }

    if (t === "candidate"){
      ensurePcFresh();
      try{
        await pc.addIceCandidate({
          candidate: msg.candidate,
          sdpMid: msg.sdpMid,
          sdpMLineIndex: msg.sdpMLineIndex
        });
      }catch(e){
        log("addIceCandidate err: " + e.message);
      }
    }
  };
};

btnDisconnect.onclick = ()=>{
  try { ws.close(); } catch {}
  ws = null;
  setWsState("disconnected");
  resetWebRTC("disconnect");
};

// --- Robot selection ---
btnSelect.onclick = ()=>{
  const rid = robotList.value;
  if (!rid){
    log("No robot selected");
    return;
  }
  send({ type:"select_robot", robotId: rid });
};

// --- Start WebRTC ---
btnStart.onclick = async ()=>{
  if (!selectedRobotId){
    log("Selecciona robot primero");
    return;
  }

  resetWebRTC("start pressed");
  ensurePcFresh();

  try{
    pc.addTransceiver("video", { direction:"recvonly" });
  }catch(e){
    log("addTransceiver err: " + e.message);
  }

  try{
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type:"offer", sdp: pc.localDescription.sdp });
    log("Offer enviada");
  }catch(e){
    log("createOffer/setLocalDescription err: " + e.message);
  }
};

// --- Test messages ---
btnSendControl.onclick = ()=>{
  if (!selectedRobotId){
    log("Selecciona robot primero");
    return;
  }

  // viewport (head crop alignment)
  send({
    type:"viewport",
    robotId: selectedRobotId,
    yawDeg: 20,
    pitchDeg: -8,
    hfovDeg: Number(hfovEl.value || 120),
    vfovDeg: Number(vfovEl.value || 120),
  });

  // joy (both sticks + triggers)
  send({
    type:"joy",
    robotId: selectedRobotId,
    lx: 0.20, ly: -0.10,
    rx: -0.30, ry: 0.05,
    lt: joyState.lt, rt: joyState.rt,
    ts: performance.now() / 1000
  });

  // button edge example
  send({ type:"btn", robotId:selectedRobotId, id:"A", v:1, ts: performance.now()/1000 });
  setTimeout(()=> send({ type:"btn", robotId:selectedRobotId, id:"A", v:0, ts: performance.now()/1000 }), 150);
};

btnSendViewport.onclick = ()=>{
  if (!selectedRobotId) return;
  send({
    type:"viewport",
    robotId: selectedRobotId,
    yawDeg: 30,
    pitchDeg: -10,
    hfovDeg: Number(hfovEl.value || 120),
    vfovDeg: Number(vfovEl.value || 120),
  });
};

btnClearLog.onclick = ()=>{
  logEl.textContent = "";
  log("logs cleared");
};

// ======================
// Shared helpers
// ======================
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function setMoveStateText(){
  moveStateEl.textContent =
`lx: ${joyState.lx.toFixed(3)}
ly: ${joyState.ly.toFixed(3)}
rx: ${joyState.rx.toFixed(3)}
ry: ${joyState.ry.toFixed(3)}
lt: ${joyState.lt.toFixed(3)}
rt: ${joyState.rt.toFixed(3)}`;
}

// ======================
// VIEWPORT JOYSTICK (head crop alignment)
// ======================
let draggingVp = false;
let knobVp = { x: 0, y: 0 }; // normalized [-1,1]
let lastVpSent = 0;

function drawJoy(ctx, canvas, knob){
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);

  const cx = w/2, cy = h/2;
  const R = Math.min(w,h)*0.42;

  // base circle
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI*2);
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 3;
  ctx.stroke();

  // crosshair
  ctx.beginPath();
  ctx.moveTo(cx-R, cy); ctx.lineTo(cx+R, cy);
  ctx.moveTo(cx, cy-R); ctx.lineTo(cx, cy+R);
  ctx.strokeStyle = "#1f2937";
  ctx.lineWidth = 2;
  ctx.stroke();

  // knob
  const kx = cx + knob.x * R;
  const ky = cy + knob.y * R;

  ctx.beginPath();
  ctx.arc(kx, ky, R*0.22, 0, Math.PI*2);
  ctx.fillStyle = "#4f46e5";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(kx, ky, R*0.22, 0, Math.PI*2);
  ctx.strokeStyle = "#c7d2fe";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function viewportFromKnob(){
  const yawRange = Number(yawRangeEl.value || 90);
  const pitchRange = Number(pitchRangeEl.value || 45);

  const yawDeg = knobVp.x * yawRange;
  const pitchDeg = -knobVp.y * pitchRange;

  const hfovDeg = Number(hfovEl.value || 120);
  const vfovDeg = Number(vfovEl.value || 120);

  return { yawDeg, pitchDeg, hfovDeg, vfovDeg };
}

function sendViewportThrottled(){
  const now = performance.now();
  if (now - lastVpSent < 33) return; // ~30Hz
  lastVpSent = now;

  if (!selectedRobotId) return;

  const vp = viewportFromKnob();
  vpStateEl.textContent =
`yawDeg: ${vp.yawDeg.toFixed(1)}
pitchDeg: ${vp.pitchDeg.toFixed(1)}
hfovDeg: ${vp.hfovDeg.toFixed(0)}
vfovDeg: ${vp.vfovDeg.toFixed(0)}`;

  send({ type:"viewport", robotId: selectedRobotId, ...vp });
}

function updateKnobFromClient(canvas, knob, clientX, clientY){
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;

  const cx = rect.width/2, cy = rect.height/2;
  const R = Math.min(rect.width, rect.height)*0.42;

  let nx = (x - cx) / R;
  let ny = (y - cy) / R;

  const mag = Math.hypot(nx, ny);
  if (mag > 1) { nx /= mag; ny /= mag; }

  knob.x = nx;
  knob.y = ny;
}

function onDownVp(e){
  draggingVp = true;
  const p = (e.touches && e.touches[0]) ? e.touches[0] : e;
  updateKnobFromClient(joyViewport, knobVp, p.clientX, p.clientY);
  drawJoy(ctxVp, joyViewport, knobVp);
  sendViewportThrottled();
}
function onMoveVp(e){
  if (!draggingVp) return;
  const p = (e.touches && e.touches[0]) ? e.touches[0] : e;
  updateKnobFromClient(joyViewport, knobVp, p.clientX, p.clientY);
  drawJoy(ctxVp, joyViewport, knobVp);
  sendViewportThrottled();
}
function onUpVp(){ draggingVp = false; }

joyViewport.addEventListener("mousedown", onDownVp);
window.addEventListener("mousemove", onMoveVp);
window.addEventListener("mouseup", onUpVp);

joyViewport.addEventListener("touchstart", (e)=>{ e.preventDefault(); onDownVp(e); }, {passive:false});
joyViewport.addEventListener("touchmove", (e)=>{ e.preventDefault(); onMoveVp(e); }, {passive:false});
joyViewport.addEventListener("touchend", (e)=>{ e.preventDefault(); onUpVp(); }, {passive:false});
joyViewport.addEventListener("touchcancel", (e)=>{ e.preventDefault(); onUpVp(); }, {passive:false});

btnCenterViewport.addEventListener("click", ()=>{
  knobVp.x = 0; knobVp.y = 0;
  drawJoy(ctxVp, joyViewport, knobVp);
  lastVpSent = 0;
  sendViewportThrottled();
});

// ======================
// MOVEMENT JOYSTICK (locomotion)
// ======================
let draggingMv = false;
let knobMv = { x: 0, y: 0 }; // normalized [-1,1]
let lastJoySent = 0;

function sendJoyThrottled(force=false){
  const now = performance.now();
  const minDt = 1000 / 60; // ~60 Hz
  if (!force && (now - lastJoySent < minDt)) return;
  lastJoySent = now;

  if (!selectedRobotId) return;

  send({
    type:"joy",
    robotId: selectedRobotId,
    lx: joyState.lx,
    ly: joyState.ly,
    rx: joyState.rx,
    ry: joyState.ry,
    lt: joyState.lt,
    rt: joyState.rt,
    ts: now / 1000
  });
}

function onDownMv(e){
  draggingMv = true;
  const p = (e.touches && e.touches[0]) ? e.touches[0] : e;
  updateKnobFromClient(joyMove, knobMv, p.clientX, p.clientY);
  drawJoy(ctxMv, joyMove, knobMv);

  joyState.lx = clamp(knobMv.x, -1, 1);
  joyState.ly = clamp(knobMv.y, -1, 1);

  setMoveStateText();
  sendJoyThrottled(true);
}
function onMoveMv(e){
  if (!draggingMv) return;
  const p = (e.touches && e.touches[0]) ? e.touches[0] : e;
  updateKnobFromClient(joyMove, knobMv, p.clientX, p.clientY);
  drawJoy(ctxMv, joyMove, knobMv);

  joyState.lx = clamp(knobMv.x, -1, 1);
  joyState.ly = clamp(knobMv.y, -1, 1);

  setMoveStateText();
  sendJoyThrottled(false);
}
function onUpMv(){
  if (!draggingMv) return;
  draggingMv = false;

  knobMv.x = 0; knobMv.y = 0;
  drawJoy(ctxMv, joyMove, knobMv);

  joyState.lx = 0;
  joyState.ly = 0;

  setMoveStateText();
  sendJoyThrottled(true);
}

joyMove.addEventListener("mousedown", onDownMv);
window.addEventListener("mousemove", onMoveMv);
window.addEventListener("mouseup", onUpMv);

joyMove.addEventListener("touchstart", (e)=>{ e.preventDefault(); onDownMv(e); }, {passive:false});
joyMove.addEventListener("touchmove", (e)=>{ e.preventDefault(); onMoveMv(e); }, {passive:false});
joyMove.addEventListener("touchend", (e)=>{ e.preventDefault(); onUpMv(); }, {passive:false});
joyMove.addEventListener("touchcancel", (e)=>{ e.preventDefault(); onUpMv(); }, {passive:false});

btnCenterMove.addEventListener("click", ()=>{
  knobMv.x = 0; knobMv.y = 0;
  drawJoy(ctxMv, joyMove, knobMv);

  joyState.lx = 0;
  joyState.ly = 0;
  setMoveStateText();

  lastJoySent = 0;
  sendJoyThrottled(true);
});

// ======================
// Trigger sliders (lt/rt)
// ======================
function updateTriggerUI(){
  joyState.lt = clamp(Number(ltSlider.value || 0), 0, 1);
  joyState.rt = clamp(Number(rtSlider.value || 0), 0, 1);
  ltVal.textContent = joyState.lt.toFixed(2);
  rtVal.textContent = joyState.rt.toFixed(2);
  setMoveStateText();

  // If user is adjusting triggers, send joy at a modest rate
  sendJoyThrottled(true);
}

ltSlider.addEventListener("input", updateTriggerUI);
rtSlider.addEventListener("input", updateTriggerUI);

// ======================
// Button testing (press/release)
// - Click toggles state and sends btn event.
// - Also supports press-and-hold with pointer events.
// ======================
function sendBtn(id, v){
  if (!selectedRobotId) return;
  send({
    type:"btn",
    robotId: selectedRobotId,
    id,
    v,
    ts: performance.now() / 1000
  });
}

function setBtnVisual(btnEl, isOn){
  btnEl.classList.toggle("on", isOn);
}

for (const el of btnPads){
  const id = el.getAttribute("data-btn");
  btnState.set(id, 0);
  setBtnVisual(el, false);

  // Click toggle (pleasant and simple)
  el.addEventListener("click", ()=>{
    const next = btnState.get(id) ? 0 : 1;
    btnState.set(id, next);
    setBtnVisual(el, next === 1);
    sendBtn(id, next);
  });

  // Optional: press-and-hold behavior (mouse/touch)
  // If you want it, uncomment this and remove the click handler above.
  /*
  el.addEventListener("pointerdown", (e)=>{
    e.preventDefault();
    btnState.set(id, 1);
    setBtnVisual(el, true);
    sendBtn(id, 1);
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointerup", ()=>{
    btnState.set(id, 0);
    setBtnVisual(el, false);
    sendBtn(id, 0);
  });
  el.addEventListener("pointercancel", ()=>{
    btnState.set(id, 0);
    setBtnVisual(el, false);
    sendBtn(id, 0);
  });
  */
}

// ======================
// Init UI
// ======================
drawJoy(ctxVp, joyViewport, knobVp);
drawJoy(ctxMv, joyMove, knobMv);
setMoveStateText();
setWsState("disconnected");
setPcState("idle");
log("Ready. Connect WS, select robot, Start WebRTC.");
