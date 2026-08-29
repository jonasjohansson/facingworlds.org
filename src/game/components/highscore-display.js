// highscore-display.js — networked scoreboard (TAB) + the frag counter plate
//
// Chrome comes from the shared HUD module and styles.css; this component owns the
// player table and the TAB toggle. Event contracts (player-join / player-leave /
// player-kill / highscore-update / name-change) are unchanged.
import { getHud } from "./hud/hud-root.js";

AFRAME.registerComponent("highscore-display", {
  schema: {
    enabled: { type: "boolean", default: true },
    maxPlayers: { type: "number", default: 10 },
    updateInterval: { type: "number", default: 1000 }, // ms
  },

  init() {
    this.players = new Map(); // id -> {name, kills, isLocal}
    this.updateTimer = 0;

    this.hud = getHud();

    // Create UI elements
    this.createUI();

    // TAB toggle
    this._onKeyDown = (e) => {
      if (e.code === "Tab") {
        e.preventDefault();
        if (this.container) this.container.classList.add("is-open");
      }
    };
    this._onKeyUp = (e) => {
      if (e.code === "Tab") {
        e.preventDefault();
        if (this.container) this.container.classList.remove("is-open");
      }
    };
    window.addEventListener("keydown", this._onKeyDown, { passive: false });
    window.addEventListener("keyup", this._onKeyUp);

    // Listen for network events
    this.scene = this.el.sceneEl;
    this.scene.addEventListener("player-join", this.onPlayerJoin.bind(this));
    this.scene.addEventListener("player-leave", this.onPlayerLeave.bind(this));
    this.scene.addEventListener("player-kill", this.onPlayerKill.bind(this));
    this.scene.addEventListener("highscore-update", this.onHighscoreUpdate.bind(this));
    this.scene.addEventListener("name-change", this.onNameChange.bind(this));
  },

  createUI() {
    // Flat translucent panel with a rule top and bottom — the UT99 scoreboard
    // shape, not a bevelled box. Hidden until TAB is held; `.is-open` drives
    // display and nothing here writes styles.
    this.container = document.createElement("div");
    this.container.id = "highscore-container";
    this.container.className = "ut-scoreboard";

    // Two nested boxes: the outer is the plate's 2px outline, the inner is its
    // face. Same construction as every other panel on the HUD.
    const inner = document.createElement("div");
    inner.className = "ut-scoreboard__inner";
    const body = document.createElement("div");
    body.className = "ut-scoreboard__body";
    inner.appendChild(body);

    this.title = document.createElement("div");
    this.title.className = "ut-scoreboard__title";
    this.title.textContent = "Facing Worlds";

    const head = document.createElement("div");
    head.className = "ut-scoreboard__head";
    head.innerHTML = "<span>PLAYER</span><span>FRAGS</span>";

    this.playersList = document.createElement("div");
    this.playersList.id = "players-list";
    this.playersList.className = "ut-scoreboard__list";

    body.appendChild(this.title);
    body.appendChild(head);
    body.appendChild(this.playersList);
    this.container.appendChild(inner);
    this.hud.mount(this.container);

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

    // Keep the corner frag plate in step with the table it summarises
    const local = Array.from(this.players.values()).find((p) => p.isLocal);
    if (this.hud) this.hud.setFrags(local ? local.kills : 0);

    if (this.players.size === 0) {
      const emptyMsg = document.createElement("div");
      emptyMsg.className = "ut-scoreboard__empty";
      emptyMsg.textContent = "NO PLAYERS CONNECTED";
      this.playersList.appendChild(emptyMsg);
      return;
    }

    // Sort players by kills (descending)
    const sortedPlayers = Array.from(this.players.values())
      .sort((a, b) => b.kills - a.kills)
      .slice(0, this.data.maxPlayers);

    sortedPlayers.forEach((player, index) => {
      const playerDiv = document.createElement("div");
      playerDiv.className = player.isLocal ? "ut-row is-local" : "ut-row";

      const rankSpan = document.createElement("span");
      rankSpan.className = "ut-row__rank";
      rankSpan.textContent = String(index + 1);

      const nameSpan = document.createElement("span");
      nameSpan.className = "ut-row__name";
      nameSpan.textContent = player.name;

      const killsSpan = document.createElement("span");
      killsSpan.className = "ut-row__frags";
      killsSpan.textContent = `${player.kills}`;

      playerDiv.appendChild(rankSpan);
      playerDiv.appendChild(nameSpan);
      playerDiv.appendChild(killsSpan);
      this.playersList.appendChild(playerDiv);
    });
  },

  // No tick needed — display updates are event-driven via onPlayerJoin/Kill/Leave/etc.

  remove() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    if (this.hud) {
      this.hud.release();
      this.hud = null;
    }
  },
});
