const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("Signal Server Running!"));

server.listen(PORT, () => {
  console.log("Server listening on port " + PORT);
});

/**
 * Room model:
 * rooms[roomId] = { publisher: ws|null, viewers: Set<ws> }
 */
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { publisher: null, viewers: new Set() });
  }
  return rooms.get(roomId);
}

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function cleanupSocket(ws) {
  const roomId = ws._roomId;
  const role = ws._role;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  if (role === "publisher") {
    if (room.publisher === ws) room.publisher = null;
    // Notify viewers that publisher left
    for (const v of room.viewers) safeSend(v, { type: "publisher_left" });
  } else if (role === "viewer") {
    room.viewers.delete(ws);
  }

  // Delete empty room
  if (!room.publisher && room.viewers.size === 0) rooms.delete(roomId);
}

wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.log("Non-JSON message ignored:", raw.toString());
      return;
    }

    // 1) JOIN HANDSHAKE
    if (msg.type === "join") {
      const roomId = String(msg.room || "default");
      const role = msg.role === "publisher" ? "publisher" : "viewer";

      ws._roomId = roomId;
      ws._role = role;

      const room = getRoom(roomId);

      if (role === "publisher") {
        // Enforce one publisher per room (replace previous)
        if (room.publisher && room.publisher !== ws) {
          safeSend(room.publisher, { type: "kicked", reason: "New publisher joined" });
          try { room.publisher.close(); } catch {}
        }
        room.publisher = ws;

        console.log(`Publisher joined room=${roomId}`);
        safeSend(ws, { type: "joined", room: roomId, role });

        // Tell viewers publisher is available
        for (const v of room.viewers) safeSend(v, { type: "publisher_ready" });

      } else {
        room.viewers.add(ws);
        console.log(`Viewer joined room=${roomId}`);
        safeSend(ws, { type: "joined", room: roomId, role });

        // If publisher already present, notify viewer
        if (room.publisher) safeSend(ws, { type: "publisher_ready" });
      }

      return;
    }

    // Must be joined for anything else
    const roomId = ws._roomId;
    const role = ws._role;
    if (!roomId || !role) {
      safeSend(ws, { type: "error", reason: "Must join first: send {type:'join', room, role}" });
      return;
    }

    const room = getRoom(roomId);

    // 2) WEBRTC SIGNALING ROUTING
    // viewer -> publisher (offer/candidate)
    // publisher -> viewer (answer/candidate)
    if (msg.type === "offer" || msg.type === "candidate") {
      if (role === "viewer") {
        // viewer to publisher
        if (!room.publisher) {
          safeSend(ws, { type: "error", reason: "No publisher in room" });
          return;
        }
        safeSend(room.publisher, { ...msg, room: roomId, from: "viewer" });
      } else {
        // publisher broadcast to viewers (usually candidates)
        for (const v of room.viewers) safeSend(v, { ...msg, room: roomId, from: "publisher" });
      }
      return;
    }

    if (msg.type === "answer") {
      // publisher -> viewer(s), typically answer goes back to the viewer that offered.
      // simplest: send to ALL viewers (works if you only have 1 viewer per room)
      if (role !== "publisher") {
        safeSend(ws, { type: "error", reason: "Only publisher can send answer" });
        return;
      }
      for (const v of room.viewers) safeSend(v, { ...msg, room: roomId, from: "publisher" });
      return;
    }

    // 3) CONTROLS: viewer -> publisher only
    if (msg.type === "control") {
      if (role !== "viewer") return;
      if (!room.publisher) return;
      safeSend(room.publisher, { ...msg, room: roomId, from: "viewer" });
      return;
    }

    // 4) STREAM FORMAT METADATA: publisher -> viewers
    // {type:"streamFormat", format:"flat2d"|"equirect360"}
    if (msg.type === "streamFormat") {
      if (role !== "publisher") return;
      for (const v of room.viewers) safeSend(v, { ...msg, room: roomId, from: "publisher" });
      return;
    }

    // 5) default: ignore or log
    // console.log("Unhandled msg", msg);
  });

  ws.on("close", () => {
    cleanupSocket(ws);
    console.log("Client disconnected");
  });
});
