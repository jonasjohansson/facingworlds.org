// network.js (ES module) — robust init: waits for DOM, scene, and #soldier
import { waitForElement, waitForSceneLoaded, createEntity, addClass, setDataAttribute } from "../utils/dom-helpers.js";
import { createEuler } from "../utils/three-helpers.js";
import { getWebSocketUrl, log } from "../utils/environment.js";
import { handleError, wrapAsync } from "../utils/error-handler.js";
import { GAME_CONFIG } from "../config/game-config.js";

export function startNetwork() {
  const WS_URL = getWebSocketUrl();
  let ws,
    myId = null;
  let scene = null;
  let me = null;
  const remotes = new Map();

  // ---- tiny utils ----
  const waitFor = waitForElement;
  const waitForScene = (scene) => {
    return new Promise((res) => {
      if (scene.hasLoaded) return res();
      scene.addEventListener("loaded", () => res(), { once: true });
    });
  };

  // ---- main init ----
  const run = async () => {
    scene = await waitFor("a-scene");
    await waitForScene(scene);
    me = await waitFor("#soldier"); // your local avatar entity
    const rig = await waitFor("#rig"); // your local rig entity

    // Wire scene events AFTER we have a scene
    scene.addEventListener("local-fire", onLocalFire);
    scene.addEventListener("local-hit", onLocalHit);
    scene.addEventListener("change-name", onNameChange);
    scene.addEventListener("local-kill", onLocalKill);

    // Connect WS AFTER we have me
    connect();
    // Start pose sender when me is ready
    startPoseLoop(rig);
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();

  // ---- websocket wiring ----
  function connect() {
    console.log("[network] Attempting to connect to:", WS_URL);
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      console.log("[network] WebSocket connected successfully!");

      // Get persistent name and score from localStorage
      const name = getPersistentName();
      const score = getPersistentScore();

      // Tell server my name and score
      send({ type: "setName", name });
      send({ type: "setScore", score });

      // Also request to spawn with current position
      const rig = document.querySelector("#rig");
      if (rig) {
        const pos = rig.object3D.position;
        send({
          type: "spawn",
          position: { x: pos.x, y: pos.y, z: pos.z },
          ry: rig.object3D.rotation.y,
        });
      } else {
        send({ type: "spawn" });
      }
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
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
            kills: getPersistentScore(), // Use persistent score
            isLocal: true,
          });

          (m.players || []).forEach((p) => {
            if (p.id !== myId) spawnRemote(p);
          });
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
            // Log pose data occasionally to debug animation transmission
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
                // Local player got a kill
                scene.emit("local-kill", { victimId: m.victimId });
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
              // Local player
              targetEntity = me;
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
          // Emit highscore update event
          scene.emit("highscore-update", { players: m.players });
          break;
        }
      }
    };
    ws.onclose = (event) => {
      console.log("[network] WebSocket closed:", event.code, event.reason);
      setTimeout(connect, 1000);
    };
    ws.onerror = (error) => {
      console.error("[network] WebSocket error:", error);
    };
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // ---- pose loop (runs only if #rig exists) ----
  function startPoseLoop(rig) {
    let lastPosition = { x: 0, y: 0, z: 0 };
    let lastRotation = 0;
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

      // Calculate velocity for animation
      const deltaTime = 0.1; // 100ms interval
      const velocity = {
        x: (currentPosition.x - lastPosition.x) / deltaTime,
        y: (currentPosition.y - lastPosition.y) / deltaTime,
        z: (currentPosition.z - lastPosition.z) / deltaTime,
      };
      const speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);

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

      // Always send pose with animation state
      if (Math.random() < 0.01) {
        // Log 1% of the time to reduce spam
        console.log("[network] Animation state:", animationState);
        console.log("[network] Character component:", characterComponent);
        console.log("[network] Target values:", characterComponent ? characterComponent.target : "No character component");
      }

      send({
        type: "pose",
        x: currentPosition.x,
        y: currentPosition.y,
        z: currentPosition.z,
        ry: currentRotation,
        vx: velocity.x,
        vy: velocity.y,
        vz: velocity.z,
        speed: speed,
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
    send({ type: "fire", origin, dir });
    // Don't create local bullet here - it's already created in blaster component
    // This prevents duplicate bullets and lag
  }

  function onLocalHit(ev) {
    const { victimId, dmg } = ev.detail || {};
    if (!victimId) return;
    send({ type: "clientHit", victimId, dmg });
  }

  function onNameChange(ev) {
    const { name } = ev.detail || {};
    if (!name) return;
    send({ type: "setName", name });
  }

  function onLocalKill(ev) {
    const { victimId } = ev.detail || {};
    if (!victimId) return;

    // Update persistent score
    const newScore = addPersistentKill();
    console.log(`[network] Local kill! New persistent score: ${newScore}`);

    // Send updated score to server
    send({ type: "setScore", score: newScore });
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
      "gltf-model": "https://threejs.org/examples/models/gltf/Soldier.glb",
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
  function setPose(rig, p) {
    // Find the soldier entity inside the rig and set pose
    const soldier = rig.querySelector("[remote-avatar]");
    const c = soldier && soldier.components["remote-avatar"];
    if (c && p) {
      // console.log(`[network] Setting pose for rig ${rig.id}:`, p); // Reduced logging
      c.setNetPose(p);
    } else {
      console.warn(`[network] Could not find remote-avatar component for rig ${rig.id}`);
    }
  }

  // ---- visual bullets ----
  function spawnBulletVisual(origin, dir, ownerId, reportHits = false) {
    if (!scene) return;
    const speed = 18;
    const vx = dir.x * speed,
      vy = dir.y * speed,
      vz = dir.z * speed;

    console.log(`[spawnBulletVisual] Creating bullet at origin:`, origin);
    console.log(`[spawnBulletVisual] Direction:`, dir);
    console.log(`[spawnBulletVisual] Velocity:`, { vx, vy, vz });

    const b = createEntity("a-entity", {
      position: `${origin.x} ${origin.y} ${origin.z}`,
      geometry: "primitive: sphere; radius: 0.08",
      material: "color: #ffcc00; opacity: 0.95; metalness:0.2; roughness:0.4",
      shadow: "cast:true",
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

    // Add some debugging attributes
    b.setAttribute("id", `bullet-${Date.now()}`);
    b.setAttribute("visible", "true");

    scene.appendChild(b);
    console.log(`[spawnBulletVisual] Bullet created and added to scene`);
  }

  // ---- persistent name and score management ----
  function getPersistentName() {
    const stored = localStorage.getItem("facingworlds_player_name");
    if (stored && stored.trim().length > 0) {
      return stored.trim();
    }

    // Generate new name and store it
    const newName = genName();
    localStorage.setItem("facingworlds_player_name", newName);
    return newName;
  }

  function setPersistentName(name) {
    if (name && name.trim().length > 0) {
      localStorage.setItem("facingworlds_player_name", name.trim());
      return true;
    }
    return false;
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

  // Expose management functions globally for UI
  window.setPlayerName = setPersistentName;
  window.getPlayerName = getPersistentName;
  window.getPlayerScore = getPersistentScore;
  window.setPlayerScore = setPersistentScore;

  // network.js (top-level helper)
  function genName() {
    const adj = [
      "Neon",
      "Rapid",
      "Silent",
      "Crimson",
      "Quantum",
      "Wicked",
      "Fuzzy",
      "Turbo",
      "Nimbus",
      "Arctic",
      "Sly",
      "Nova",
      "Drift",
      "Cosmic",
      "Blazing",
    ];
    const noun = [
      "Falcon",
      "Viper",
      "Fox",
      "Raven",
      "Comet",
      "Jaguar",
      "Wolf",
      "Puma",
      "Lynx",
      "Wasp",
      "Cobra",
      "Panda",
      "Otter",
      "Hawk",
      "Badger",
    ];
    const a = adj[Math.floor(Math.random() * adj.length)];
    const n = noun[Math.floor(Math.random() * noun.length)];
    const num = Math.floor(Math.random() * 900 + 100); // 100–999
    return `${a}${n}-${num}`;
  }
}

export default startNetwork;
