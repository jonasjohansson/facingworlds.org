// network.js (robust init: waits for DOM, scene, and #soldier)
(() => {
  //WS_URL = "ws://localhost:8080";
  WS_URL = "https://unrealfest-server.onrender.com";
  let ws,
    myId = null;
  let scene = null;
  let me = null;
  const remotes = new Map();

  // ---- tiny utils ----
  const waitFor = (selector) =>
    new Promise((resolve) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const obs = new MutationObserver(() => {
        const el2 = document.querySelector(selector);
        if (el2) {
          obs.disconnect();
          resolve(el2);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    });

  const waitSceneLoaded = (sc) =>
    new Promise((res) => {
      if (sc.hasLoaded) return res();
      sc.addEventListener("loaded", () => res(), { once: true });
    });

  // ---- main init ----
  document.addEventListener("DOMContentLoaded", async () => {
    scene = await waitFor("a-scene");
    await waitSceneLoaded(scene);
    me = await waitFor("#soldier"); // your local avatar entity

    // Wire scene events AFTER we have a scene
    scene.addEventListener("local-fire", onLocalFire);
    scene.addEventListener("local-hit", onLocalHit);

    // Connect WS AFTER we have me
    connect();
    // Start pose sender when me is ready
    startPoseLoop();
  });

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
          if (e) setPose(e, m);
          break;
        }
        case "fire": {
          if (m.id !== myId) spawnBulletVisual(m.origin, m.dir, m.id, false);
          break;
        }
        case "hit": {
          const e = m.victimId === myId ? me : remotes.get(m.victimId);
          if (e && e.components.health) {
            e.emit("sethp", { hp: m.hp }); // triggers health.js listener
          }
          break;
        }

        case "respawn": {
          const p = m.player;
          if (p) {
            const e = p.id === myId ? me : remotes.get(p.id);
            if (e && e.components.health) {
              e.emit("sethp", { hp: p.hp }); // reset to full
            }
            if (e) setPose(e, p);
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

  // ---- pose loop (runs only if #soldier exists) ----
  function startPoseLoop() {
    const euler = new THREE.Euler();
    setInterval(() => {
      if (!myId || !me) return;
      const o = me.object3D;
      euler.setFromQuaternion(o.quaternion, "YXZ");
      send({
        type: "pose",
        x: o.position.x,
        y: o.position.y,
        z: o.position.z,
        ry: euler.y,
      });
    }, 66);
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
    const e = document.createElement("a-entity");
    e.classList.add("avatar");
    e.dataset.playerId = p.id;
    e.setAttribute("gltf-model", "https://threejs.org/examples/models/gltf/Soldier.glb");
    e.setAttribute("shadow", "cast:true; receive:true");
    e.setAttribute("remote-avatar", "");
    e.setAttribute("health", "max:100; current:100"); // 👈 health for remotes
    scene.appendChild(e);
    remotes.set(p.id, e);

    // Wait until the component is initialized before setting pose
    const onInit = (ev) => {
      if (ev.detail.name === "remote-avatar") {
        e.removeEventListener("componentinitialized", onInit);
        setPose(e, p);
      }
    };
    e.addEventListener("componentinitialized", onInit);

    requestAnimationFrame(() => setPose(e, p));
    return e;
  }

  function removeRemote(id) {
    const e = remotes.get(id);
    if (!e) return;
    e.parentNode && e.parentNode.removeChild(e);
    remotes.delete(id);
  }
  function setPose(e, p) {
    const c = e.components["remote-avatar"];
    if (c && p) c.setNetPose(p);
  }

  // ---- visual bullets ----
  function spawnBulletVisual(origin, dir, ownerId, reportHits = false) {
    if (!scene) return;
    const speed = 18;
    const vx = dir.x * speed,
      vy = dir.y * speed,
      vz = dir.z * speed;
    const b = document.createElement("a-entity");
    b.setAttribute("position", `${origin.x} ${origin.y} ${origin.z}`);
    b.setAttribute("geometry", "primitive: sphere; radius: 0.08");
    b.setAttribute("material", "color: #ffcc00; opacity: 0.95; metalness:0.2; roughness:0.4");
    b.setAttribute("shadow", "cast:true");
    b.setAttribute("bullet", {
      vx,
      vy,
      vz,
      radius: 0.08,
      lifeSec: 2,
      ownerId: ownerId || "",
      reportHits,
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
})();
