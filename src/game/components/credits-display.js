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
    // Remove any existing credits container (prevent duplicates)
    const existing = document.getElementById("credits-container");
    if (existing) existing.remove();

    // Position, type and colour come from styles.css (#credits-container and the
    // .credit-* classes), which is also what the static markup in index.html uses,
    // so both paths render identically. Only the fade is written from here.
    this.container = document.createElement("div");
    this.container.id = "credits-container";
    this.container.style.opacity = "0";
    this.container.style.transition = `opacity ${this.data.fadeInDuration}ms ease-in-out`;

    // Create credits content
    this.container.innerHTML = `
      <div class="credit-line">Made by Jonas Johansson</div>
      <div class="credit-line credit-highlight">3D Model by Harry Clark</div>
      <div class="credit-link">
        <a href="/ar/">View Facing Worlds in AR — point your camera at the sticker.</a>
      </div>
    `;

    document.body.appendChild(this.container);
  },

  startFadeIn() {
    setTimeout(() => {
      if (this.container) {
        this.container.style.opacity = "1";
      }
    }, this.data.fadeInDelay);
  },

  remove() {
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
  },
});
