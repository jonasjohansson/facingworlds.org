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
    this.overlay.className = "ut-modal";

    // Create dialog
    // Same chamfered plate as the scoreboard and the meters, so the dialog
    // belongs to the HUD rather than looking like a browser prompt dropped on
    // top of it. Outer box is the outline, inner box is the face.
    this.dialog = document.createElement("div");
    this.dialog.className = "ut-modal__dialog";
    const dialogInner = document.createElement("div");
    dialogInner.className = "ut-modal__inner";
    const dialogBody = document.createElement("div");
    dialogBody.className = "ut-modal__body";
    dialogInner.appendChild(dialogBody);

    // Create title
    const title = document.createElement("div");
    title.className = "ut-modal__title";
    title.textContent = "Change Player Name";

    // Create input
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.placeholder = "Enter your name...";
    this.input.maxLength = 20;
    this.input.className = "ut-modal__input";

    // Create buttons container
    const buttonsContainer = document.createElement("div");
    buttonsContainer.className = "ut-modal__buttons";

    // Create save button
    this.saveButton = document.createElement("button");
    this.saveButton.textContent = "Save";
    this.saveButton.className = "ut-btn ut-btn--primary";

    // Create cancel button
    this.cancelButton = document.createElement("button");
    this.cancelButton.textContent = "Cancel";
    this.cancelButton.className = "ut-btn";

    // Create instructions
    const instructions = document.createElement("div");
    instructions.className = "ut-modal__hint";
    // `key` is a KeyboardEvent.code ("KeyN"); the player presses N.
    const keyLabel = this.data.key.replace(/^(Key|Digit)/, "");
    instructions.textContent = `Press ${keyLabel} to open this dialog`;

    // Assemble dialog
    buttonsContainer.appendChild(this.saveButton);
    buttonsContainer.appendChild(this.cancelButton);
    dialogBody.appendChild(title);
    dialogBody.appendChild(this.input);
    dialogBody.appendChild(buttonsContainer);
    dialogBody.appendChild(instructions);
    this.dialog.appendChild(dialogInner);
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
    this.overlay.classList.add("is-open");
    this.input.value = window.getPlayerName ? window.getPlayerName() : "";
    this.input.focus();
    this.input.select();
  },

  hide() {
    this.isVisible = false;
    this.overlay.classList.remove("is-open");
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
