const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on port " + PORT));
app.get("/", (req, res) => res.send("Signal/Control Server Running!"));

/**
 * State:
 * robots: robotId -> { ws, meta, lastSeen, streamMode }
 * headsets: clientId -> { ws, selectedRobotId, lastJoyTs, lastViewportTs }
 */
const robots = new Map();
const headsets = new Map();

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function nowMs() { return Date.now(); }

function snapshotRobots() {
  const out = [];
  for (const [robotId, r] of robots.entries()) {
    out.push({
      robotId,
      meta: r.meta || {},
      online: true,
      lastSeen: r.lastSeen,
      streamMode: r.streamMode || "flat2d",
    });
  }
  return out;
}

function detachHeadsetFromRobot(clientId) {
  const hs = headsets.get(clientId);
  if (!hs) return;
  const oldRobotId = hs.selectedRobotId;
  hs.selectedRobotId = null;

  if (oldRobotId && robots.has(oldRobotId)) {
    safeSend(robots.get(oldRobotId).ws, { type: "viewer_detached", clientId });
  }
}

function requireSelectedRobot(hs, robotId) {
  if (!robotId) return { ok: false, reason: "no_robotId" };
  if (!robots.has(robotId)) return { ok: false, reason: "robot_not_online" };
  if (hs.selectedRobotId !== robotId) return { ok: false, reason: "not_selected_robot" };
  return { ok: true };
}

function clamp(v, lo, hi) {
  if (typeof v !== "number") return v;
  return Math.max(lo, Math.min(hi, v));
}

/** joy: both sticks + triggers */
function gateJoy(hs, msg) {
  // allow up to 90 Hz
  const t = nowMs();
  const minDt = 1000 / 90;
  if (hs.lastJoyTs && (t - hs.lastJoyTs) < minDt) {
    return { ok: false, reason: "rate_limited_joy" };
  }
  hs.lastJoyTs = t;

  const lx = clamp(Number(msg.lx), -1, 1);
  const ly = clamp(Number(msg.ly), -1, 1);
  const rx = clamp(Number(msg.rx), -1, 1);
  const ry = clamp(Number(msg.ry), -1, 1);

  const lt = (msg.lt === undefined || msg.lt === null) ? 0 : clamp(Number(msg.lt), 0, 1);
  const rt = (msg.rt === undefined || msg.rt === null) ? 0 : clamp(Number(msg.rt), 0, 1);

  if ([lx, ly, rx, ry, lt, rt].some((v) => Number.isNaN(v))) {
    return { ok: false, reason: "invalid_joy" };
  }

  return {
    ok: true,
    gatedMsg: {
      type: "joy",
      robotId: msg.robotId,
      lx, ly, rx, ry, lt, rt,
      ts: typeof msg.ts === "number" ? msg.ts : undefined
    }
  };
}

/** btn: edge press/release */
function gateBtn(_hs, msg) {
  const id = String(msg.id || "").slice(0, 32);
  const v = (msg.v === 1 || msg.v === "1" || msg.v === true) ? 1 : 0;
  if (!id) return { ok: false, reason: "invalid_btn_id" };

  return {
    ok: true,
    gatedMsg: {
      type: "btn",
      robotId: msg.robotId,
      id,
      v,
      ts: typeof msg.ts === "number" ? msg.ts : undefined
    }
  };
}

/** viewport: head-aligned crop window */
function gateViewport(hs, msg) {
  // allow up to 60 Hz (head tracking)
  const t = nowMs();
  const minDt = 1000 / 60;
  if (hs.lastViewportTs && (t - hs.lastViewportTs) < minDt) {
    return { ok: false, reason: "rate_limited_viewport" };
  }
  hs.lastViewportTs = t;

  const yawDeg = clamp(Number(msg.yawDeg), -180, 180);
  const pitchDeg = clamp(Number(msg.pitchDeg), -89, 89);

  const hfovDeg = clamp(Number(msg.hfovDeg), 20, 180);
  const vfovDeg = clamp(Number(msg.vfovDeg), 20, 160);

  if ([yawDeg, pitchDeg, hfovDeg, vfovDeg].some((v) => Number.isNaN(v))) {
    return { ok: false, reason: "invalid_viewport" };
  }

  return {
    ok: true,
    gatedMsg: {
      type: "viewport",
      robotId: msg.robotId,
      yawDeg,
      pitchDeg,
      hfovDeg,
      vfovDeg
    }
  };
}

