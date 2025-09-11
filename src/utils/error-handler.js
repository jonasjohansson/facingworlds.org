// error-handler.js — Centralized error handling
import { log } from "./environment.js";

export class GameError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = "GameError";
    this.code = code;
    this.context = context;
    this.timestamp = new Date().toISOString();
  }
}

export function handleError(error, context = "") {
  const errorInfo = {
    message: error.message,
    stack: error.stack,
    context,
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    url: window.location.href,
  };

  log("error", `Game Error in ${context}:`, errorInfo);

  // In production, you might want to send this to an error tracking service
  if (error instanceof GameError) {
    // Handle specific game errors
    switch (error.code) {
      case "NETWORK_CONNECTION_FAILED":
        showUserMessage("Connection failed. Please check your internet connection.");
        break;
      case "MODEL_LOAD_FAILED":
        showUserMessage("Failed to load game assets. Please refresh the page.");
        break;
      case "SPAWN_FAILED":
        showUserMessage("Failed to spawn player. Please try again.");
        break;
      default:
        showUserMessage("An unexpected error occurred. Please refresh the page.");
    }
  } else {
    // Handle unexpected errors
    showUserMessage("An unexpected error occurred. Please refresh the page.");
  }
}

function showUserMessage(message) {
  // Create a simple notification system
  const notification = document.createElement("div");
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #ff4444;
    color: white;
    padding: 15px 20px;
    border-radius: 5px;
    z-index: 10000;
    font-family: Arial, sans-serif;
    font-size: 14px;
    box-shadow: 0 4px 6px rgba(0,0,0,0.3);
  `;
  notification.textContent = message;
  document.body.appendChild(notification);

  // Auto-remove after 5 seconds
  setTimeout(() => {
    if (notification.parentNode) {
      notification.parentNode.removeChild(notification);
    }
  }, 5000);
}

export function wrapAsync(fn, context) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      handleError(error, context);
      throw error;
    }
  };
}
