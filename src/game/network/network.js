// network.js (ES module) — robust init: waits for DOM, scene, and #soldier
import { waitForElement, waitForSceneLoaded as waitForScene, createEntity, addClass, setDataAttribute } from "../utils/dom-helpers.js";
import { createEuler } from "../utils/three-helpers.js";
import { getWebSocketUrl, log } from "../utils/environment.js";
import { handleError, wrapAsync } from "../utils/error-handler.js";
import { GAME_CONFIG } from "../config/game-config.js";

const BULLET_SPEED = GAME_CONFIG.BULLET.SPEED;

// ---- reconnect tuning ----
const RECONNECT_BASE = 500; // ms before the first retry
const RECONNECT_MAX = 15000; // ms ceiling on the backoff
const RECONNECT_JITTER = 0.3; // ±30% so a server restart doesn't stampede every client

export function startNetwork() {
  const WS_URL = getWebSocketUrl();
  let ws,
    myId = null;
  let scene = null;
  let me = null;
  const remotes = new Map();

  // reconnect state
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let closedByUs = false;
  let statusEl = null;

  // ---- tiny utils ----
  const waitFor = waitForElement;
  const q2 = (n) => Math.round(n * 100) / 100;
  const q3 = (n) => Math.round(n * 1000) / 1000;

  // ---- main init ----
  const run = async () => {
    scene = await waitFor("a-scene");
    await waitForScene(scene);
    me = await waitFor("#soldier"); // your local avatar entity
    const rig = await waitFor("#rig"); // your local rig entity

    // Wire scene events AFTER we have a scene
    scene.addEventListener("local-fire", onLocalFire);
    // The pickup system asks; the server answers. A refusal is simply silence.
    scene.addEventListener("request-pickup", (e) => {
      if (e.detail && e.detail.id) send({ type: "takePickup", id: e.detail.id });
    });
    scene.addEventListener("local-hit", onLocalHit);
    scene.addEventListener("change-name", onNameChange);
    scene.addEventListener("local-kill", onLocalKill);

    createStatusIndicator();

    // Connect WS AFTER we have me
    connect();
    // Start pose sender when me is ready
    startPoseLoop(rig);
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();

  // Best effort: tell the server we are going away so it doesn't wait for a timeout
  window.addEventListener("beforeunload", () => {
    closedByUs = true;
    if (ws) {
      try {
        ws.close(1000, "page unload");
      } catch {
        /* nothing useful to do here */
      }
    }
  });

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

      // Also request to spawn with current position
      const rig = document.querySelector("#rig");
      if (rig) {
        const pos = rig.object3D.position;
        send({
          type: "spawn",
          position: { x: q2(pos.x), y: q2(pos.y), z: q2(pos.z) },
          ry: q3(rig.object3D.rotation.y),
        });
      } else {
        send({ type: "spawn" });
      }
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
          if (me) {
            me.classList.add("avatar");
            me.dataset.playerId = myId;
          }

          // Emit local player join event for highscore
          scene.emit("player-join", {
            id: myId,
            name: getPersistentName(), // Use persistent name
            kills: getPersistentScore(),
            isLocal: true,
          });

          (m.players || []).forEach((p) => {
            if (p.id !== myId) spawnRemote(p);
          });

          // The server owns the pickup set. This fires on reconnect too, which is
          // why the system replaces its items wholesale rather than merging: after
          // a drop the ids are the same but availability may not be.
          scene.emit("pickups-init", { pickups: m.pickups || [] });
          break;
        }
        case "join":
          if (m.player?.id !== myId) spawnRemote(m.player);
          // Emit player join event for highscore
          scene.emit("player-join", {
            id: m.player.id,
            name: m.player.name,
            isLocal: false,
          });
          break;
        case "leave":
          removeRemote(m.id);
          // Emit player leave event for highscore
          scene.emit("player-leave", { id: m.id });
          break;
        case "name": {
          const e = remotes.get(m.id);
          if (e) e.setAttribute("data-name", m.name);

          // Emit name change event for highscore
          scene.emit("name-change", {
            playerId: m.id,
            newName: m.name,
          });
          break;
        }
        case "spawn": {
          const p = m.player;
          if (p && p.id !== myId) {
            let e = remotes.get(p.id) || spawnRemote(p);
            setPose(e, p);
          }
          break;
        }
        case "pose": {
          const e = remotes.get(m.id);
          if (e) {
            setPose(e, m);
          } else {
            console.warn(`[network] Received pose for unknown player ${m.id}`);
          }
          break;
        }
        case "fire": {
          if (m.id !== myId) spawnBulletVisual(m.origin, m.dir, m.id, false);
          break;
        }
        case "hit": {
          let targetEntity;
          if (m.victimId === myId) {
            // Local player - find the soldier entity inside the rig
            targetEntity = me;
          } else {
            // Remote player - find the soldier entity inside the remote rig
            const rig = remotes.get(m.victimId);
            targetEntity = rig ? rig.querySelector("[remote-avatar]") : null;
          }

          if (targetEntity && targetEntity.components.health) {
            const oldHp = targetEntity.components.health.hp;
            targetEntity.emit("sethp", { hp: m.hp }); // triggers health.js listener

            // Check if this was a kill (hp went to 0 or below)
            if (oldHp > 0 && m.hp <= 0) {
              // This was a kill! Find the killer
              const killerId = m.by;
              if (killerId === myId) {
                // Local player got a kill - use victim name from server
                const victimName = m.victimName || getVictimName(m.victimId);
                scene.emit("local-kill", { victimId: m.victimId, victimName });
              }
            }
          }
          break;
        }

        case "respawn": {
          const p = m.player;
          if (p) {
            let targetEntity;
            if (p.id === myId) {
              // Local player — reset HP and move rig to spawn position
              targetEntity = me;
              const rig = document.querySelector("#rig");
              if (rig && p.x !== undefined && p.z !== undefined) {
                rig.setAttribute("position", `${p.x} ${p.y || 0} ${p.z}`);
              }
            } else {
              // Remote player - find the soldier entity inside the remote rig
              const rig = remotes.get(p.id);
              targetEntity = rig ? rig.querySelector("[remote-avatar]") : null;
            }

            if (targetEntity && targetEntity.components.health) {
              targetEntity.emit("sethp", { hp: p.hp }); // reset to full
            }

            // Set pose on the rig for remote players
            if (p.id !== myId) {
              const rig = remotes.get(p.id);
              if (rig) setPose(rig, p);
            }
          }
          break;
        }

        case "pickup-taken": {
          scene.emit("pickup-taken", { id: m.id, by: m.by, respawnInMs: m.respawnInMs });
          if (m.by === myId) {
            // Only the server can grant this. The weapon component listens and
            // switches to two guns; it never decides on its own.
            scene.emit("local-loadout", { dual: true });
          }
          break;
        }

        case "pickup-respawn": {
          scene.emit("pickup-respawn", { id: m.id });
          break;
        }

        case "loadout": {
          // Broadcast for every player, so remote avatars (and the AR spectator
          // table) can show who is dual-wielding.
          scene.emit("player-loadout", { id: m.id, dual: !!m.dual });
          if (m.id === myId) scene.emit("local-loadout", { dual: !!m.dual });
          break;
        }

        case "death": {
          // (optional: FX when someone dies)
          break;
        }
        case "player-kill": {
          // Emit kill event for highscore
          scene.emit("player-kill", {
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
          scene.emit("highscore-update", { players });
          break;
        }
      }
    };
    sock.onclose = (event) => {
      console.log("[network] WebSocket closed:", event.code, event.reason);
      if (stale()) return;
      clearRemotes();
      myId = null;
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

  // ---- pose loop (runs only if #rig exists) ----
  function startPoseLoop(rig) {
    let lastPosition = { x: 0, y: 0, z: 0 };
    let lastRotation = 0;
    let lastAnimKey = "1,0,0"; // idle by default
    let lastSampleTime = performance.now();
    const threshold = 0.005; // Lower threshold for smoother updates

    setInterval(() => {
      if (!myId || !rig) return;
      const o = rig.object3D;

      // Get current position and rotation
      const currentPosition = {
        x: o.position.x,
        y: o.position.y,
        z: o.position.z,
      };
      const currentRotation = o.rotation.y;

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

      // Get current animation state from character component
      const soldier = rig.querySelector("#soldier");
      const characterComponent = soldier && soldier.components.character;
      const animationState = characterComponent
        ? {
            idle: characterComponent.target.Idle || 0,
            walk: characterComponent.target.Walk || 0,
            run: characterComponent.target.Run || 0,
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

  // ---- scene event handlers ----
  function onLocalFire(ev) {
    const { origin, dir } = ev.detail || {};
    if (!origin || !dir) return;
    send({
      type: "fire",
      origin: { x: q2(origin.x), y: q2(origin.y), z: q2(origin.z) },
      dir: { x: q3(dir.x), y: q3(dir.y), z: q3(dir.z) },
    });
    // Don't create local bullet here - it's already created in blaster component
    // This prevents duplicate bullets and lag
  }

  function onLocalHit(ev) {
    const { victimId, dmg } = ev.detail || {};
    if (!victimId) return;
    // The hitscan weapon resolves the trace and emits 'local-hit' BEFORE it emits the
    // 'local-fire' for the same shot. The server only credits a hit against a shot it
    // has already seen, so defer by one microtask: anything emitted synchronously
    // after us — the matching 'local-fire' — goes out on the wire first.
    queueMicrotask(() => send({ type: "clientHit", victimId, dmg }));
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
    const remotePlayer = remotes.get(victimId);
    if (remotePlayer) {
      return remotePlayer.getAttribute("data-name") || "Unknown Player";
    }

    // Check if victim is the local player (shouldn't happen but just in case)
    if (victimId === myId) {
      return getPersistentName() || "You";
    }

    // If not found in remotes, return generic name
    return "Unknown Player";
  }

  // ---- remote avatars ----
  function spawnRemote(p) {
    if (!scene || !p) return null;

    // Create rig structure similar to local player
    const rig = createEntity("a-entity", {
      id: `remote-rig-${p.id}`,
    });
    addClass(rig, "avatar");
    setDataAttribute(rig, "playerId", p.id);

    // Set initial position if provided
    if (p.x !== undefined && p.y !== undefined && p.z !== undefined) {
      rig.setAttribute("position", `${p.x} ${p.y} ${p.z}`);
    }

    // Create soldier entity inside rig
    const soldier = createEntity("a-entity", {
      "gltf-model": "#soldier-model",
      shadow: "cast:true; receive:true",
      "remote-avatar": "",
      health: "max:100; current:100",
    });

    rig.appendChild(soldier);
    scene.appendChild(rig);
    remotes.set(p.id, rig);

    // Wait until the component is initialized before setting pose
    const onInit = (ev) => {
      if (ev.detail.name === "remote-avatar") {
        soldier.removeEventListener("componentinitialized", onInit);
        setPose(rig, p);
      }
    };
    soldier.addEventListener("componentinitialized", onInit);

    requestAnimationFrame(() => setPose(rig, p));
    return rig;
  }

  function removeRemote(id) {
    const e = remotes.get(id);
    if (!e) return;
    e.parentNode && e.parentNode.removeChild(e);
    remotes.delete(id);
  }

  // Tear down every remote avatar — on reconnect the server hands out fresh ids, so
  // anything left over would be a permanent ghost standing in the map.
  function clearRemotes() {
    for (const [id, el] of remotes) {
      el.parentNode && el.parentNode.removeChild(el);
      if (scene) scene.emit("player-leave", { id });
    }
    remotes.clear();
  }

  function setPose(rig, p) {
    // Find the soldier entity inside the rig and set pose
    const soldier = rig.querySelector("[remote-avatar]");
    const c = soldier && soldier.components["remote-avatar"];
    if (c && p) {
      c.setNetPose(p);
    } else {
      console.warn(`[network] Could not find remote-avatar component for rig ${rig.id}`);
    }
  }

  // ---- visual bullets ----
  function spawnBulletVisual(origin, dir, ownerId, reportHits = false) {
    if (!scene || !origin || !dir) return;
    const vx = dir.x * BULLET_SPEED,
      vy = dir.y * BULLET_SPEED,
      vz = dir.z * BULLET_SPEED;

    const b = createEntity("a-entity", {
      position: `${origin.x} ${origin.y} ${origin.z}`,
      // Note: Visual geometry is created by the bullet component itself
      bullet: {
        vx,
        vy,
        vz,
        radius: 0.08,
        lifeSec: 2,
        ownerId: ownerId || "",
        reportHits,
      },
    });

    scene.appendChild(b);
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

  window.addEventListener("pagehide", () => {
    clearInterval(claimTimer);
    const mine = sessionStorage.getItem(NAME_KEY);
    if (!mine) return;
    const claims = readClaims();
    if (claims[mine] && claims[mine].tab === tabId()) {
      delete claims[mine];
      writeClaims(claims);
    }
  });

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
}

export default startNetwork;
