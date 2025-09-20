// credits-display.js — Credits display in bottom left
AFRAME.registerComponent("credits-display", {
  schema: {
    enabled: { type: "boolean", default: true },
    fadeInDelay: { type: "number", default: 2000 }, // ms
    fadeInDuration: { type: "number", default: 1000 }, // ms
  },

  init() {
    this.createCredits();
    this.startFadeIn();
  },

  createCredits() {
    // Create container div
    this.container = document.createElement("div");
    this.container.id = "credits-container";
    this.container.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 20px;
      color: rgba(255, 255, 255, 0.7);
      font-family: 'Courier New', monospace;
      font-size: 12px;
      line-height: 1.4;
      z-index: 1000;
      opacity: 0;
      transition: opacity ${this.data.fadeInDuration}ms ease-in-out;
      pointer-events: none;
      text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.8);
    `;

    // Create credits content
    this.container.innerHTML = `
      <div style="margin-bottom: 4px;">Made by Jonas Johansson</div>
      <div style="color: rgba(255, 204, 0, 0.8);">3D Model by Harry Clark</div>
    `;

    document.body.appendChild(this.container);
  },

  startFadeIn() {
    setTimeout(() => {
      if (this.container) {
        this.container.style.opacity = "0.7";
      }
    }, this.data.fadeInDelay);
  },

  remove() {
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
  },
});
