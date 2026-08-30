// spectator-client.js — read-only connection to the game's WebSocket server.
//
// A spectator watches the live match without being in it: the server sees the
// `?spectate=1` flag in the URL query and never adds the socket to the players map, so a
// spectator cannot join, be hit, fire, or appear in the highscore. It still receives
// `hello` and every subsequent broadcast, which is enough to render everyone else.
//
// This owns the socket, the reconnect policy and a SnapshotBuffer that it feeds as poses
// arrive; consumers just sample the buffer once per frame. No A-Frame, no THREE, no DOM.
import { SnapshotBuffer } from "./interpolation.js";

// ---- reconnect tuning (mirrors src/game/network/network.js) ----
const RECONNECT_BASE = 500; // ms before the first retry
const RECONNECT_MAX = 15000; // ms ceiling on the backoff
const RECONNECT_JITTER = 0.3; // ±30% so a server restart doesn't stampede every client

// Add the spectator flag unless the caller already put it there.
function withSpectateFlag(url) {
  if (/[?&]spectate=/.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "spectate=1";
}

// The pose fields SnapshotBuffer cares about, lifted out of a protocol message.
function toPose(m) {
  const pose = { x: m.x, y: m.y, z: m.z, ry: m.ry, speed: m.speed };
  if (m.animation) pose.animation = m.animation;
  return pose;
}

/**
 * Connect as a spectator.
 *
 * @param {string} url  full ws:// or wss:// URL; `?spectate=1` is appended if absent.
 * @param {object} handlers  all optional:
 *   onHello(players, message), onJoin(player), onLeave(id), onPose(id, pose, serverTimeMs),
 *   onName(id, name), onSpawn(player), onRespawn(player), onDeath(id),
 *   onFire(id, serverTimeMs),
 *   onStatus(state) with state one of "connecting" | "online" | "offline".
 *
 *   Capture the Flag. The match is the reason a spectator view exists at all, so
 *   these are first-class rather than something a consumer has to dig out of the
 *   raw `hello`:
 *   onCtf(ctf, reason)   the whole match state - { flags, scores, capLimit, state,
 *                        winner, resetInMs } - with reason "hello" or "match-reset".
 *                        Both are wholesale replacements: after a reconnect or a
 *                        reset the teams are the same but nothing else is.
 *   onFlag(flag)         one flag transition: { team, state, x, y, z, carrier,
 *                        returnInMs, event, by, byName, byTeam }. `state` is one of
 *                        "home" | "carried" | "dropped" and is the ONLY thing that
 *                        ever moves a flag.
 *   onScore(scores, msg) a capture: { red, blue }, plus { by, team } on msg.
 *   onTeam(id, team)     a player changed sides (a resumed session stash).
 *   onMatchEnd(msg)      { winner, scores, resetInMs }.
 * @returns {{ close: () => void, buffer: SnapshotBuffer }}
 */
export function connectSpectator(url, handlers = {}) {
  const buffer = new SnapshotBuffer();
  const target = withSpectateFlag(url);

  let ws = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let closedByUs = false;

  // A throwing handler is the consumer's bug, not a reason to drop the connection.
  const emit = (name, ...args) => {
    const fn = handlers[name];
    if (typeof fn !== "function") return;
    try {
      fn(...args);
    } catch (err) {
      console.error(`[spectator] ${name} handler threw:`, err);
    }
  };

  const status = (state) => emit("onStatus", state);

  // Poses carry a server timestamp; spawn/join/respawn do not, and SnapshotBuffer falls
  // back to arrival time for those. Large jumps (a respawn) snap rather than slide.
  const feed = (p, serverTimeMs) => {
    if (!p || p.id === undefined || p.id === null) return;
    buffer.push(p.id, toPose(p), serverTimeMs);
  };

  function connect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (closedByUs) return;

    const WS = typeof WebSocket !== "undefined" ? WebSocket : typeof globalThis !== "undefined" ? globalThis.WebSocket : undefined;
    if (!WS) {
      console.error("[spectator] No WebSocket implementation in this environment");
      status("offline");
      return;
    }

    status("connecting");

    let sock;
    try {
      sock = new WS(target);
      ws = sock;
    } catch (err) {
      console.error("[spectator] WebSocket construction failed:", err);
      scheduleReconnect();
      return;
    }

    // A socket we have already replaced must not be able to speak for the session: an
    // old socket's late onclose would otherwise clear the buffer and schedule a
    // reconnect on top of a connection that is already healthy.
    const stale = () => ws !== sock;

    sock.onopen = () => {
      if (stale()) return;
      reconnectAttempts = 0;
      status("online");
    };

    sock.onmessage = (e) => {
      if (stale()) return;
      let m;
      try {
        m = JSON.parse(typeof e.data === "string" ? e.data : String(e.data));
      } catch {
        return;
      }

      switch (m.type) {
        case "hello": {
          // Reconnects hand out fresh ids, so anything held from the old session is a
          // ghost. Start from the roster this hello carries.
          buffer.clear();
          const players = m.players || [];
          players.forEach((p) => feed(p));
          emit("onHello", players, m);
          // The match arrives with the roster, not after it: a spectator that
          // connects mid-game must see the flags where they actually are, which
          // may be on somebody's back.
          if (m.ctf) emit("onCtf", m.ctf, "hello");
          break;
        }
        case "join":
          if (m.player) {
            feed(m.player);
            emit("onJoin", m.player);
          }
          break;
        case "leave":
          buffer.remove(m.id);
          emit("onLeave", m.id);
          break;
        case "name":
          emit("onName", m.id, m.name);
          break;
        case "spawn":
          if (m.player) {
            feed(m.player);
            emit("onSpawn", m.player);
          }
          break;
        case "respawn":
          if (m.player) {
            feed(m.player);
            emit("onRespawn", m.player);
          }
          break;
        case "pose": {
          const pose = toPose(m);
          buffer.push(m.id, pose, m.t);
          emit("onPose", m.id, pose, m.t);
          break;
        }
        case "death":
          emit("onDeath", m.id, m.by);
          break;
        case "fire":
          // Who shot, and when. NOT where it landed: the server broadcasts the
          // shot, and hit resolution is a separate message against a victim, so
          // a spectator cannot know where a shot ended without re-tracing it.
          // Enough for a muzzle flash, which is what reads at table scale.
          emit("onFire", m.id, m.t);
          break;
        // ---- capture the flag ----
        // One message type per flag transition, so there is exactly one code path
        // and a late `flag` can never disagree with the state already held.
        case "flag":
          emit("onFlag", m);
          break;
        case "ctf-score":
          emit("onScore", m.scores || { red: 0, blue: 0 }, m);
          break;
        case "team":
          emit("onTeam", m.id, m.team);
          break;
        case "match-end":
          emit("onMatchEnd", m);
          break;
        case "match-reset":
          // Carries a full publicCtf(), so it is the same wholesale replacement
          // `hello` is - flags home, scores zero. Nothing has to be reconciled.
          if (m.ctf) emit("onCtf", m.ctf, "match-reset");
          emit("onMatchReset", m);
          break;
        default:
          // hit / player-kill / highscore-update are not part of the spectator
          // contract — a spectator renders motion, it does not simulate combat.
          break;
      }
    };

    sock.onclose = () => {
      if (stale()) return;
      ws = null;
      buffer.clear();
      if (closedByUs) return;
      status("offline");
      scheduleReconnect();
    };

    sock.onerror = () => {
      // onerror is always followed by onclose; let onclose own the reconnect.
    };
  }

  // Exponential backoff with jitter, capped. Retries forever — a phone that walks out of
  // range comes back on its own, and onStatus tells the page what is happening.
  function scheduleReconnect() {
    if (reconnectTimer || closedByUs) return;
    reconnectAttempts++;

    const backoff = Math.min(RECONNECT_MAX, RECONNECT_BASE * Math.pow(2, reconnectAttempts - 1));
    const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER;
    const delay = Math.round(backoff * jitter);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function close() {
    closedByUs = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const sock = ws;
    ws = null;
    if (sock) {
      try {
        sock.close(1000, "spectator closed");
      } catch {
        /* nothing useful to do here */
      }
    }
    buffer.clear();
  }

  connect();

  return { close, buffer };
}

export default connectSpectator;
