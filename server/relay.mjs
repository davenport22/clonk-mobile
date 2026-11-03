#!/usr/bin/env node
/**
 * Undermine relay.
 *
 * Deliberately tiny (PRD 6.6): no database, no accounts, rooms live in a Map and
 * die with the process. It does two jobs:
 *
 *  1. Sequences input. It owns the tick clock and emits one bundle per tick
 *     containing every player's most recent input, filling gaps with their last
 *     known input. Because that decision happens in exactly one place, every
 *     client consumes identical bundles and lockstep determinism survives jitter.
 *     It does NOT simulate the game.
 *  2. Compares state hashes and, on mismatch, asks the host for a snapshot and
 *     forwards it.
 *
 * It also serves ./dist when present, so one small VM can host the whole thing.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8787);
const TICK_MS = 1000 / 30;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_PLAYERS = 8;
const INPUT_BYTES = 6;
const MSG = { INPUT: 1, BUNDLE: 2, SNAPSHOT: 3 };
/** No 0/O/1/I: these codes get read aloud and retyped. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist');

const rooms = new Map();
const metrics = { roomsCreated: 0, roundsStarted: 0, desyncs: 0, peakPlayers: 0 };

function code() {
  let c = '';
  for (let i = 0; i < 6; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return rooms.has(c) ? code() : c;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function playerList(room) {
  return room.clients
    .filter((c) => c)
    .map((c) => ({ id: c.slot, name: c.name, team: c.slot % Math.max(1, room.teamCount) }));
}

function broadcast(room, obj) {
  for (const c of room.clients) if (c) send(c.ws, obj);
}

function broadcastPlayers(room) {
  broadcast(room, { t: 'players', host: room.host, players: playerList(room) });
}

function makeRoom() {
  const room = {
    code: code(),
    createdAt: Date.now(),
    clients: [],
    host: 0,
    started: false,
    teamCount: 2,
    tick: 0,
    startedAt: 0,
    timer: null,
    hashes: new Map(),
    lastDesync: -1000,
    /** Seats held open for players who dropped mid-round. */
    vacated: [],
    bots: [],
    mode: 0,
    seed: 0,
    // Short bundle history, so a client recovering from a snapshot can be given
    // the exact ticks it missed instead of guessing.
    history: [],
  };
  rooms.set(room.code, room);
  metrics.roomsCreated++;
  return room;
}

function firstFreeSlot(room) {
  for (let i = 0; i < MAX_PLAYERS; i++) if (!room.clients[i]) return i;
  return -1;
}

function activeCount(room) {
  return room.clients.filter((c) => c).length;
}

/**
 * Empty slots become bots.
 *
 * Bots are simulated identically on every client from world state, so the
 * relay only has to say which slots they occupy; it never sends input for them
 * and never simulates anything itself.
 */
function botSlots(count, teamCount, fill) {
  const bots = [];
  const target = fill ? Math.max(count, teamCount * 2) : count;
  for (let i = 0; i < Math.min(target, MAX_PLAYERS); i++) bots.push(i >= count);
  return bots;
}

function startRound(room, teamCount, mode, fillBots) {
  if (room.started) return;
  // Compact slots so the client's player index is always 0..n-1: the simulation
  // assigns teams by index and indexes its player arrays by it.
  const active = room.clients.filter((c) => c);
  room.clients = active;
  active.forEach((c, i) => {
    c.slot = i;
  });
  room.host = 0;

  room.started = true;
  room.teamCount = Math.max(1, Math.min(4, teamCount | 0 || 2));
  room.mode = mode | 0;
  room.tick = 0;
  room.startedAt = Date.now();
  const seed = (Math.random() * 0x7fffffff) | 0;
  room.players = playerList(room);
  room.bots = botSlots(active.length, room.teamCount, !!fillBots);
  room.seed = seed;
  for (const c of active) {
    send(c.ws, {
      t: 'start',
      seed,
      teamCount: room.teamCount,
      players: room.players,
      you: c.slot,
      host: room.host,
      mode: room.mode,
      bots: room.bots,
    });
  }
  metrics.roundsStarted++;

  const slots = room.players.map((p) => p.id);

  room.timer = setInterval(() => {
    const due = Math.floor((Date.now() - room.startedAt) / TICK_MS);
    let emitted = 0;
    while (room.tick <= due && emitted < 4) {
      // A fresh buffer per tick. Reusing one and mutating it is unsound: ws may
      // still hold a reference to a frame it has not flushed yet, and every
      // client must receive byte-identical bundles or lockstep breaks.
      const bundle = Buffer.alloc(6 + slots.length * INPUT_BYTES);
      bundle.writeUInt8(MSG.BUNDLE, 0);
      bundle.writeUInt8(slots.length, 5);
      bundle.writeUInt32BE(room.tick, 1);
      for (let i = 0; i < slots.length; i++) {
        const c = room.clients[slots[i]];
        const src = c ? c.input : ZERO_INPUT;
        src.copy(bundle, 6 + i * INPUT_BYTES);
      }
      for (const c of room.clients) if (c && c.ws.readyState === 1) c.ws.send(bundle);
      room.history.push({ tick: room.tick, buf: bundle });
      if (room.history.length > HISTORY_TICKS) room.history.shift();
      room.tick++;
      emitted++;
    }
  }, 8);
}

