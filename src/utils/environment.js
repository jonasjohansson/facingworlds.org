// environment.js — Environment detection and configuration
import { GAME_CONFIG } from "../config/game-config.js";

export function isDevelopment() {
  return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" || window.location.hostname === "";
}

export function isProduction() {
  return !isDevelopment();
}

export function getWebSocketUrl() {
  return isDevelopment() ? GAME_CONFIG.NETWORK.LOCAL_URL : GAME_CONFIG.NETWORK.PRODUCTION_URL;
}

export function getDebugMode() {
  return isDevelopment();
}

export function log(level, message, ...args) {
  if (getDebugMode() || level === "error") {
    console[level](`[${new Date().toISOString()}] ${message}`, ...args);
  }
}
