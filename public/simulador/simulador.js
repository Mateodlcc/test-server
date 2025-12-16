const wsUrlEl = document.getElementById("wsUrl");
const btnConnect = document.getElementById("btnConnect");
const btnDisconnect = document.getElementById("btnDisconnect");
const robotList = document.getElementById("robotList");
const btnSelect = document.getElementById("btnSelect");
const btnStart = document.getElementById("btnStart");
const btnSendControl = document.getElementById("btnSendControl");
const btnSendViewport = document.getElementById("btnSendViewport");
const vid = document.getElementById("vid");
const logEl = document.getElementById("log");

function log(s){ logEl.textContent += s + "\n"; logEl.scrollTop = logEl.scrollHeight; }
function guessWsUrl(){
  const {protocol, host} = window.location;
  if (protocol === "https:") return `wss://${host}`;
  if (protocol === "http:") return `ws://${host}`;
  return "ws://localhost:3000";
}
wsUrlEl.value = guessWsUrl();

let ws=null;
let pc=null;
let selectedRobotId=null;

function send(obj){
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
  log("WS -> " + JSON.stringify(obj));
}

function ensurePc(){
  if (pc) return;
  pc = new RTCPeerConnection({ iceServers:[{urls:["stun:stun.l.google.com:19302"]}] });

  pc.onicecandidate = (ev)=>{
    if(!ev.candidate) return;
    send({
      type:"candidate",
      candidate: ev.candidate.candidate,
      sdpMid: ev.candidate.sdpMid,
      sdpMLineIndex: ev.candidate.sdpMLineIndex
    });
  };

  pc.ontrack = (ev)=>{
    log("ontrack: stream recibido");
    vid.srcObject = ev.streams[0];
  };

  pc.onconnectionstatechange = ()=>{
    log("PC state: " + pc.connectionState);
  };
}

