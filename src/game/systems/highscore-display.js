// highscore-display.js — networked scoreboard (TAB) + the frag counter plate
//
// Chrome comes from the shared HUD module and styles.css; this owns the player table and
// the TAB toggle. Event contracts (player-join / player-leave / player-kill /
// highscore-update / name-change) are unchanged — they are read off game.events now
// instead of the A-Frame scene, which is the same emit with the same detail.
//
// TAB IS STILL HOLD-TO-SHOW, not a toggle. The old component owned a keydown/keyup pair
// and preventDefault()ed both; engine/input.js already swallows Tab's focus jump and
// already tracks the key's level in `input.keys`, so this reads that level once a frame
// instead of adding a second listener for the same key. Same behaviour, one owner:
// releasing the key closes the board, and a Tab that arrives while the name box has focus
// never reaches input.js at all (it skips INPUT/TEXTAREA targets), so typing still tabs.
import { getHud } from "../hud/hud-root.js";

const DEFAULTS = {
  enabled: true,
  maxPlayers: 10,
  // Kept because the old schema had it; nothing has ever read it — the table is rebuilt
  // on every event rather than polled.
  updateInterval: 1000, // ms
};

export class HighscoreDisplay {
  constructor(game, opts = {}) {
    this.game = game;
    this.data = { ...DEFAULTS, ...opts };
    this.players = new Map(); // id -> {name, kills, isLocal}
    this.tabDown = false;

    this.hud = getHud(game);

    // Create UI elements
    this.createUI();

    // Listen for network events
    const events = game.events;
    this._off = [
      events.on("player-join", (e) => this.onPlayerJoin(e)),
      events.on("player-leave", (e) => this.onPlayerLeave(e)),
      events.on("player-kill", (e) => this.onPlayerKill(e)),
      events.on("highscore-update", (e) => this.onHighscoreUpdate(e)),
      events.on("name-change", (e) => this.onNameChange(e)),
    ];
  }

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
  }

  /** The TAB level, once a frame. See the header for why it is not a listener. */
  update() {
    if (!this.data.enabled || !this.container) return;
    const down = !!(this.game.input && this.game.input.keys.Tab);
    if (down === this.tabDown) return;
    this.tabDown = down;
    this.container.classList.toggle("is-open", down);
  }

  onPlayerJoin(event) {
    const { id, name, isLocal = false, kills = 0 } = event.detail;
    this.players.set(id, {
      name: name || `Player_${id}`,
      kills: kills,
      isLocal: isLocal,
    });
    this.updateDisplay();
  }

  onPlayerLeave(event) {
    const { id } = event.detail;
    this.players.delete(id);
    this.updateDisplay();
  }

  onPlayerKill(event) {
    const { killerId } = event.detail;

    // Award kill to killer
    if (this.players.has(killerId)) {
      this.players.get(killerId).kills++;
    }

    this.updateDisplay();
  }

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
  }

  onNameChange(event) {
    const { playerId, newName } = event.detail;
    if (this.players.has(playerId)) {
      this.players.get(playerId).name = newName;
      this.updateDisplay();
    }
  }

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
  }

  dispose() {
    for (const off of this._off) off();
    this._off.length = 0;
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
    if (this.hud) {
      this.hud.release();
      this.hud = null;
    }
  }
}
