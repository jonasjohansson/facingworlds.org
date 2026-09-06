// name-changer.js — the dialog behind N for changing your persistent player name.
//
// Ported from components/name-changer.js. Two things moved and nothing else did:
//
//   the key   was a window keydown listener of its own that preventDefault()ed N. It is
//             engine/input.js's edge now, polled once a frame (consumePress). That fixes
//             a real bug for free: the old listener fired on EVERY N, including the ones
//             typed into this dialog's own text box, so typing a name with an "n" in it
//             closed the dialog under your fingers. input.js ignores key events whose
//             target is an INPUT/TEXTAREA, so the box keeps its letters.
//   the emit  `sceneEl.emit("change-name", …)` is `game.events.emit("change-name", …)`,
//             the same name and payload network.js has always listened for.
//
// The persistent name itself still lives behind window.getPlayerName/setPlayerName, which
// network.js installs — this dialog only asks for a string and hands it over.
const DEFAULTS = {
  enabled: true,
  key: "KeyN", // N key by default
};

export class NameChanger {
  constructor(game, opts = {}) {
    this.game = game;
    this.data = { ...DEFAULTS, ...opts };
    this.isVisible = false;
    this.createUI();
  }

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
  }

  /** The N edge, once a frame. See the header for why it is not a listener. */
  update() {
    if (!this.data.enabled || !this.game.input) return;
    if (this.game.input.consumePress(this.data.key)) this.toggle();
  }

  show() {
    this.isVisible = true;
    this.overlay.classList.add("is-open");
    this.input.value = window.getPlayerName ? window.getPlayerName() : "";
    this.input.focus();
    this.input.select();
  }

  hide() {
    this.isVisible = false;
    this.overlay.classList.remove("is-open");
  }

  toggle() {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

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
      // Send name change to the server via the scene bus
      this.game.events.emit("change-name", { name: newName });

      this.hide();
      console.log(`[name-changer] Name changed to: ${newName}`);
    } else {
      alert("Failed to save name!");
    }
  }

  dispose() {
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    this.overlay = null;
  }
}
