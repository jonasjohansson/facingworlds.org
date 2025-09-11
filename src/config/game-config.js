// game-config.js — Centralized configuration
export const GAME_CONFIG = {
  // Network settings
  NETWORK: {
    LOCAL_URL: "ws://localhost:8080",
    PRODUCTION_URL: "https://unrealfest-server.onrender.com",
    POSE_UPDATE_INTERVAL: 100, // ms
    CONNECTION_TIMEOUT: 5000, // ms
  },

  // Player settings
  PLAYER: {
    HEALTH_MAX: 100,
    HEALTH_CURRENT: 100,
    MOVEMENT_SPEED: 0.4,
    SPAWN_HEIGHT_ABOVE: 8,
    SPAWN_LIFT: 0.05,
  },

  // Camera settings
  CAMERA: {
    FIRST_PERSON_HEIGHT: 1.8,
    THIRD_PERSON_RADIUS: 6,
    THIRD_PERSON_MIN_RADIUS: 3,
    THIRD_PERSON_MAX_RADIUS: 15,
    THIRD_PERSON_POLAR: 15,
    OVERHEAD_HEIGHT: 40,
  },

  // Bullet settings
  BULLET: {
    SPEED: 18,
    RADIUS: 0.08,
    FIRE_RATE: 8,
    COLOR: "#ffcc00",
  },

  // Target settings
  TARGETS: {
    COUNT: 25,
    RADIUS_MIN: 6,
    RADIUS_MAX: 18,
    HIT_POINTS: 10,
  },

  // Animation settings
  ANIMATION: {
    IDLE_INDEX: 0,
    WALK_INDEX: 3,
    RUN_INDEX: 1,
    WALK_SPEED: 1.6,
    RUN_SPEED: 3.2,
    FADE_LERP: 10.0,
    SMOOTH_SPEED_LERP: 8.0,
  },
};
