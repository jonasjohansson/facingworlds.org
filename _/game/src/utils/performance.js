// performance.js — Performance monitoring and optimization
import { log } from "./environment.js";

class PerformanceMonitor {
  constructor() {
    this.metrics = new Map();
    this.frameCount = 0;
    this.lastFpsTime = performance.now();
    this.fps = 0;
    this.isMonitoring = false;
  }

  startMonitoring() {
    this.isMonitoring = true;
    this.measureFrameRate();
  }

  stopMonitoring() {
    this.isMonitoring = false;
  }

  measureFrameRate() {
    if (!this.isMonitoring) return;

    this.frameCount++;
    const now = performance.now();

    if (now - this.lastFpsTime >= 1000) {
      this.fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsTime));
      this.frameCount = 0;
      this.lastFpsTime = now;

      if (this.fps < 30) {
        log("warn", `Low FPS detected: ${this.fps}`);
      }
    }

    requestAnimationFrame(() => this.measureFrameRate());
  }

  startTiming(name) {
    this.metrics.set(name, performance.now());
  }

  endTiming(name) {
    const startTime = this.metrics.get(name);
    if (startTime) {
      const duration = performance.now() - startTime;
      this.metrics.delete(name);

      if (duration > 16) {
        // More than one frame at 60fps
        log("warn", `Slow operation: ${name} took ${duration.toFixed(2)}ms`);
      }

      return duration;
    }
    return 0;
  }

  getMemoryUsage() {
    if (performance.memory) {
      return {
        used: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024),
        total: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024),
        limit: Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024),
      };
    }
    return null;
  }

  logPerformanceStats() {
    const memory = this.getMemoryUsage();
    log("info", `Performance Stats - FPS: ${this.fps}, Memory: ${memory ? `${memory.used}MB/${memory.total}MB` : "N/A"}`);
  }
}

export const performanceMonitor = new PerformanceMonitor();

// Throttle function for performance optimization
export function throttle(func, limit) {
  let inThrottle;
  return function () {
    const args = arguments;
    const context = this;
    if (!inThrottle) {
      func.apply(context, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

// Debounce function for performance optimization
export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
