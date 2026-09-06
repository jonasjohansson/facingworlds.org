// network.js (ES module) — the wire. No entities, no selectors, no waiting for a scene.
//
// The protocol handling below is the same switch it has always been, message for message.
// What changed is everything it used to reach for through the DOM: `startNetwork(game)`
// is handed the engine (src/game/engine/game.js) and talks to the ported systems by
// method call. The old→new mapping, in one place:
//
//   the #rig lookup                     game.rig
//   the rig entity's object3D pose      game.rig.position / game.rig.rotation.y
//   ut-jump's visualOffset() on the rig game.player.visualOffset()
//   the #cam entity's own yaw           gone: the controller puts yaw on the RIG and
//   (look-controls put mouse yaw there) pitch on the head, so the wire yaw is
//                                       game.rig.rotation.y alone
//   writing the rig's position attr     game.player.spawnAt(x, y, z, yaw), which also
//                                       resets the navmesh clamp (see the "EVERY
//                                       TELEPORT" block in player/controller.js)
//   #rig's dataset.playerId             game.rig.userData.playerId
//   spawnRemote(): two entities + data-*  remoteAvatars.spawn(publicPlayer)
//   remotes (id -> rig element)         remoteAvatars.get(id) -> RemoteAvatar
//   the [remote-avatar] child lookup    the RemoteAvatar itself
//   component.setNetPose(p)             avatar.setPose(p)
//   the entity's "sethp" event          avatar.setHp(hp) / the local player's Health
//   the entity's data-name attribute    avatar.name / avatar.setName(n)
//   scene.emit(name, detail)            game.events.emit(name, detail) — same names,
//                                       same payloads, same listeners
//   hitscan(scene, …, {excludeEl, …})   traceShot(game, …, {maxDist, excludeId})
//   drawHitscanShot(scene, …)           game.systems.get("ut-effects").…
//   spawnProjectile(scene, m) etc.      game.systems.get("ut-projectiles").…
//
// Protocol fixes belong HERE.
import * as THREE from "three";
import { getWebSocketUrl } from "../utils/environment.js";
import { GAME_CONFIG } from "../config/game-config.js";
import { markServerSpawnApplied } from "../player/spawn.js";
import { DEFAULT_WEAPON, weapon } from "../../shared/weapons.js";
import { announce } from "../systems/announcer.js";
import { traceShot } from "../systems/hitscan.js";

// ---- reconnect tuning ----
const RECONNECT_BASE = 500; // ms before the first retry
const RECONNECT_MAX = 15000; // ms ceiling on the backoff
const RECONNECT_JITTER = 0.3; // ±30% so a server restart doesn't stampede every client

/**
 * @param {object} game the engine handle: needs `events`, `rig`, `player` and the
 *   `remote-avatars` / `ut-effects` / `ut-projectiles` systems. The three systems are
 *   looked up LAZILY, not here: core/main.js starts the network where the old
 *   main.js did — right after the player, before the offline navmesh placement — and the
 *   rest of the registry is filled in on the same synchronous run, long before a socket
 *   can deliver anything.
 * @returns {{dispose: () => void}} the client, shaped as a system: main.js
 *   registers it so game.dispose() closes the socket and clears the timers. See
 *   dispose() at the bottom for what would otherwise outlive the game.
 */