const ZERO_INPUT = Buffer.alloc(INPUT_BYTES);
/** Bundles retained for replay after a resync (90 s at 30 Hz). */
const HISTORY_TICKS = 2700;

/**
 * Sends a recovering client every bundle from the snapshot's tick onwards.
 * Without this the client resumes at the snapshot tick while the relay is
 * already further along, sees a gap, and has to ask for another snapshot -
 * converging eventually, but only after several round trips of full state.
 */
function replayFrom(room, client, fromTick) {
  let sent = 0;
  for (const h of room.history) {
    if (h.tick < fromTick) continue;
    if (client.ws.readyState === 1) client.ws.send(h.buf);
    sent++;
  }
  return sent;
}

function closeRoom(room, reason) {
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
  broadcast(room, { t: 'ended', reason });
  rooms.delete(room.code);
}

function handleHash(room, client, tick, hash, stream) {
  let entry = room.hashes.get(tick);
  if (!entry) {
    entry = new Map();
    room.hashes.set(tick, entry);
  }
  entry.set(client.slot, { hash, stream });
  for (const [k] of room.hashes) if (k < tick - 300) room.hashes.delete(k);

  if (entry.size < activeCount(room) || entry.size < 2) return;
  const values = [...entry.values()];
  const mismatch = values.some((v) => v.hash !== values[0].hash);
  if (!mismatch) return;
  if (tick - room.lastDesync < 300) return;
  room.lastDesync = tick;
  metrics.desyncs++;
  // Which half broke? Different input streams point at the relay or the
  // transport; identical streams with different state point at src/sim.
  const streamsAgree = values.every((v) => v.stream === values[0].stream);
  console.warn(
    `[${room.code}] DESYNC at tick ${tick} — ` +
      `${streamsAgree ? 'input streams AGREE, so this is a simulation divergence' : 'input streams DIFFER, so this is a transport problem'}
` +
      `  state:  ${values.map((v) => v.hash).join(' ')}
` +
      `  stream: ${values.map((v) => v.stream).join(' ')}`,
  );
  broadcast(room, { t: 'desync', tick });
  for (const c of room.clients) if (c && c.slot !== room.host) c.awaiting = true;
  const host = room.clients[room.host];
  if (host) send(host.ws, { t: 'needSnapshot' });
}

// --- static hosting ---------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, ...metrics }));
    return;
  }
  let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/' || rel === '\\' || rel.startsWith('/r/')) rel = '/index.html';
  let file = join(distDir, rel);
  try {
    const st = await stat(file);
    if (st.isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(distDir, 'index.html');
  }
  try {
    const body = await readFile(file);
    // Hashed assets are immutable; the entry document and the service worker
    // never are. A service worker pinned in a browser cache for a year cannot
    // be updated, which strands every installed client on an old build.
    const base = basename(file);
    const mutable = base === 'index.html' || base === 'sw.js' || base === 'registerSW.js' || base === 'manifest.webmanifest';
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': mutable ? 'no-cache' : 'public, max-age=31536000, immutable',
      'service-worker-allowed': '/',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found — build the client with `npm run build` to serve it here');
  }
}

// --- wiring ----------------------------------------------------------------

const http = createServer((req, res) => {
  serveStatic(req, res).catch(() => {
    res.writeHead(500);
    res.end('error');
  });
});

const wss = new WebSocketServer({ server: http });