wss.on("connection", (ws) => {
  ws._role = null;
  ws._robotId = null;
  ws._clientId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    /** HELLO / IDENTIFY */
    if (msg.type === "hello") {
      if (msg.role === "robot") {
        const robotId = String(msg.robotId || "");
        if (!robotId) { safeSend(ws, { type: "error", reason: "robotId_required" }); return; }

        if (robots.has(robotId) && robots.get(robotId).ws !== ws) {
          try { robots.get(robotId).ws.close(); } catch {}
        }

        ws._role = "robot";
        ws._robotId = robotId;

        const prev = robots.get(robotId);
        robots.set(robotId, {
          ws,
          meta: msg.meta || (prev?.meta || {}),
          lastSeen: nowMs(),
          streamMode: prev?.streamMode || "flat2d",
        });

        safeSend(ws, { type: "hello_ok", role: "robot", robotId });

        for (const [, hs] of headsets.entries()) {
          safeSend(hs.ws, { type: "robots", robots: snapshotRobots() });
        }
        return;
      }

      if (msg.role === "headset") {
        const clientId = String(msg.clientId || "headset-" + Math.random().toString(16).slice(2));
        ws._role = "headset";
        ws._clientId = clientId;

        headsets.set(clientId, {
          ws,
          selectedRobotId: null,
          lastJoyTs: 0,
          lastViewportTs: 0,
        });

        safeSend(ws, { type: "hello_ok", role: "headset", clientId });
        safeSend(ws, { type: "robots", robots: snapshotRobots() });
        return;
      }

      safeSend(ws, { type: "error", reason: "role_must_be_robot_or_headset" });
      return;
    }

    /** Must be identified from here on */
    if (!ws._role) {
      safeSend(ws, { type: "error", reason: "send_hello_first" });
      return;
    }

    /** HEADSET COMMANDS */
    if (ws._role === "headset") {
      const clientId = ws._clientId;
      const hs = headsets.get(clientId);
      if (!hs) return;

      if (msg.type === "list_robots") {
        safeSend(ws, { type: "robots", robots: snapshotRobots() });
        return;
      }

      if (msg.type === "select_robot") {
        const robotId = String(msg.robotId || "");
        if (!robots.has(robotId)) {
          safeSend(ws, { type: "error", reason: "robot_not_online", robotId });
          return;
        }

        if (hs.selectedRobotId && hs.selectedRobotId !== robotId) {
          detachHeadsetFromRobot(clientId);
        }

        hs.selectedRobotId = robotId;
        safeSend(ws, { type: "selected_robot", robotId });

        safeSend(robots.get(robotId).ws, { type: "viewer_attached", clientId });

        // Replay last streamMode so the headset UI can switch renderers immediately
        const mode = robots.get(robotId).streamMode || "flat2d";
        safeSend(ws, { type: "streamMode", mode });

        return;
      }

      // WebRTC signaling from headset -> selected robot
      if (msg.type === "offer" || msg.type === "candidate") {
        const robotId = hs.selectedRobotId;
        if (!robotId || !robots.has(robotId)) {
          safeSend(ws, { type: "error", reason: "no_selected_robot" });
          return;
        }
        safeSend(robots.get(robotId).ws, { ...msg, clientId });
        return;
      }

      // Locomotion: joy
      if (msg.type === "joy") {
        const robotId = String(msg.robotId || hs.selectedRobotId || "");
        const req = requireSelectedRobot(hs, robotId);
        if (!req.ok) return;

        msg.robotId = robotId;
        const gated = gateJoy(hs, msg);
        if (!gated.ok) return;

        safeSend(robots.get(robotId).ws, gated.gatedMsg);
        return;
      }

      // Buttons: edge press/release
      if (msg.type === "btn") {
        const robotId = String(msg.robotId || hs.selectedRobotId || "");
        const req = requireSelectedRobot(hs, robotId);
        if (!req.ok) return;

        msg.robotId = robotId;
        const gated = gateBtn(hs, msg);
        if (!gated.ok) return;

        safeSend(robots.get(robotId).ws, gated.gatedMsg);
        return;
      }

      // Head-aligned crop window: viewport
      if (msg.type === "viewport") {
        const robotId = String(msg.robotId || hs.selectedRobotId || "");
        const req = requireSelectedRobot(hs, robotId);
        if (!req.ok) return;

        msg.robotId = robotId;
        const gated = gateViewport(hs, msg);
        if (!gated.ok) return;

        safeSend(robots.get(robotId).ws, gated.gatedMsg);
        return;
      }

      return;
    }

    /** ROBOT COMMANDS */
    if (ws._role === "robot") {
      const robotId = ws._robotId;
      const r = robots.get(robotId);
      if (r) r.lastSeen = nowMs();

      // WebRTC signaling from robot -> headsets that selected it
      if (msg.type === "answer" || msg.type === "candidate") {
        for (const [, hs] of headsets.entries()) {
          if (hs.selectedRobotId === robotId) safeSend(hs.ws, { ...msg });
        }
        return;
      }

      // Robot announces current stream mode (flat2d/full360/crop360)
      if (msg.type === "streamMode") {
        if (r) r.streamMode = msg.mode;

        for (const [, hs] of headsets.entries()) {
          if (hs.selectedRobotId === robotId) safeSend(hs.ws, msg);
        }
        return;
      }

      // Backwards compatibility: if you still send streamFormat, map it
      if (msg.type === "streamFormat") {
        const mapped = (msg.format === "full360") ? "full360" :
                       (msg.format === "crop360") ? "crop360" : "flat2d";
        if (r) r.streamMode = mapped;

        for (const [, hs] of headsets.entries()) {
          if (hs.selectedRobotId === robotId) safeSend(hs.ws, { type: "streamMode", mode: mapped });
        }
        return;
      }

      // Telemetry passthrough
      if (msg.type === "telemetry") {
        for (const [, hs] of headsets.entries()) {
          if (hs.selectedRobotId === robotId) safeSend(hs.ws, msg);
        }
        return;
      }

      return;
    }
  });

  ws.on("close", () => {
    if (ws._role === "robot" && ws._robotId) {
      robots.delete(ws._robotId);

      for (const [, hs] of headsets.entries()) {
        safeSend(hs.ws, { type: "robots", robots: snapshotRobots() });
        if (hs.selectedRobotId === ws._robotId) {
          hs.selectedRobotId = null;
          safeSend(hs.ws, { type: "publisher_left", robotId: ws._robotId });
        }
      }
    }

    if (ws._role === "headset" && ws._clientId) {
      detachHeadsetFromRobot(ws._clientId);
      headsets.delete(ws._clientId);
    }
  });
});

// --- Keepalive ping/pong ---
function heartbeat() { this.isAlive = true; }
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);
});

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 15000);

wss.on("close", () => clearInterval(pingInterval));

app.get("/health", (req, res) => res.json({
  ok: true,
  robots: robots.size,
  headsets: headsets.size,
  now: Date.now()
}));
