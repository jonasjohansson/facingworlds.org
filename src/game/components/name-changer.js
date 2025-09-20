// name-changer.js — Simple UI for changing persistent player name
AFRAME.registerComponent("name-changer", {
  schema: {
    enabled: { type: "boolean", default: true },
    key: { type: "string", default: "KeyN" }, // N key by default
  },

  init() {
    this.isVisible = false;
    this.createUI();
    this.setupKeyboard();
  },

  createUI() {
    // Create overlay
    this.overlay = document.createElement("div");
    this.overlay.id = "name-changer-overlay";
    this.overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.8);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 2000;
      font-family: 'Courier New', monospace;
    `;

    // Create dialog
    this.dialog = document.createElement("div");
    this.dialog.style.cssText = `
      background: rgba(20, 20, 20, 0.95);
      border: 2px solid #ffcc00;
      border-radius: 8px;
      padding: 20px;
      min-width: 300px;
      text-align: center;
      color: white;
    `;

    // Create title
    const title = document.createElement("div");
    title.textContent = "Change Player Name";
    title.style.cssText = `
      font-size: 18px;
      font-weight: bold;
      color: #ffcc00;
      margin-bottom: 15px;
    `;

    // Create input
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.placeholder = "Enter your name...";
    this.input.maxLength = 20;
    this.input.style.cssText = `
      width: 100%;
      padding: 10px;
      font-size: 16px;
      font-family: 'Courier New', monospace;
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid #666;
      border-radius: 4px;
      color: white;
      text-align: center;
      margin-bottom: 15px;
    `;

    // Create buttons container
    const buttonsContainer = document.createElement("div");
    buttonsContainer.style.cssText = `
      display: flex;
      gap: 10px;
      justify-content: center;
    `;

    // Create save button
    this.saveButton = document.createElement("button");
    this.saveButton.textContent = "Save";
    this.saveButton.style.cssText = `
      padding: 8px 16px;
      background: #ffcc00;
      color: black;
      border: none;
      border-radius: 4px;
      font-family: 'Courier New', monospace;
      font-weight: bold;
      cursor: pointer;
    `;

    // Create cancel button
    this.cancelButton = document.createElement("button");
    this.cancelButton.textContent = "Cancel";
    this.cancelButton.style.cssText = `
      padding: 8px 16px;
      background: #666;
      color: white;
      border: none;
      border-radius: 4px;
      font-family: 'Courier New', monospace;
      cursor: pointer;
    `;

    // Create instructions
    const instructions = document.createElement("div");
    instructions.textContent = `Press ${this.data.key} to open this dialog`;
    instructions.style.cssText = `
      font-size: 12px;
      color: #999;
      margin-top: 10px;
    `;

    // Assemble dialog
    buttonsContainer.appendChild(this.saveButton);
    buttonsContainer.appendChild(this.cancelButton);
    this.dialog.appendChild(title);
    this.dialog.appendChild(this.input);
    this.dialog.appendChild(buttonsContainer);
    this.dialog.appendChild(instructions);
    this.overlay.appendChild(this.dialog);
    document.body.appendChild(this.overlay);

    // Add event listeners
    this.saveButton.addEventListener("click", () => this.saveName());
    this.cancelButton.addEventListener("click", () => this.hide());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.saveName();
      if (e.key === "Escape") this.hide();
    });
  },

  setupKeyboard() {
    this.onKeyDown = (e) => {
      if (e.code === this.data.key && this.data.enabled) {
        e.preventDefault();
        this.toggle();
      }
    };
    window.addEventListener("keydown", this.onKeyDown);
  },

  show() {
    this.isVisible = true;
    this.overlay.style.display = "flex";
    this.input.value = window.getPlayerName ? window.getPlayerName() : "";
    this.input.focus();
    this.input.select();
  },

  hide() {
    this.isVisible = false;
    this.overlay.style.display = "none";
  },

  toggle() {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  },

  saveName() {
    const newName = this.input.value.trim();
    if (newName.length === 0) {
      alert("Please enter a name!");
      return;
    }

    if (newName.length > 20) {
      alert("Name too long! Maximum 20 characters.");
      return;
    }

    // Save the name
    if (window.setPlayerName && window.setPlayerName(newName)) {
      // Send name change to server via scene event
      this.el.sceneEl.emit("change-name", { name: newName });

      this.hide();
      console.log(`[name-changer] Name changed to: ${newName}`);
    } else {
      alert("Failed to save name!");
    }
  },

  remove() {
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    window.removeEventListener("keydown", this.onKeyDown);
  },
});