export function startNetwork(game) {
  const WS_URL = getWebSocketUrl();
  const events = game.events;
  let ws,
    myId = null;
  // CTF: the team the server put us on. Null until `hello` (and for spectators).
  // It is only ever set from a server message — the client never picks a side.
  let myTeam = null;
  // Which weapon each player is holding, kept from the loadout broadcasts the server
  // already sends for everyone. Used only to pick the right FIRE SOUND for someone
  // else's shot: the damage was never the client's to know, and still is not.
  const remoteWeapons = new Map();

  // reconnect state
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let closedByUs = false;
  let statusEl = null;
  // The 20 Hz pose sampler's interval id, and the one-way latch dispose() sets. Both
  // exist because startNetwork returns a handle now: nothing in this closure is
  // garbage-collectable while a timer, a socket or a bus subscription still points at it.
  let poseTimer = null;
  let disposed = false;

  // ---- the systems this file speaks to ----
  // `remotes` (a Map of id -> rig element) is the registry now. It, and the two effect
  // systems, are resolved on first use and cached: see the note on startNetwork above.
  let _avatars = null;
  let _fx = null;
  let _pj = null;
  const avatars = () => _avatars || (_avatars = game.systems.get("remote-avatars") || null);
  const fx = () => _fx || (_fx = game.systems.get("ut-effects") || null);
  const pj = () => _pj || (_pj = game.systems.get("ut-projectiles") || null);

  /**
   * The Health instance behind a player id — the local player's own, or a remote body's.
   * It is what `targetEntity.components.health` was: `setHp()` is the write (RemoteAvatar
   * .setHp() is a one-line delegate to this same object) and `hp` the read the kill test
   * below needs before that write lands.
   */
  const healthOf = (id) => {
    if (id === myId) return (game.player && game.player.health) || null;
    const a = avatars() && avatars().get(id);
    return a ? a.health : null;
  };

  // ---- tiny utils ----
  const q2 = (n) => Math.round(n * 100) / 100;
  const q3 = (n) => Math.round(n * 1000) / 1000;

  // ---- main init ----
  // No DOM wait and no scene wait: main.js calls this after DOMContentLoaded and
  // after `await buildWorld()`, so the body, the rig and the player all exist already.
  const offBus = [
    events.on("local-fire", onLocalFire),
    // The pickup system asks; the server answers. A refusal is simply silence.
    events.on("request-pickup", (e) => {
      if (e.detail && e.detail.id) send({ type: "takePickup", id: e.detail.id });
    }),
    // Same contract as the pickups: the flag system asks when you are standing on a
    // flag, the server decides what that means (take / return / capture) and answers
    // with a `flag` message. A refusal is silence.
    events.on("request-flag-touch", (e) => {
      if (e.detail && e.detail.team) send({ type: "touchFlag", team: e.detail.team });
    }),
    events.on("local-hit", onLocalHit),
    events.on("change-name", onNameChange),
    events.on("local-kill", onLocalKill),
  ];

  createStatusIndicator();
  connect();
  startPoseLoop();

  // Best effort: tell the server we are going away so it doesn't wait for a timeout
  window.addEventListener("beforeunload", onBeforeUnload);
  function onBeforeUnload() {
    closedByUs = true;
    if (ws) {
      try {
        ws.close(1000, "page unload");
      } catch {
        /* nothing useful to do here */
      }
    }
  }

  // ---- connection status indicator ----
  function createStatusIndicator() {
    if (statusEl) return;
    statusEl = document.createElement("div");
    statusEl.id = "net-status";
    statusEl.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 6px 12px;
      background: rgba(0, 0, 0, 0.75);
      border: 1px solid #ffcc00;
      border-radius: 4px;
      color: #ffcc00;
      font-family: 'Courier New', monospace;
      font-size: 12px;
      letter-spacing: 1px;
      z-index: 9000;
      pointer-events: auto;
      cursor: pointer;
      transition: opacity 0.4s ease-out;
      opacity: 0;
    `;
    statusEl.title = "Click to reconnect now";
    statusEl.addEventListener("click", () => {
      if (ws && ws.readyState <= 1) return; // already connecting or connected
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempts = 0;
      scheduleReconnect(0);
    });
    document.body.appendChild(statusEl);
    setStatus("connecting", "CONNECTING…");
  }

  function setStatus(state, text) {
    if (!statusEl) return;
    statusEl.dataset.state = state;
    statusEl.textContent = text;
    const color = state === "online" ? "#66ff88" : state === "offline" ? "#ff5555" : "#ffcc00";
    statusEl.style.color = color;
    statusEl.style.borderColor = color;
    // Fade the indicator out once we're healthy; keep it visible while degraded
    statusEl.style.opacity = state === "online" ? "0" : "1";
    statusEl.style.pointerEvents = state === "online" ? "none" : "auto";
  }

  // ---- websocket wiring ----
  function connect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    closedByUs = false;
    console.log("[network] Attempting to connect to:", WS_URL);
    setStatus(reconnectAttempts ? "reconnecting" : "connecting", reconnectAttempts ? `RECONNECTING… (${reconnectAttempts})` : "CONNECTING…");

    let sock;
    try {
      sock = new WebSocket(WS_URL);
      ws = sock;
    } catch (err) {
      console.error("[network] WebSocket construction failed:", err);
      scheduleReconnect();
      return;
    }

    // A socket we have already replaced must not be able to speak for the session: an
    // old socket's late onclose would otherwise tear down the remotes and schedule a
    // reconnect on top of a connection that is already healthy.
    const stale = () => ws !== sock;

    sock.onopen = () => {
      if (stale()) return;
      console.log("[network] WebSocket connected successfully!");
      reconnectAttempts = 0;
      setStatus("online", "ONLINE");

      // Tell server my name. The session token lets the server hand back the score
      // IT counted for us before the drop — the client no longer declares a score.
      send({ type: "setName", name: getPersistentName(), session: getSessionToken() });

      // `spawn` is NOT sent here any more. The server assigns a team spawn point and
      // hands it back in `hello`; sending from there lets us stand on that point first
      // so the pose loop's first sample starts where the server thinks we are.
    };
    sock.onmessage = (e) => {
      if (stale()) return;
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (m.type) {
        case "hello": {
          myId = m.yourId;
          // The rig carries our id: the flag system reads game.rig.userData.playerId to
          // answer "is this flag mine" before `player-join` has told it who we are
          // (ctf-flag.js localId()). It was #rig's dataset.playerId.
          //
          // The local BODY no longer carries anything: `.avatar` + dataset.playerId on
          // #soldier were how the old hitscan found bodies to test, and traceShot reads
          // the remote-avatars registry instead — it never tested our own body anyway.
          if (game.rig) game.rig.userData.playerId = myId;

          // The server picked our side before it picked our spawn; everything below
          // (HUD colours, "is this flag mine") reads from this.
          setLocalTeam(m.team || null);

          // Stand on the assigned team spawn BEFORE announcing the spawn, so the
          // first pose the server sees is within a step of where it put us.
          if (m.spawn) applyLocalSpawn(m.spawn);
          if (!m.spectator) sendSpawn();

          // Emit local player join event for highscore
          events.emit("player-join", {
            id: myId,
            name: getPersistentName(), // Use persistent name
            kills: getPersistentScore(),
            team: myTeam,
            isLocal: true,
          });

          (m.players || []).forEach((p) => {
            if (p.weapon) remoteWeapons.set(p.id, p.weapon);
            if (p.id !== myId) spawnRemote(p);
          });

          // The server owns the pickup set. This fires on reconnect too, which is
          // why the system replaces its items wholesale rather than merging: after
          // a drop the ids are the same but availability may not be.
          events.emit("pickups-init", { pickups: m.pickups || [] });

          // Anything already in the air. Joining mid-match should show the rocket that
          // is about to land next to you, not just its explosion. Clear first: on a
          // RECONNECT the old drawings are still on screen and their ids may be reused.
          pj()?.clear();
          (m.projectiles || []).forEach((pr) => pj()?.spawn(pr));

          // Same wholesale-replace contract for the match: on a reconnect this is
          // the one path that rebuilds both flags and the score from scratch.
          if (m.ctf) events.emit("ctf-init", { ...m.ctf, myTeam });
          break;
        }
        case "join":
          if (m.player?.weapon) remoteWeapons.set(m.player.id, m.player.weapon);
          if (m.player?.id !== myId) spawnRemote(m.player);
          // Emit player join event for highscore
          events.emit("player-join", {
            id: m.player.id,
            name: m.player.name,
            team: m.player.team || null,
            isLocal: false,
          });
          break;
        case "leave":
          remoteWeapons.delete(m.id);
          removeRemote(m.id);
          // Emit player leave event for highscore
          events.emit("player-leave", { id: m.id });
          break;
        case "name": {
          const a = avatars() && avatars().get(m.id);
          if (a) a.setName(m.name);

          // Emit name change event for highscore
          events.emit("name-change", {
            playerId: m.id,
            newName: m.name,
          });
          break;
        }
        case "spawn": {
          const p = m.player;
          if (!p) break;
          if (p.id === myId) {
            // The server no longer honours the position we asked for — it puts us on a
            // team spawn behind our own tower — so our own broadcast is the one place
            // that tells us where we actually are. Ignoring it (as this used to) left
            // the rig wherever the offline placement dropped it.
            // But a server that DOES honour it just hands our own request back; that is
            // not a spawn assignment, and must not stand down the navmesh placement.
            applyLocalSpawn(p, { authoritative: !isEchoOfRequestedSpawn(p) });
          } else {
            const a = (avatars() && avatars().get(p.id)) || spawnRemote(p);
            if (a) a.setPose(p);
          }
          break;
        }
        case "pose": {
          const a = avatars() && avatars().get(m.id);
          if (a) {
            a.setPose(m);
          } else {
            console.warn(`[network] Received pose for unknown player ${m.id}`);
          }
          break;
        }
        case "fire": {
          if (m.id !== myId) {
            spawnBulletVisual(m.origin, m.dir, m.id);
            emitRemoteFire(m.id);
          }
          break;
        }

        // ---- the three weapons that fly ----
        //
        // The server owns these completely: it decides where they go and what they hit,
        // and sends three small messages per shot instead of a position twenty times a
        // second. Everything here is drawing, including our OWN rocket — unlike a bullet,
        // which the local client draws for itself, a projectile is only ever what the
        // server says it is, so there is no `m.id !== myId` guard to write.
        case "projectile": {
          pj()?.spawn(m);
          // A rocket raises the arms exactly as a bullet does. There is no `fire` message
          // for a weapon that flies — the server owns the whole shot and announces the
          // projectile instead — so this is the only place the animation can come from.
          // The shooter is `owner` here, not `id`: `id` is the projectile's own.
          if (m.owner != null && m.owner !== myId) emitRemoteFire(m.owner);
          break;
        }
        case "projectile-bounce": {
          pj()?.bounce(m);
          break;
        }
        case "projectile-gone": {
          pj()?.remove(m.id, m);
          break;
        }
        case "hit": {
          // Local player or remote body — the same Health object either way now; see
          // healthOf() above.
          const health = healthOf(m.victimId);

          if (health) {
            const oldHp = health.hp;
            health.setHp(m.hp); // was targetEntity.emit("sethp", …)

            // Check if this was a kill (hp went to 0 or below)
            if (oldHp > 0 && m.hp <= 0) {
              // This was a kill! Find the killer
              const killerId = m.by;
              if (killerId === myId) {
                // Local player got a kill - use victim name from server
                const victimName = m.victimName || getVictimName(m.victimId);
                events.emit("local-kill", { victimId: m.victimId, victimName });
              }
            }
          }
          break;
        }

        // Server-authoritative HEALING, from a health pickup. Deliberately not folded
        // into "hit": health.js reads any decrease as damage and flashes the screen for
        // it, so a heal arriving on the damage channel would be shown as being shot.
        case "health": {
          const health = healthOf(m.id);
          if (health) health.setHp(m.hp);
          break;
        }

        case "respawn": {
          const p = m.player;
          if (p) {
            if (p.id === myId) {
              // Local player — reset HP and move rig to spawn position. Same job as
              // the `spawn` handler, and the respawn payload carries `ry` too, so it
              // goes through applyLocalSpawn rather than writing the position alone
              // and leaving us facing whatever way we happened to die.
              applyLocalSpawn(p);
            }

            const health = healthOf(p.id);
            if (health) health.setHp(p.hp); // reset to full

            // Set pose on the rig for remote players
            if (p.id !== myId) {
              const a = avatars() && avatars().get(p.id);
              if (a) a.setPose(p);
            }
          }
          break;
        }

        case "pickup-taken": {
          // Hides the item, nothing more. This used to also emit local-loadout {dual: true}
          // whenever WE were the taker — written when the dual Enforcer was the only pickup
          // on the map. Once health, armour and weapons joined it, walking over a MedBox
          // while holding a Rocket Launcher put a second, mirrored launcher in the other
          // hand. What you hold is the server's to say, and it says it in `loadout` below.
          events.emit("pickup-taken", { id: m.id, by: m.by, respawnInMs: m.respawnInMs });
          break;
        }

        case "pickup-respawn": {
          events.emit("pickup-respawn", { id: m.id });
          break;
        }

        case "loadout": {
          // Broadcast for every player, so remote avatars (and the AR spectator
          // table) can show who is dual-wielding.
          if (m.weapon) remoteWeapons.set(m.id, m.weapon);
          events.emit("player-loadout", { id: m.id, dual: !!m.dual, weapon: m.weapon });
          if (m.id === myId) {
            events.emit("local-loadout", { dual: !!m.dual, weapon: m.weapon });
            // UT99's own WeaponPickup blip, and only for the player who picked it up —
            // hearing everyone else's across the map would be noise, not information.
            pj()?.playPickupSound();
          }
          break;
        }

        // ---- CTF ----
        // The server owns every one of these; the client only relays them onto the
        // bus under the names the flag system and the HUD listen for.
        case "team": {
          // Sent when the session stash moves a player to the side they had before
          // the drop, which can land a moment after `hello`. Both listeners must
          // tolerate hearing about their own team twice.
          //
          // A remote player's own body no longer needs telling separately: the
          // `player-team` event below is what the avatar registry routes to
          // avatar.setTeam(), where this used to write data-team on their rig for the
          // component to read back off the DOM.
          if (m.id === myId) setLocalTeam(m.team || null);
          events.emit("player-team", { id: m.id, team: m.team || null });
          break;
        }

        case "flag": {
          events.emit("flag-update", {
            team: m.team,
            state: m.state,
            x: m.x,
            y: m.y,
            z: m.z,
            carrier: m.carrier ?? null,
            returnInMs: m.returnInMs || 0,
            event: m.event,
            by: m.by ?? null,
            byName: m.byName ?? null,
            byTeam: m.byTeam ?? null,
            isMine: m.carrier != null && m.carrier === myId,
            myTeam,
          });
          break;
        }

        case "ctf-score": {
          events.emit("ctf-score", {
            scores: m.scores || { red: 0, blue: 0 },
            by: m.by ?? null,
            team: m.team,
            myTeam,
          });
          break;
        }

        case "match-end": {
          events.emit("match-end", {
            winner: m.winner,
            scores: m.scores || { red: 0, blue: 0 },
            resetInMs: m.resetInMs || 0,
            myTeam,
          });
          break;
        }

        // The announcer. The server has already decided this is worth saying and to
        // whom — a multi-kill comes to the killer alone, first blood to everyone — so
        // there is no audience test to make here.
        case "announce": {
          announce(m.sound);
          break;
        }

        case "match-reset": {
          // The server drops everything in the air on a reset; drop the drawings of it
          // too, or a rocket nobody can be hit by keeps flying across the new match.
          pj()?.clear();
          // One reset path: ctf-init rebuilds the flags and the score exactly as it
          // does on connect, then match-reset tells the HUD to drop the end card.
          if (m.ctf) events.emit("ctf-init", { ...m.ctf, myTeam });
          events.emit("match-reset", { ...(m.ctf || {}), myTeam });
          break;
        }

        case "death": {
          // (optional: FX when someone dies)
          break;
        }
        case "player-kill": {
          // Emit kill event for highscore
          events.emit("player-kill", {
            killerId: m.killerId,
            victimId: m.victimId,
          });
          break;
        }
        case "highscore-update": {
          // The server sends one payload to everyone, so tag our own row here — the
          // scoreboard rebuilds from this list and would otherwise lose `isLocal`.
          const players = (m.players || []).map((p) => ({ ...p, isLocal: p.id === myId }));
          const mine = players.find((p) => p.isLocal);
          // Server-counted kills are the truth; mirror them so the UI survives a reload
          if (mine) setPersistentScore(mine.kills || 0);
          events.emit("highscore-update", { players });
          break;
        }
      }
    };
    sock.onclose = (event) => {
      console.log("[network] WebSocket closed:", event.code, event.reason);
      if (stale()) return;
      clearRemotes();
      myId = null;
      if (game.rig) delete game.rig.userData.playerId;
      // The next connection assigns a team from scratch; holding the old one would
      // colour the HUD for a side we may not be on any more. It has to go through
      // setLocalTeam rather than just clearing the variable: the flag system drops
      // both flags on `local-team` with a null team, and the document tint has to
      // come off with it.
      setLocalTeam(null);
      if (!closedByUs) scheduleReconnect();
    };
    sock.onerror = (error) => {
      console.error("[network] WebSocket error:", error);
      // onerror is always followed by onclose; let onclose own the reconnect.
    };
  }

  // Exponential backoff with jitter, capped. Retries forever — the indicator tells
  // the player what is happening and can be clicked to retry immediately.
  function scheduleReconnect(forcedDelay) {
    if (reconnectTimer) return;
    reconnectAttempts++;

    let delay = forcedDelay;
    if (delay === undefined) {
      const backoff = Math.min(RECONNECT_MAX, RECONNECT_BASE * Math.pow(2, reconnectAttempts - 1));
      const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER;
      delay = Math.round(backoff * jitter);
    }

    const state = reconnectAttempts > 6 ? "offline" : "reconnecting";
    setStatus(state, `RECONNECTING… (${reconnectAttempts})`);
    console.log(`[network] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // ---- pose loop ----
  // The handle keeps the interval id: a 20 Hz timer that outlives the page it was
  // sampling would go on reading a disposed rig for ever. dispose() clears it.
  function startPoseLoop() {
    let lastPosition = { x: 0, y: 0, z: 0 };
    let lastRotation = 0;
    let lastAnimKey = "1,0,0"; // idle by default
    let lastSampleTime = performance.now();
    const threshold = 0.005; // Lower threshold for smoother updates

    poseTimer = setInterval(() => {
      const rig = game.rig;
      const player = game.player;
      if (!myId || !rig || !player) return;

      // Get current position and rotation. The rig itself never leaves the
      // navmesh — a jump raises the rig's CHILDREN by `offset` — so sampling
      // rig.position.y alone sends a pose that never jumps, and remote players
      // glide along the ground while the local one is in the air. Add the hop
      // back in here; it is well under the buffer's 20 m teleport threshold, so
      // remotes interpolate the arc instead of snapping.
      // ... and the drawn-floor correction applied beside it, or remotes would draw
      // this player at the navmesh height while its own eye stands on the floor.
      // Both are the one number visualOffset() reports (player/controller.js).
      const hop = player.visualOffset();
      const currentPosition = {
        x: rig.position.x,
        y: rig.position.y + hop,
        z: rig.position.z,
      };
      // The rig's own yaw IS the heading now. The old sum `rig.rotation.y +
      // cam.rotation.y` existed because look-controls put the mouse yaw on the camera
      // child and the rig only turned on Q/E and spawns; the ported controller puts yaw
      // on the rig and pitch on the head, so there is no second term to add.
      const currentRotation = rig.rotation.y;

      // Calculate velocity for animation from the real elapsed time, not a constant
      const now = performance.now();
      const deltaTime = Math.max(0.001, (now - lastSampleTime) / 1000);
      lastSampleTime = now;
      const vx = (currentPosition.x - lastPosition.x) / deltaTime;
      const vz = (currentPosition.z - lastPosition.z) / deltaTime;
      const speed = Math.sqrt(vx * vx + vz * vz);

      // Check if position or rotation has changed significantly
      const positionChanged =
        Math.abs(currentPosition.x - lastPosition.x) > threshold ||
        Math.abs(currentPosition.y - lastPosition.y) > threshold ||
        Math.abs(currentPosition.z - lastPosition.z) > threshold;

      const rotationChanged = Math.abs(currentRotation - lastRotation) > threshold;

      // Get current animation state from the local body's blend (systems/character.js,
      // built on game.player.soldier by core/main.js once the model has loaded).
      const character = player.character;
      const animationState = character
        ? {
            idle: character.target.Idle || 0,
            walk: character.target.Walk || 0,
            run: character.target.Run || 0,
          }
        : { idle: 1, walk: 0, run: 0 };

      // Check if animation state changed (so idle gets sent when player stops)
      const animKey = `${animationState.idle},${animationState.walk},${animationState.run}`;
      const animChanged = animKey !== lastAnimKey;

      // Only send when something changed
      if (!positionChanged && !rotationChanged && !animChanged) return;
      lastAnimKey = animKey;

      // Quantized on the wire — 1cm of position and ~0.06° of yaw is far below what
      // anyone can see, and it roughly halves the JSON payload.
      send({
        type: "pose",
        x: q2(currentPosition.x),
        y: q2(currentPosition.y),
        z: q2(currentPosition.z),
        ry: q3(currentRotation),
        speed: q2(speed),
        animation: animationState,
      });

      // Update last known values
      lastPosition = { ...currentPosition };
      lastRotation = currentRotation;
    }, 50); // Higher frequency for smoother updates
  }

  // ---- CTF helpers ----
  //
  // The team is a server fact with two consumers left: the document element (the
  // `html[data-team="red"|"blue"]` rules in styles.css have always been there with
  // nothing to switch them), and the event the HUD and the flag system listen on.
  //
  // The third — `#rig`'s data-team, which remote-avatar and character tinted the LOCAL
  // body from — is gone with the DOM. The local body is never tinted (nothing can see
  // it), and a remote body gets its side from its own publicPlayer payload and the
  // `player-team` event.
  function setLocalTeam(team) {
    myTeam = team || null;
    try {
      if (myTeam) document.documentElement.dataset.team = myTeam;
      else delete document.documentElement.dataset.team;
    } catch {
      /* dataset is always there in a browser; never worth throwing over a colour */
    }
    events.emit("local-team", { team: myTeam });
  }

  // The position our last `sendSpawn()` asked for, quantised exactly as it went out.
  // A server that honours the request (the "older server" case below) echoes it
  // straight back to us, and that echo is NOT a server-assigned spawn: treating it
  // as one permanently suppresses the offline navmesh placement (player/spawn.js) and
  // strands the rig wherever it happened to be — at the origin, in mid-air, on a
  // first join where `hello` carried no spawn.
  let requestedSpawn = null;

  // Tolerance is one unit of the 2-decimal quantisation we send, so a re-quantised
  // round trip still reads as an echo while a real team spawn (tens of metres away)
  // never does.
  const SPAWN_ECHO_EPS = 0.02;

  function isEchoOfRequestedSpawn(p) {
    if (!requestedSpawn) return false;
    const y = p.y === undefined || p.y === null ? 0 : p.y;
    return (
      Math.abs(p.x - requestedSpawn.x) <= SPAWN_ECHO_EPS &&
      Math.abs(y - requestedSpawn.y) <= SPAWN_ECHO_EPS &&
      Math.abs(p.z - requestedSpawn.z) <= SPAWN_ECHO_EPS
    );
  }

  // Both the assigned spawn in `hello` and our own `spawn` broadcast carry {x,y,z,ry};
  // moving the rig is the same job either way. `authoritative` says whether the point
  // was chosen by the server (and so may stand down the offline navmesh placement) or
  // is merely our own request coming back to us.
  function applyLocalSpawn(p, { authoritative = true } = {}) {
    const player = game.player;
    if (!player || !p || p.x === undefined || p.z === undefined) return;
    // `p.y || 0` read a legitimate ground-level spawn as a missing one. Ground IS 0
    // on plenty of this map, so test for the value being absent, not falsy.
    const y = p.y === undefined || p.y === null ? 0 : p.y;
    // spawnAt(), not a position write. It is THE ONLY supported way to move the rig from
    // outside: it resets the navmesh clamp's cached polygon (which would otherwise drag
    // the player back across the map on the next step), the movement velocity, the jump
    // arc and the speed tracker. See the "EVERY TELEPORT" block in player/controller.js.
    player.spawnAt(p.x, y, p.z, typeof p.ry === "number" ? p.ry : undefined);
    // From here the offline navmesh placement must not move us again: the server
    // owns the spawn point, and its raycast may still be in flight. Only a genuinely
    // server-chosen point earns that — see `requestedSpawn` above.
    if (authoritative) markServerSpawnApplied();
  }

  // Sent from the `hello` handler once the rig is standing on the assigned point.
  // The server ignores the position now — it seats us on a team spawn — but sending
  // where we believe we are keeps the message honest and works against an older server.
  function sendSpawn() {
    const rig = game.rig;
    if (!rig) {
      requestedSpawn = null;
      send({ type: "spawn" });
      return;
    }
    const pos = rig.position;
    const position = { x: q2(pos.x), y: q2(pos.y), z: q2(pos.z) };
    requestedSpawn = position;
    send({
      type: "spawn",
      position,
      ry: q3(rig.rotation.y),
    });
  }

  // ---- bus event handlers ----
  function onLocalFire(ev) {
    const { origin, dir } = ev.detail || {};
    if (!origin || !dir) return;
    send({
      type: "fire",
      origin: { x: q2(origin.x), y: q2(origin.y), z: q2(origin.z) },
      dir: { x: q3(dir.x), y: q3(dir.y), z: q3(dir.z) },
    });
    // Nothing is drawn here. The shooter's own client already drew this shot in
    // first-person-weapon.fireBullet(); every OTHER client draws it in spawnBulletVisual
    // when the server echoes this message back to them.
  }

  function onLocalHit(ev) {
    const { victimId, dmg, point } = ev.detail || {};
    if (!victimId) return;
    // WHERE the trace stopped, so the server can tell a headshot from a body hit. It is
    // a claim, not a fact: the server accepts it only if it lies on the ray of the shot
    // paying for it and inside the victim. A point that fails either test is treated as
    // a body hit, so sending a flattering one costs the sender the bonus.
    const at =
      point && Number.isFinite(point.x)
        ? { x: +point.x.toFixed(2), y: +point.y.toFixed(2), z: +point.z.toFixed(2) }
        : undefined;
    // The hitscan weapon resolves the trace and emits 'local-hit' BEFORE it emits the
    // 'local-fire' for the same shot. The server only credits a hit against a shot it
    // has already seen, so defer by one microtask: anything emitted synchronously
    // after us — the matching 'local-fire' — goes out on the wire first.
    queueMicrotask(() => send({ type: "clientHit", victimId, dmg, point: at }));
  }

  function onNameChange(ev) {
    const { name } = ev.detail || {};
    if (!name) return;
    send({ type: "setName", name, session: getSessionToken() });
  }

  function onLocalKill(ev) {
    const { victimId } = ev.detail || {};
    if (!victimId) return;

    // Optimistic local bump for instant UI feedback. The authoritative count arrives
    // in the next highscore-update and overwrites this — we no longer send a score.
    const newScore = addPersistentKill();
    console.log(`[network] Local kill! Score (pending server confirm): ${newScore}`);
  }

  function getVictimName(victimId) {
    // Check if victim is a remote player
    const remotePlayer = avatars() && avatars().get(victimId);
    if (remotePlayer) {
      return remotePlayer.name || "Unknown Player";
    }

    // Check if victim is the local player (shouldn't happen but just in case)
    if (victimId === myId) {
      return getPersistentName() || "You";
    }

    // If not found in remotes, return generic name
    return "Unknown Player";
  }

  // ---- remote avatars ----
  //
  // What this function used to be: forty lines building an <a-entity> rig, an <a-entity>
  // soldier inside it, and eight data-* attributes for the component to read back off the
  // DOM — including the four derived from the character index (model URL, skin list,
  // model yaw, hand offset). The registry takes the server's publicPlayer payload whole
  // and resolves those four itself from src/shared/characters.js, which is where the
  // lookup belonged; `p.character` is the wire fact and everything else follows from it.
  function spawnRemote(p) {
    const reg = avatars();
    if (!reg || !p) return null;
    const avatar = reg.spawn(p);
    if (!avatar) return null;
    // The first pose, straight away. The old code had to wait for `componentinitialized`
    // and then post a second setPose on the next animation frame, because the entity's
    // component did not exist yet when this returned; the instance is fully built here.
    avatar.setPose(p);
    if (p.team) events.emit("player-team", { id: p.id, team: p.team });
    return avatar;
  }

  function removeRemote(id) {
    const reg = avatars();
    if (reg) reg.remove(id);
  }

  // Tear down every remote avatar — on reconnect the server hands out fresh ids, so
  // anything left over would be a permanent ghost standing in the map. The registry's
  // own clear() does not emit, so the ids are announced first: the scoreboard and the
  // flag system both empty themselves off `player-leave`.
  function clearRemotes() {
    const reg = avatars();
    if (!reg) return;
    for (const body of reg.bodies()) events.emit("player-leave", { id: body.id });
    reg.clear();
  }

  // ---- somebody else's trigger ----
  //
  // ONE event for both ways a shot reaches this client: the `fire` message a hitscan
  // weapon sends, and the `projectile` message the server sends for the three that fly.
  // The avatar registry listens and routes by player id — it is what knows which body
  // belongs to which player, and this is the only thing network.js has to tell it. The
  // weapon rides along so the avatar can play the held mesh's own fire sequence without
  // going back to the map.
  function emitRemoteFire(id) {
    if (id == null) return;
    events.emit("remote-fire", { id, weapon: remoteWeapons.get(id) || DEFAULT_WEAPON });
  }

  // ---- somebody else's hitscan shot ----
  //
  // This used to spawn a `bullet` entity that FLEW from the muzzle at 70 m/s and drew a
  // tracer when it arrived. UT99 has no such thing: a hitscan shot lands the frame it is
  // fired, and a visible ball crossing the map was both wrong and a lie about where the
  // shot already was. So the same trace the shooter ran is run again HERE, on this client,
  // and the shot is drawn instantly through exactly the entry point the local player's own
  // shot uses — the shooter's weapon decides whether that is a Shock beam and ring or a
  // tracer and a UT_WallHit.
  //
  // This is drawing only. The server owns the damage; nothing here reports a hit, which is
  // why the old `reportHits` argument is gone — it was never true on this path.
  const _shotOrigin = new THREE.Vector3();
  const _shotDir = new THREE.Vector3();

  function spawnBulletVisual(origin, dir, ownerId) {
    if (!origin || !dir) return;
    const weaponId = remoteWeapons.get(ownerId) || DEFAULT_WEAPON;
    const spec = weapon(weaponId);
    // Rockets, ripper blades and the Redeemer are server-simulated and arrive as
    // `projectile` messages that ut-projectiles.js draws. A `fire` for one of those would
    // otherwise paint a tracer and a spark on the wall the instant the tube emptied.
    if (spec.projectile) return;

    _shotOrigin.set(origin.x, origin.y, origin.z);
    _shotDir.set(dir.x, dir.y, dir.z);
    if (_shotDir.lengthSq() < 1e-8) return;
    _shotDir.normalize();

    // Exclude the shooter, or a shot fired from inside their own capsule stops at their
    // chest. One id is enough now: the old call also passed the rig ELEMENT, because the
    // A-Frame trace walked `.avatar` nodes and matched on identity; traceShot walks the
    // registry's bodies and matches on `body.id`.
    const result = traceShot(game, _shotOrigin, _shotDir, {
      maxDist: GAME_CONFIG.WEAPON.MAX_RANGE,
      excludeId: ownerId || null,
    });

    const effects = fx();
    if (effects) {
      effects.drawHitscanShot(weaponId, _shotOrigin, result);
      effects.ejectShell(weaponId, _shotOrigin, _shotDir);
      effects.playWeaponSoundAt(spec.sound, _shotOrigin);
    }
    // Background music starts on the first shot heard, wherever it came from. The deleted
    // bullet component used to emit this.
    events.emit("bullet-fired");
  }

  // ---- persistent name and score management ----
  //
  // The name lives in localStorage so you keep it across visits, but
  // localStorage is shared by every tab of this origin — so two tabs used to
  // join as the same person, which is exactly how this gets tested locally
  // (and made every figure in the AR view carry one name).
  //
  // A tab therefore CLAIMS the stored name. The first tab to ask gets it; any
  // later tab gets a fresh one of its own. Claims are held per-tab in
  // sessionStorage and recorded in localStorage with a timestamp, so a tab that
  // is closed or crashes releases its claim rather than burning the name
  // forever.
  const NAME_KEY = "facingworlds_player_name";
  const CLAIMS_KEY = "facingworlds_name_claims";
  const CLAIM_TTL = 60000; // ms; refreshed while the tab is alive
  const TAB_KEY = "facingworlds_tab_id";

  function tabId() {
    let id = sessionStorage.getItem(TAB_KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem(TAB_KEY, id);
    }
    return id;
  }

  function readClaims() {
    try {
      const raw = JSON.parse(localStorage.getItem(CLAIMS_KEY) || "{}");
      const now = Date.now();
      const live = {};
      // Drop claims from tabs that went away without releasing.
      for (const [name, c] of Object.entries(raw)) {
        if (c && now - c.t < CLAIM_TTL) live[name] = c;
      }
      return live;
    } catch (_) {
      return {};
    }
  }

  function writeClaims(claims) {
    try {
      localStorage.setItem(CLAIMS_KEY, JSON.stringify(claims));
    } catch (_) {
      /* private window — names just stop being sticky */
    }
  }

  function claimName(name) {
    const claims = readClaims();
    const held = claims[name];
    if (held && held.tab !== tabId()) return false;
    claims[name] = { tab: tabId(), t: Date.now() };
    writeClaims(claims);
    return true;
  }

  function getPersistentName() {
    // Already named in THIS tab — that decision stands.
    const mine = sessionStorage.getItem(NAME_KEY);
    if (mine && mine.trim().length > 0) {
      claimName(mine.trim());
      return mine.trim();
    }

    // Otherwise take the durable name if no other live tab holds it.
    const stored = localStorage.getItem(NAME_KEY);
    if (stored && stored.trim().length > 0 && claimName(stored.trim())) {
      sessionStorage.setItem(NAME_KEY, stored.trim());
      return stored.trim();
    }

    // Taken (or nothing stored) — this tab gets its own, avoiding names the
    // other live tabs are already using.
    const claims = readClaims();
    let newName = genName();
    for (let i = 0; i < 12 && claims[newName]; i += 1) newName = genName();
    claimName(newName);
    sessionStorage.setItem(NAME_KEY, newName);
    // Only the first tab seeds the durable name, so reopening later gives you
    // the name you actually played under rather than the last tab's.
    if (!localStorage.getItem(NAME_KEY)) localStorage.setItem(NAME_KEY, newName);
    return newName;
  }

  function setPersistentName(name) {
    if (name && name.trim().length > 0) {
      const clean = name.trim();
      sessionStorage.setItem(NAME_KEY, clean);
      localStorage.setItem(NAME_KEY, clean);
      claimName(clean);
      return true;
    }
    return false;
  }

  // Keep this tab's claim warm, and drop it on the way out so the name is
  // free for the next tab rather than held for CLAIM_TTL.
  const claimTimer = setInterval(() => {
    const mine = sessionStorage.getItem(NAME_KEY);
    if (mine) claimName(mine);
  }, CLAIM_TTL / 2);

  // Drop this tab's claim so the name is free for the next tab rather than held for
  // CLAIM_TTL. On the way out of the PAGE, and equally on the way out of the client.
  function releaseNameClaim() {
    const mine = sessionStorage.getItem(NAME_KEY);
    if (!mine) return;
    const claims = readClaims();
    if (claims[mine] && claims[mine].tab === tabId()) {
      delete claims[mine];
      writeClaims(claims);
    }
  }

  window.addEventListener("pagehide", onPageHide);
  function onPageHide() {
    dispose();
  }

  /**
   * Shut the client down: what the page unload used to do, callable.
   *
   * startNetwork() used to return undefined, which was fine while the only way out of a
   * session was closing the tab. It is not fine now that it is registered as a system:
   * game.dispose() walks the registry and every one of the four things below would have
   * outlived it — a 20 Hz interval sampling a rig nobody is drawing, a socket still
   * feeding poses into a torn-down avatar registry, a pending reconnect timer that would
   * open a NEW socket after the game was gone, and six bus subscriptions holding this
   * whole closure alive. Idempotent: `pagehide` and game.dispose() may both fire.
   */
  function dispose() {
    if (disposed) return;
    disposed = true;
    // Before the close, so onclose reads it and does not schedule a reconnect.
    closedByUs = true;
    clearInterval(claimTimer);
    if (poseTimer) clearInterval(poseTimer);
    poseTimer = null;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    for (const off of offBus) off();
    offBus.length = 0;
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("pagehide", onPageHide);
    const sock = ws;
    // Dropping the reference first is what makes every handler on that socket stale()
    // — including the onclose the close() below is about to fire.
    ws = null;
    if (sock) {
      try {
        sock.close(1000, "client disposed");
      } catch {
        /* nothing useful to do here */
      }
    }
    if (statusEl && statusEl.parentNode) statusEl.parentNode.removeChild(statusEl);
    statusEl = null;
    releaseNameClaim();
  }

  function getPersistentScore() {
    const stored = localStorage.getItem("facingworlds_player_score");
    return stored ? parseInt(stored, 10) || 0 : 0;
  }

  function setPersistentScore(score) {
    localStorage.setItem("facingworlds_player_score", score.toString());
  }

  function addPersistentKill() {
    const currentScore = getPersistentScore();
    const newScore = currentScore + 1;
    setPersistentScore(newScore);
    return newScore;
  }

  // Stable per-browser token. It only identifies us to the server so it can restore
  // the score IT counted for us after a drop; it carries no score of its own.
  function getSessionToken() {
    let token = localStorage.getItem("facingworlds_session");
    if (!token) {
      token =
        typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem("facingworlds_session", token);
    }
    return token;
  }

  // Expose management functions globally for UI
  window.setPlayerName = setPersistentName;
  window.getPlayerName = getPersistentName;
  window.getPlayerScore = getPersistentScore;
  window.setPlayerScore = setPersistentScore;

  // network.js (top-level helper)
  function genName() {
    const names = [
      "Archon",
      "Arkon",
      "Blake",
      "Brock",
      "Cilia",
      "Cryss",
      "Darhlia",
      "Drimacus",
      "Genghis",
      "Gorge",
      "Harlin",
      "Isis",
      "Kali",
      "Kira",
      "Komek",
      "Kragoth",
      "Kregore",
      "Loque",
      "Luthienne",
      "Malakai",
      "Malcom",
      "Matrix",
      "Nikita",
      "Othello",
      "Riker",
      "Rumiko",
      "Rylisa",
      "Sapphire",
      "Tamerlane",
      "Tensor",
      "Visse",
      "Xan",
    ];
    return names[Math.floor(Math.random() * names.length)];
  }

  // The client, as a system: no update(), one dispose(). core/main.js registers it
  // so game.dispose() reaches it in the same reverse-order sweep as everything else.
  return { dispose };
}

export default startNetwork;
