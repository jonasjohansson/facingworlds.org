// highscore-display.js — Minimal networked highscore display
AFRAME.registerComponent("highscore-display", {
  schema: {
    enabled: { type: "boolean", default: true },
    maxPlayers: { type: "number", default: 10 },
    updateInterval: { type: "number", default: 1000 }, // ms
  },

  init() {
    this.players = new Map(); // id -> {name, kills, isLocal}
    this.updateTimer = 0;

    // Create UI elements
    this.createUI();

    // Listen for network events
    this.scene = this.el.sceneEl;
    this.scene.addEventListener("player-join", this.onPlayerJoin.bind(this));
    this.scene.addEventListener("player-leave", this.onPlayerLeave.bind(this));
    this.scene.addEventListener("player-kill", this.onPlayerKill.bind(this));
    this.scene.addEventListener("highscore-update", this.onHighscoreUpdate.bind(this));
    this.scene.addEventListener("name-change", this.onNameChange.bind(this));
  },

  createUI() {
    // Create container div
    this.container = document.createElement("div");
    this.container.id = "highscore-container";
    this.container.style.cssText = `
      position: fixed;
      top: 20px;
      left: 20px;
      background: rgba(0, 0, 0, 0.8);
      border: 2px solid #ffcc00;
      border-radius: 8px;
      padding: 10px;
      color: white;
      font-family: 'Courier New', monospace;
      font-size: 14px;
      min-width: 200px;
      z-index: 1000;
      backdrop-filter: blur(5px);
    `;

    // Create title
    this.title = document.createElement("div");
    this.title.textContent = "SCOREBOARD";
    this.title.style.cssText = `
      font-weight: bold;
      color: #ffcc00;
      margin-bottom: 8px;
      text-align: center;
      font-size: 16px;
    `;

    // Create players list
    this.playersList = document.createElement("div");
    this.playersList.id = "players-list";
    this.playersList.style.cssText = `
      max-height: 300px;
      overflow-y: auto;
    `;

    this.container.appendChild(this.title);
    this.container.appendChild(this.playersList);
    document.body.appendChild(this.container);

    // Initial empty state
    this.updateDisplay();
  },

  onPlayerJoin(event) {
    const { id, name, isLocal = false, kills = 0 } = event.detail;
    this.players.set(id, {
      name: name || `Player_${id}`,
      kills: kills,
      isLocal: isLocal,
    });
    this.updateDisplay();
  },

  onPlayerLeave(event) {
    const { id } = event.detail;
    this.players.delete(id);
    this.updateDisplay();
  },

  onPlayerKill(event) {
    const { killerId, victimId } = event.detail;

    // Award kill to killer
    if (this.players.has(killerId)) {
      this.players.get(killerId).kills++;
    }

    this.updateDisplay();
  },

  onHighscoreUpdate(event) {
    const { players } = event.detail;
    if (players) {
      this.players.clear();
      players.forEach((player) => {
        this.players.set(player.id, {
          name: player.name,
          kills: player.kills || 0,
          isLocal: player.isLocal || false,
        });
      });
      this.updateDisplay();
    }
  },

  onNameChange(event) {
    const { playerId, newName } = event.detail;
    if (this.players.has(playerId)) {
      this.players.get(playerId).name = newName;
      this.updateDisplay();
    }
  },

  updateDisplay() {
    if (!this.playersList) return;

    // Clear current list
    this.playersList.innerHTML = "";

    if (this.players.size === 0) {
      const emptyMsg = document.createElement("div");
      emptyMsg.textContent = "No players connected";
      emptyMsg.style.cssText = "color: #666; text-align: center; font-style: italic;";
      this.playersList.appendChild(emptyMsg);
      return;
    }

    // Sort players by kills (descending)
    const sortedPlayers = Array.from(this.players.values())
      .sort((a, b) => b.kills - a.kills)
      .slice(0, this.data.maxPlayers);

    sortedPlayers.forEach((player, index) => {
      const playerDiv = document.createElement("div");
      playerDiv.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 4px 8px;
        margin: 2px 0;
        background: ${player.isLocal ? "rgba(255, 204, 0, 0.2)" : "rgba(255, 255, 255, 0.1)"};
        border-radius: 4px;
        border-left: 3px solid ${player.isLocal ? "#ffcc00" : "#666"};
      `;

      const nameSpan = document.createElement("span");
      nameSpan.textContent = player.isLocal ? `> ${player.name}` : player.name;
      nameSpan.style.cssText = `
        color: ${player.isLocal ? "#ffcc00" : "white"};
        font-weight: ${player.isLocal ? "bold" : "normal"};
      `;

      const killsSpan = document.createElement("span");
      killsSpan.textContent = `${player.kills}`;
      killsSpan.style.cssText = `
        color: #ffcc00;
        font-weight: bold;
        min-width: 30px;
        text-align: right;
        position: relative;
      `;

      // Add persistent score indicator
      if (player.isLocal && player.kills > 0) {
        const persistentIndicator = document.createElement("span");
        persistentIndicator.textContent = "★";
        persistentIndicator.style.cssText = `
          position: absolute;
          top: -8px;
          right: -8px;
          font-size: 8px;
          color: #ffcc00;
        `;
        killsSpan.appendChild(persistentIndicator);
      }

      playerDiv.appendChild(nameSpan);
      playerDiv.appendChild(killsSpan);
      this.playersList.appendChild(playerDiv);
    });
  },

  tick(time, deltaTime) {
    if (!this.data.enabled) return;

    this.updateTimer += deltaTime;
    if (this.updateTimer >= this.data.updateInterval) {
      this.updateDisplay();
      this.updateTimer = 0;
    }
  },

  remove() {
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
  },
});
