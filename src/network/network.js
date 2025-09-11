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

    // Connect WS AFTER we have me
    connect();
    // Start pose sender when me is ready
    startPoseLoop(rig);
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();

  // ---- websocket wiring ----
  function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      // Generate once when joining
      const name = genName();

      // Tell server my name
      send({ type: "setName", name });

      // Also request to spawn
      send({ type: "spawn" });
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
          (m.players || []).forEach((p) => {
            if (p.id !== myId) spawnRemote(p);
          });
          break;
        }
        case "join":
          if (m.player?.id !== myId) spawnRemote(m.player);
          break;
        case "leave":
          removeRemote(m.id);
          break;
        case "name": {
          const e = remotes.get(m.id);
          if (e) e.setAttribute("data-name", m.name);
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
            console.log(
              `[network] Received pose for ${m.id} - Position: (${m.x?.toFixed(2)}, ${m.y?.toFixed(2)}, ${m.z?.toFixed(
                2
              )}) Rotation: ${m.ry?.toFixed(2)}`
            );
            setPose(e, m);
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
            targetEntity.emit("sethp", { hp: m.hp }); // triggers health.js listener
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
      }
    };
    ws.onclose = () => setTimeout(connect, 1000);
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // ---- pose loop (runs only if #rig exists) ----
  function startPoseLoop(rig) {
    setInterval(() => {
      if (!myId || !rig) return;
      const o = rig.object3D;

      // Get the rig's rotation (which is controlled by E/Q keys)
      const yRotation = o.rotation.y;

      // Debug: log what we're sending
      console.log(
        `[network] Sending pose - Position: (${o.position.x.toFixed(2)}, ${o.position.y.toFixed(2)}, ${o.position.z.toFixed(
          2
        )}) Rotation: ${yRotation.toFixed(2)}`
      );

      send({
        type: "pose",
        x: o.position.x,
        y: o.position.y,
        z: o.position.z,
        ry: yRotation,
      });
    }, 100); // Match server throttle interval
  }

  // ---- scene event handlers ----
  function onLocalFire(ev) {
    const { origin, dir } = ev.detail || {};
    send({ type: "fire", origin, dir });
    spawnBulletVisual(origin, dir, myId, true);
  }

  function onLocalHit(ev) {
    const { victimId, dmg } = ev.detail || {};
    if (!victimId) return;
    send({ type: "clientHit", victimId, dmg });
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
      c.setNetPose(p);
    }
  }

  // ---- visual bullets ----
  function spawnBulletVisual(origin, dir, ownerId, reportHits = false) {
    if (!scene) return;
    const speed = 18;
    const vx = dir.x * speed,
      vy = dir.y * speed,
      vz = dir.z * speed;
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
    scene.appendChild(b);
  }

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