wss.on('connection', (ws) => {
  let room = null;
  let client = null;

  const leave = () => {
    if (!room || !client) return;
    // Mid-round, hold the seat rather than collapsing the game around it.
    if (room.started) {
      room.vacated.push({ slot: client.slot, name: client.name, at: Date.now() });
      console.log(`[${room.code}] ${client.name} dropped; seat ${client.slot} held open`);
    }
    room.clients[client.slot] = null;
    if (activeCount(room) === 0) {
      if (room.timer) clearInterval(room.timer);
      rooms.delete(room.code);
      console.log(`[${room.code}] room closed`);
    } else {
      if (room.host === client.slot) {
        room.host = room.clients.findIndex((c) => c);
      }
      broadcastPlayers(room);
    }
    room = null;
    client = null;
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const tag = buf.readUInt8(0);
      if (tag === MSG.INPUT && client) {
        buf.copy(client.input, 0, 1, 1 + INPUT_BYTES);
      } else if (tag === MSG.SNAPSHOT && room) {
        const snapTick = buf.readUInt32BE(1);
        for (const c of room.clients) {
          if (!c || c === client || c.ws.readyState !== 1) continue;
          c.ws.send(buf);
          if (c.awaiting) {
            c.awaiting = false;
            const n = replayFrom(room, c, snapTick);
            console.log(`[${room.code}] replayed ${n} bundles to ${c.name} from tick ${snapTick}`);
          }
        }
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.t === 'ping') {
      send(ws, { t: 'pong', ts: msg.ts });
      return;
    }

    if (msg.t === 'create' || msg.t === 'join') {
      if (room) leave();
      const target = msg.t === 'create' ? makeRoom() : rooms.get(String(msg.room ?? '').toUpperCase());
      if (!target) {
        send(ws, { t: 'error', msg: 'No such room. Check the code.' });
        return;
      }
      // Reconnect (PRD S5): a round in progress keeps a dropped player's slot
      // open, and the same name walking back in takes it over. On a phone this
      // is not an edge case - a locked screen, a tunnel, or a switch to another
      // app is enough to drop a socket.
      if (target.started) {
        const name = String(msg.name ?? '').slice(0, 16);
        const seat = target.vacated.findIndex((v) => v && v.name === name);
        if (seat < 0) {
          send(ws, { t: 'error', msg: 'That round already started.' });
          return;
        }
        const vac = target.vacated[seat];
        target.vacated[seat] = null;
        room = target;
        client = { ws, slot: vac.slot, name, input: Buffer.alloc(INPUT_BYTES), awaiting: true };
        room.clients[vac.slot] = client;
        send(ws, {
          t: 'start',
          seed: room.seed,
          teamCount: room.teamCount,
          players: room.players,
          you: vac.slot,
          host: room.host,
          mode: room.mode,
          bots: room.bots,
        });
        const host = room.clients[room.host];
        if (host) send(host.ws, { t: 'needSnapshot' });
        console.log(`[${room.code}] ${name} reconnected into slot ${vac.slot}`);
        return;
      }
      const slot = firstFreeSlot(target);
      if (slot < 0) {
        send(ws, { t: 'error', msg: 'Room is full.' });
        return;
      }
      room = target;
      client = {
        ws,
        slot,
        name: String(msg.name ?? '').slice(0, 16) || `Player ${slot + 1}`,
        input: Buffer.alloc(INPUT_BYTES),
        awaiting: false,
      };
      room.clients[slot] = client;
      if (activeCount(room) === 1) room.host = slot;
      metrics.peakPlayers = Math.max(metrics.peakPlayers, activeCount(room));
      send(ws, {
        t: 'joined',
        room: room.code,
        you: slot,
        host: room.host,
        players: playerList(room),
      });
      broadcastPlayers(room);
      console.log(`[${room.code}] ${client.name} joined slot ${slot} (${activeCount(room)} in room)`);
      return;
    }

    if (!room || !client) return;

    if (msg.t === 'start') {
      if (client.slot !== room.host) return;
      startRound(room, msg.teamCount ?? 2, msg.mode ?? 0, msg.fillBots !== false);
      console.log(
        `[${room.code}] round started: ${activeCount(room)} players, ` +
          `${room.bots.filter(Boolean).length} bots, ${room.teamCount} teams, mode ${room.mode}`,
      );
      return;
    }

    if (msg.t === 'resync') {
      if (client.awaiting) return;
      client.awaiting = true;
      const host = room.clients[room.host];
      if (host) send(host.ws, { t: 'needSnapshot' });
      console.log(`[${room.code}] ${client.name} lost sync and asked for a resync`);
      return;
    }

    if (msg.t === 'hash') {
      handleHash(room, client, msg.tick | 0, msg.hash | 0, msg.stream | 0);
    }
  });

  ws.on('close', leave);
  ws.on('error', leave);
});

const SEAT_HOLD_MS = 120000;

setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      closeRoom(room, 'room expired');
      continue;
    }
    // Stop holding a seat for someone who is clearly not coming back.
    room.vacated = room.vacated.filter((v) => v && now - v.at < SEAT_HOLD_MS);
  }
}, 20000);

http.listen(PORT, () => {
  console.log(`relay listening on :${PORT}  (ws + static ./dist)`);
});
