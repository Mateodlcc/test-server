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
 * robots: robotId -> { ws, meta, lastSeen }
 * headsets: clientId -> { ws, selectedRobotId, lastControlTs, lastSeq }
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
      lastSeen: r.lastSeen
    });
  }
  return out;
}

/** --- SAFETY BARRIER (edit to your needs) --- */
function gateControl(headsetState, robotId, controlMsg) {
  // 1) Must be controlling selected robot
  if (headsetState.selectedRobotId !== robotId) {
    return { ok: false, status: "rejected", reason: "not_selected_robot" };
  }

  // 2) Rate limit (e.g., 30 Hz)
  const t = nowMs();
  const minDt = 1000 / 30;
  if (headsetState.lastControlTs && (t - headsetState.lastControlTs) < minDt) {
    return { ok: false, status: "dropped", reason: "rate_limited" };
  }
  headsetState.lastControlTs = t;

  // 3) Sequence monotonicity (optional)
  if (typeof controlMsg.seq === "number") {
    if (typeof headsetState.lastSeq === "number" && controlMsg.seq <= headsetState.lastSeq) {
      return { ok: false, status: "dropped", reason: "old_seq" };
    }
    headsetState.lastSeq = controlMsg.seq;
  }

  // 4) Clamp joystick values to [-1, 1]
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  const gated = { ...controlMsg };
  if (typeof gated.lx === "number") gated.lx = clamp(gated.lx);
  if (typeof gated.ly === "number") gated.ly = clamp(gated.ly);
  if (typeof gated.rx === "number") gated.rx = clamp(gated.rx);
  if (typeof gated.ry === "number") gated.ry = clamp(gated.ry);

  // 5) Example “deadman switch” (optional):
  // require a button held to forward motion
  // if (!gated.deadman) { gated.lx = 0; gated.ly = 0; }

  return { ok: true, status: "forwarded", gatedMsg: gated };
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

        // Replace existing robot with same id
        if (robots.has(robotId) && robots.get(robotId).ws !== ws) {
          try { robots.get(robotId).ws.close(); } catch {}
        }

        ws._role = "robot";
        ws._robotId = robotId;

        robots.set(robotId, { ws, meta: msg.meta || {}, lastSeen: nowMs() });
        safeSend(ws, { type: "hello_ok", role: "robot", robotId });

        // notify all headsets list changed
        for (const [cid, hs] of headsets.entries()) {
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
          lastControlTs: 0,
          lastSeq: null,
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

        // detach from previous
        if (hs.selectedRobotId && hs.selectedRobotId !== robotId) {
          detachHeadsetFromRobot(clientId);
        }

        hs.selectedRobotId = robotId;
        safeSend(ws, { type: "selected_robot", robotId });

        safeSend(robots.get(robotId).ws, { type: "viewer_attached", clientId });
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

      // Controls: headset -> server -> robot (after barrier)
      if (msg.type === "control") {
        const robotId = String(msg.robotId || hs.selectedRobotId || "");
        if (!robotId || !robots.has(robotId)) {
          safeSend(ws, { type: "error", reason: "robot_not_online_or_not_selected" });
          return;
        }

        const result = gateControl(hs, robotId, msg);

        if (!result.ok) {
          // You can be noisy or silent; I recommend feedback for debugging
          safeSend(ws, { type: "control_status", seq: msg.seq, status: result.status, reason: result.reason });
          return;
        }

        safeSend(robots.get(robotId).ws, { ...result.gatedMsg, gated: true });
        // optional: ack
        // safeSend(ws, { type: "control_status", seq: msg.seq, status: "forwarded" });
        return;
      }

      return;
    }

    /** ROBOT COMMANDS */
    if (ws._role === "robot") {
      const robotId = ws._robotId;
      const r = robots.get(robotId);
      if (r) r.lastSeen = nowMs();

      // WebRTC signaling from robot -> the headset that selected it
      if (msg.type === "answer" || msg.type === "candidate") {
        // Find all headsets currently monitoring this robot (usually 1)
        for (const [cid, hs] of headsets.entries()) {
          if (hs.selectedRobotId === robotId) {
            safeSend(hs.ws, { ...msg });
          }
        }
        return;
      }

      // Robot can push stream format to the headset(s)
      if (msg.type === "streamFormat") {
        for (const [cid, hs] of headsets.entries()) {
          if (hs.selectedRobotId === robotId) {
            safeSend(hs.ws, msg);
          }
        }
        return;
      }

      // Optional: robot telemetry to headset(s)
      if (msg.type === "telemetry") {
        for (const [cid, hs] of headsets.entries()) {
          if (hs.selectedRobotId === robotId) {
            safeSend(hs.ws, msg);
          }
        }
        return;
      }

      return;
    }
  });

  ws.on("close", () => {
    // cleanup
    if (ws._role === "robot" && ws._robotId) {
      robots.delete(ws._robotId);

      // notify headsets that list changed
      for (const [cid, hs] of headsets.entries()) {
        safeSend(hs.ws, { type: "robots", robots: snapshotRobots() });
        // if someone was watching that robot, tell them
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
