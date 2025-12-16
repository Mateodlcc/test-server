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