btnConnect.onclick = ()=>{
  ws = new WebSocket(wsUrlEl.value.trim());
  ws.onopen = ()=>{
    log("WS conectado");
    send({type:"hello", role:"headset", clientId:"sim-headset"});
  };
  ws.onclose = ()=>log("WS cerrado");
  ws.onerror = ()=>log("WS error");

  ws.onmessage = async (ev)=>{
    log("WS <- " + ev.data);
    let msg; try{ msg=JSON.parse(ev.data);}catch{return;}

    if(msg.type==="robots"){
      robotList.innerHTML = "";
      for(const r of msg.robots){
        const opt=document.createElement("option");
        opt.value=r.robotId;
        opt.textContent=`${r.robotId} (${r.streamMode})`;
        robotList.appendChild(opt);
      }
    }

    if(msg.type==="selected_robot"){
      selectedRobotId = msg.robotId;
      log("selectedRobotId=" + selectedRobotId);
    }

    if(msg.type==="streamMode"){
      log("streamMode=" + msg.mode);
    }

    if(msg.type==="answer"){
      ensurePc();
      await pc.setRemoteDescription({type:"answer", sdp: msg.sdp});
      log("Remote answer seteada");
    }

    if(msg.type==="candidate"){
      ensurePc();
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
  try{ ws.close(); }catch{}
  ws=null;
};

btnSelect.onclick = ()=>{
  const rid = robotList.value;
  send({type:"select_robot", robotId: rid});
};

btnStart.onclick = async ()=>{
  if(!selectedRobotId){
    log("Selecciona robot primero");
    return;
  }
  ensurePc();

  // Queremos recibir video => añadimos transceiver recvonly
  pc.addTransceiver("video", {direction:"recvonly"});

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  send({type:"offer", sdp: pc.localDescription.sdp});
  log("Offer enviada");
};

btnSendControl.onclick = ()=>{
  // Mensaje de prueba (ajusta al formato que usa tu Unity)
  send({type:"control", seq: Date.now(), robotId: selectedRobotId, lx:0.2, ly:-0.1, rx:0.0, ry:0.0, a:true});
};

btnSendViewport.onclick = ()=>{
  // Para crop360 (si aplica)
  send({type:"viewport", robotId: selectedRobotId, yawDeg: 30, pitchDeg: -10, hfovDeg:120, vfovDeg:120});
};

// ---- Viewport joystick (mouse + touch) ----
const joy = document.getElementById("joy");
const ctx = joy.getContext("2d");
const vpStateEl = document.getElementById("vpState");
const yawRangeEl = document.getElementById("yawRange");
const pitchRangeEl = document.getElementById("pitchRange");
const hfovEl = document.getElementById("hfov");
const vfovEl = document.getElementById("vfov");
const btnCenter = document.getElementById("btnCenter");

let dragging = false;
let knob = { x: 0, y: 0 }; // normalized in [-1,1]
let lastSent = 0;

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function drawJoy() {
  const w = joy.width, h = joy.height;
  ctx.clearRect(0,0,w,h);

  // base circle
  const cx = w/2, cy = h/2;
  const R = Math.min(w,h)*0.42;

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

  // small outline
  ctx.beginPath();
  ctx.arc(kx, ky, R*0.22, 0, Math.PI*2);
  ctx.strokeStyle = "#c7d2fe";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function updateKnobFromClient(clientX, clientY) {
  const rect = joy.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;

  const cx = rect.width/2, cy = rect.height/2;
  const R = Math.min(rect.width, rect.height)*0.42;

  let nx = (x - cx) / R;
  let ny = (y - cy) / R;

  // clamp to circle
  const mag = Math.hypot(nx, ny);
  if (mag > 1) { nx /= mag; ny /= mag; }

  knob.x = nx;
  knob.y = ny;

  sendViewportThrottled();
  drawJoy();
}

function viewportFromKnob() {
  const yawRange = Number(yawRangeEl.value || 90);
  const pitchRange = Number(pitchRangeEl.value || 45);

  // yaw: left/right, pitch: up/down (invert y so up is positive pitch if you want)
  const yawDeg = knob.x * yawRange;
  const pitchDeg = -knob.y * pitchRange;

  const hfovDeg = Number(hfovEl.value || 120);
  const vfovDeg = Number(vfovEl.value || 120);

  return { yawDeg, pitchDeg, hfovDeg, vfovDeg };
}

function sendViewportThrottled() {
  const now = performance.now();
  // ~30 Hz
  if (now - lastSent < 33) return;
  lastSent = now;

  if (!selectedRobotId) return;

  const vp = viewportFromKnob();
  vpStateEl.textContent =
`yawDeg: ${vp.yawDeg.toFixed(1)}
pitchDeg: ${vp.pitchDeg.toFixed(1)}
hfovDeg: ${vp.hfovDeg.toFixed(0)}
vfovDeg: ${vp.vfovDeg.toFixed(0)}`;

  send({ type:"viewport", robotId: selectedRobotId, ...vp });
}

function onDown(e){
  dragging = true;
  const p = (e.touches && e.touches[0]) ? e.touches[0] : e;
  updateKnobFromClient(p.clientX, p.clientY);
}
function onMove(e){
  if (!dragging) return;
  const p = (e.touches && e.touches[0]) ? e.touches[0] : e;
  updateKnobFromClient(p.clientX, p.clientY);
}
function onUp(){
  dragging = false;
}

joy.addEventListener("mousedown", onDown);
window.addEventListener("mousemove", onMove);
window.addEventListener("mouseup", onUp);

joy.addEventListener("touchstart", (e)=>{ e.preventDefault(); onDown(e); }, {passive:false});
joy.addEventListener("touchmove", (e)=>{ e.preventDefault(); onMove(e); }, {passive:false});
joy.addEventListener("touchend", (e)=>{ e.preventDefault(); onUp(); }, {passive:false});
joy.addEventListener("touchcancel", (e)=>{ e.preventDefault(); onUp(); }, {passive:false});

btnCenter.addEventListener("click", ()=>{
  knob.x = 0; knob.y = 0;
  drawJoy();
  // send immediately
  lastSent = 0;
  sendViewportThrottled();
});

drawJoy();
