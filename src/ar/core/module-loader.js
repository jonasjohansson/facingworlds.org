// Modern ES6 Module Loader for AR Project
export class ModuleLoader {
  constructor() {
    this.loadedModules = new Set();
  }

  async loadAll() {
    try {
      // A-Frame includes Three.js, encantar loaded synchronously in HTML
      // No additional modules need to be loaded
      console.log("All modules loaded successfully");
      return true;
    } catch (error) {
      console.error("Error loading modules:", error);
      return false;
    }
  }
}

// Create and export singleton instance
export const moduleLoader = new ModuleLoader();
