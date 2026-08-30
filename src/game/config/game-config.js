// game-config.js — Centralized configuration
export const GAME_CONFIG = {
  // Network settings
  NETWORK: {
    // 8081 so it does not collide with the static server `npm start` puts on 8080.
    // wss://, not ws://. The dev site is served over https (mkcert) and `npm run
    // server:tls` puts a TLS WebSocket on 8081, so a browser blocks an insecure ws://
    // socket opened from that secure context and multiplayer never connects. wss:// is
    // also valid from a plain http:// page, so this is correct either way.
    LOCAL_URL: "wss://localhost:8081",
    PRODUCTION_URL: "wss://unrealfest-server.onrender.com",
    POSE_UPDATE_INTERVAL: 100, // ms
    CONNECTION_TIMEOUT: 5000, // ms
  },

  // Player settings
  PLAYER: {
    HEALTH_MAX: 100,
    HEALTH_CURRENT: 100,
    // aframe-extras movement-controls' own `speed` knob. It is NOT metres per second:
    // the component multiplies it by 16.667 to get m/s, so this is MOVEMENT.GROUND_SPEED
    // / 16.667. ut-controls bypasses it for keyboard and touch, but gamepad and trackpad
    // still run through it, so it is kept in step with the UT99 ground speed.
    MOVEMENT_SPEED: 0.563,
    // How far above the navmesh bbox the placement raycast starts. World-anchored, so
    // x WORLD_SCALE (see src/shared/map-transform.js); spawn.js carries the same number.
    SPAWN_HEIGHT_ABOVE: 18.68,
    // z-fighting epsilon in renderer units, NOT a world distance. Unchanged by the scale.
    SPAWN_LIFT: 0.05,
  },

  // Movement — UT99 Pawn defaults converted to this scene's units.
  //
  // SCALE, MEASURED IN THE RUNNING SCENE (not assumed):
  //   soldier model bounding box  1.85 x 1.83 x 0.44   -> 1 scene unit = 1 metre
  //   navmesh bounding box     257.4 x 71.5 x 95.3 m   -> the playable rock is 257 m long
  //   camera (eye) height        1.4 m above the rig origin
  // A UT99 pawn is 78 UU tall, so 1.83 m / 78 UU = 0.0235 m per UU.
  //
  // The map used to measure 110.2 x 30.6 x 40.8, because the fan model of CTF-Face was
  // authored at 0.010062 m/UU — 43% of the scale this rig is built for. Everything in this
  // MOVEMENT block was already right; it was the world that was small. The x2.33552
  // correction is baked into the .glb files (src/shared/map-transform.js), so 1 scene unit
  // is still 1 metre and not one number below changes. The towers are 71 m tall now, the
  // tower-to-tower run is 176 m, and at GROUND_SPEED that is the ~19 s flag run CTF-Face
  // is supposed to have.
  MOVEMENT: {
    UU_TO_METRES: 0.0235,
    // GroundSpeed 400 UU/s. The stock rig ran 6.67 m/s straight and 9.43 m/s on a
    // diagonal; this is one honest speed in every direction. Measured in the running
    // scene: 9.40 m/s forward, 9.40 m/s diagonal, 9.40 m/s backward.
    GROUND_SPEED: 9.4,
    // AccelRate 2048 UU/s^2 — roughly 0.2 s from a standstill to full speed. Measured:
    // 0.183 s to 95% of top speed.
    ACCEL: 48.0,
    // No UT99 equivalent; picked so a stop takes about 0.16 s and does not feel like ice.
    // Measured: 0.15 s from full speed to a standstill.
    DECEL: 60.0,
    // Between the two eras, picked by sweeping it in the running scene rather than off a
    // wiki. The test: run to full speed, jump, then hold a hard 90 degree turn for the
    // whole 0.73 s of airtime, and separately hold a full reversal.
    //     0.05 (UT99)     turn  8.7 deg, 1.44 m of steering — the jump is a dead 0.7 s
    //     0.10            turn 19.8 deg, 1.87 m
    //     0.18 (here)     turn 42.3 deg, 2.41 m; a reversal bleeds 9.4 -> 3.1 m/s
    //     0.22            turn 54.4 deg; a reversal bleeds to 1.7 m/s, near a mid-air stop
    //     0.28            a reversal FLIPS the velocity 180 deg — you can undo a jump
    //     0.35 (UT2004)   turn 85.5 deg — air and ground steer alike, the jump has no weight
    // 0.18 is the last value where the takeoff still decides where you land: you can bend
    // the arc and shed speed, but you cannot turn around or cancel your momentum.
    AIR_CONTROL: 0.18,
    // JumpZ 350 UU/s and ZoneGravity -950 UU/s^2. Measured in the running scene: a 1.44 m
    // apex over 0.72 s of airtime (the theoretical 1.51 m / 0.74 s, less what a 60 Hz
    // Euler step loses). NOTE this is a hop in place — the rig has to stay clamped to the
    // navmesh, so ut-jump raises the camera and body instead. See ut-movement.js.
    JUMP_VELOCITY: 8.2,
    GRAVITY: 22.3,
  },

  // Camera settings
  // The THIRD_PERSON radii and FIRST_PERSON_HEIGHT are player-anchored — how far the
  // camera sits from the avatar — so they did not move with the world scale.
  CAMERA: {
    FIRST_PERSON_HEIGHT: 1.8,
    THIRD_PERSON_RADIUS: 6,
    THIRD_PERSON_MIN_RADIUS: 3,
    THIRD_PERSON_MAX_RADIUS: 15,
    THIRD_PERSON_POLAR: 15,
    // World-anchored: it has to clear the towers, which are now 76.9 units tall. x k.
    OVERHEAD_HEIGHT: 93.42,
  },

  // Bullet settings — SPEED is still used by the network layer as the direction scale
  // when it relays a remote shot; shots themselves are hitscan (see WEAPON).
  BULLET: {
    SPEED: 70,
    RADIUS: 0.08,
    FIRE_RATE: 8,
    COLOR: "#ffcc00",
  },

  // Enforcer — UT99 fires it instantly, roughly 4 shots/sec
  // Weapon pickups. The server owns which pickups exist, where they are and who
  // holds them (see server/server.js) — this is only how they LOOK. Positions
  // arrive from the server, so nothing here needs to agree with it.
  PICKUP: {
    RADIUS: 7.01, // x k — must match PICKUP_RADIUS server-side; the client only predicts
    SPIN_SPEED: 1.1, // radians/sec
    BOB_HEIGHT: 0.22, // units — prop-sized, read against the player, so NOT scaled
    BOB_SPEED: 2.0, // radians/sec
    GLOW_COLOR: "#ffd07a",
    // x k alongside GLOW_RANGE: A-Frame's light component defaults point-light decay to 1,
    // so illumination falls off as 1/d and a light that reaches 2.34x further has to be
    // 2.34x brighter to leave the lit pedestal looking the same.
    GLOW_INTENSITY: 5.14,
    GLOW_RANGE: 16.35, // x k — this has to reach the pedestal it is sitting on
    // How often the client may ask for a pickup it is standing on. The server
    // refuses anything it should, so this only stops us shouting at it.
    CLAIM_INTERVAL: 400, // ms
  },

  // Capture the Flag. As with the pickups, the server owns the flags — where they
  // are, who carries them and what a touch means. Everything here is how they LOOK
  // and how often the client is allowed to ask.
  CTF: {
    // Client-side touch gate, and the TIGHTER of the two: a touch only happens when
    // the client asks, and the server's 7.17 (FLAG_RADIUS + FLAG_CLAIM_SLACK) can only
    // refuse. It was sized as 3.0 x k against the tower roofs, back when the flags stood
    // up there and the furthest walkable corner was ~6.66 out. The flags are on their
    // ground-level plinths now (src/shared/map-actors.js, FLAG_HOMES), which is open
    // floor rather than a ledge, so the same reach is if anything more generous than it
    // was — a player who can see the stand can take the flag.
    RADIUS: 7.01,
    CLAIM_INTERVAL: 400, // ms between "I am standing on it" requests, as PICKUP does
    RED: "#ff3a22",
    BLUE: "#2f86ff",
    RED_GLOW: "#ff6b56",
    BLUE_GLOW: "#7cb6ff",
    // Flag PROP dimensions: a flag is something a player picks up and carries on their
    // back, so it is sized against the avatar and did NOT scale with the map.
    POLE_HEIGHT: 2.4,
    CLOTH_W: 1.1,
    CLOTH_H: 0.7,
    WAVE_SPEED: 4.5,
    WAVE_AMP: 0.09,
    // Where the flag rides on a carrier's back, in rig space before the yaw is applied.
    CARRY_OFFSET: { x: 0, y: 1.15, z: 0.32 },
    CARRY_TILT_DEG: -35,
    DROP_TILT_DEG: 12,
  },

  // Team identity. Both bases are already lit hard red and blue, so a diffuse tint on
  // an avatar washes out under the matching light — the tint is emissive instead.
  TEAMS: {
    RED: "#ff3a22",
    BLUE: "#2f86ff",
    EMISSIVE_STRENGTH: 0.45,
  },

  // HUD art source. true: draw the HUD from the original UT99 atlases shipped
  // under assets/ut99/ (Epic's textures, see assets/ut99/NOTICE.md), exactly the
  // way ChallengeHUD.uc draws them. false: the measured SVG/CSS recreation of the
  // same art, which stays in the code so this is a one-line revert.
  HUD: {
    ATLAS: true,
  },

  WEAPON: {
    FIRE_RATE: 4, // shots per second
    // Dual Enforcers: UT99's second-Enforcer pickup. Same gun twice, fired
    // alternately, so the rate doubles while each shot is individually worse.
    DUAL_FIRE_RATE: 8,
    DUAL_SPREAD_MULTIPLIER: 1.9, // accuracy is what you trade for the rate
    DUAL_OFFSET_X: 0.42, // how far the second gun sits to the other side
    // Metres a trace travels before it is called a miss. The map's full diagonal at world
    // scale is 298 m, so this covers everything reachable with a third to spare. It is
    // held EQUAL to the server's MAX_HIT_RANGE rather than scaled to 500 * k = 1168: a
    // client trace longer than the server's gate just produces hits the server refuses.
    MAX_RANGE: 400,
    SPREAD: 0.006, // tangent of the cone half-angle applied per shot
    // Camera kick, in radians. A fraction of each kick is recovered so the aim drifts up
    // under sustained fire the way UT99's does, without walking off to the ceiling.
    RECOIL_PITCH: 0.022,
    RECOIL_YAW: 0.008,
    RECOIL_RECOVER_FRACTION: 0.8,
    RECOIL_RECOVER_SPEED: 0.35, // radians per second
    // Weapon model kick. Applied to rotation only so it composes with weapon-sway,
    // which owns the weapon's position.
    KICK_PITCH: 0.24,
    KICK_ROLL: 0.07,
    KICK_RECOVER: 0.13, // seconds back to rest
    // Muzzle flash
    MUZZLE_FLASH_LIFE: 0.05,
    MUZZLE_FLASH_SIZE: 0.1,
    MUZZLE_LIGHT_INTENSITY: 14,
    MUZZLE_LIGHT_RANGE: 6,
    // Crosshair bloom
    CROSSHAIR_BLOOM: 1.0,
    CROSSHAIR_BLOOM_DECAY: 7.0, // per second
  },

  // Player hitbox — a vertical capsule for the body plus a sphere for the head,
  // measured in metres above the avatar's feet.
  HITBOX: {
    RADIUS: 0.34,
    CAPSULE_BOTTOM: 0.3,
    CAPSULE_TOP: 1.28,
    HEAD_HEIGHT: 1.5,
    HEAD_RADIUS: 0.22,
  },

  // Pooled tracer / spark / decal budgets. Every pool is fixed size; the oldest slot is
  // recycled once the cap is reached.
  EFFECTS: {
    MAX_TRACERS: 16,
    MAX_SPARKS: 12,
    MAX_DECALS: 24,
    TRACER_LIFE: 0.055,
    TRACER_RADIUS: 0.012,
    TRACER_OPACITY: 0.85,
    SPARK_LIFE: 0.09,
    SPARK_SIZE: 0.35,
    DECAL_LIFE: 8.0,
    DECAL_SIZE: 0.18,
    DECAL_OPACITY: 0.85,
    IMPACT_LIGHT_INTENSITY: 12,
    IMPACT_LIGHT_RANGE: 4,
  },

  // Target settings
  TARGETS: {
    COUNT: 25,
    RADIUS_MIN: 14.01, // x k
    RADIUS_MAX: 42.04, // x k
    HIT_POINTS: 10,
  },

  // Animation settings
  ANIMATION: {
    IDLE_INDEX: 0,
    WALK_INDEX: 3,
    RUN_INDEX: 1,
    // Blend reference speeds, m/s. Kept in step with MOVEMENT.GROUND_SPEED — the old
    // 1.6 / 3.2 pair was tuned for a much slower rig and pinned the run blend on
    // permanently at arena pace. character.js carries the same numbers as its defaults.
    WALK_SPEED: 4.7,
    RUN_SPEED: 9.4,
    FADE_LERP: 10.0,
    SMOOTH_SPEED_LERP: 8.0,
  },
};
