// health.js — server-authoritative HP with a floating readout, one instance per body.
//
// The 2D chrome (health plate, damage vignette, death screen) lives in the shared HUD
// module; this owns the HP state and the world-space label only.
//
// Two things changed in the port and nothing else did:
//
//   the label   was an A-Frame `text` entity (MSDF) plus `look-at="[camera]"`, a
//               component that re-aimed it every frame off the camera ENTITY's rotation.
//               It is a canvas sprite now (systems/label.js), which faces the camera by
//               construction. Same place (2.2 m up), same three colour bands.
//   `sethp`     was an event emitted at the entity and listened for here. A remote body is
//               an object now, not an element, so it is a method: setHp(hp). network.js
//               calls avatar.setHp(m.hp) where it called targetEntity.emit("sethp", …).
//
// The local player's screen chrome is still gated on `local`: remote avatars carry this
// too and must not build (or later tear down) a second HUD. The HUD itself is passed in
// rather than imported, so this module stays free of the DOM overlay while the HUD's own
// port is in flight.
import { makeLabelSprite, updateLabelSprite, disposeLabelSprite } from "./label.js";

const DEFAULTS = {
  max: 100,
  current: 100,
  // Is this the local player (screen chrome, death events)?
  local: false,
  // The HUD facade — getHud() from hud/hud-root.js. Only the local player's
  // Health is ever given one.
  hud: null,
  // Height of the readout above the body's origin, in metres. What the A-Frame text
  // entity's position was.
  y: 2.2,
  // World width of the sprite, sized to draw the number at the size the old one is drawn.
  //
  // The old attributes were `width: 1.4` with A-Frame's default `wrapCount: 40`, which is
  // not 1.4 m of text: A-Frame scales the MSDF mesh so that FORTY characters span 1.4 m,
  // so three digits span a fortieth of that each. MEASURED 2026-09-06 on the A-Frame page
  // against the 8081 server with seven live bots, over `[health]`'s label child ->
  // `getObject3D("text")`:
  //
  //   as drawn      world Box3 of the text mesh: 0.015 x 0.060 x 0.113 m. It is a flat
  //                 quad, so a 15 mm width and a 113 mm DEPTH means it is turned nearly
  //                 EDGE-ON — the look-at leak (it aimed off the camera ENTITY's
  //                 rotation). Every one of the seven bots read that way; the number is
  //                 there and you cannot read it.
  //   its real size geometry bbox x the mesh's world scale, which no rotation can move:
  //                 "100" is 0.1146 x 0.0601 m.
  //
  // 0.0601 m is the MSDF GLYPH QUAD, not the ink: the Roboto atlas is size 42 and its "0"
  // rect is 31 x 41 px, ~5.5 px of distance-field spill each side around a ~30 px cap, so
  // the ink is nearer 0.044 m tall. Nothing carries that padding across, and no font makes
  // "100" 1.9 times as wide as it is tall — so ONE dimension can be matched, and it is the
  // width, the one you read the number by.
  //
  // This canvas is 256 px wide and "100" in the font below inks 75.9 px of it (0.2963), so
  // widthM = 0.114 / 0.2963 = 0.385 draws it 0.1141 m wide and 0.0482 m tall: the old
  // label's own width, and a height between its padded quad (0.060) and its ink (0.044).
  // Scanning the drawn canvas rather than the metrics — the dark outline counts, it is
  // what the eye reads the edge of — gives 0.126 x 0.059 m against the old quad's
  // 0.115 x 0.060. The same number at the same size, and now turned to face you.
  //
  // It is a speck beyond a few metres, and always was. Raising this is a one-constant
  // change if the readout should carry further than the old one did.
  widthM: 0.385,
};

// The same three bands the HUD plate uses — white while healthy, amber when hurt, red
// when nearly dead — so the overhead number and the bar agree.
const COLOR_HEALTHY = "#ffffff";
const COLOR_HURT = "#ffa023";
const COLOR_CRITICAL = "#ff4436";
const COLOR_DEAD = "#808080";

export class Health {
  /**
   * @param {object} game the game handle (events, systems)
   * @param {THREE.Object3D} node the body the readout floats over
   * @param {object} [opts] see DEFAULTS
   */
  constructor(game, node, opts = {}) {
    this.game = game;
    this.node = node;
    this.opts = { ...DEFAULTS, ...opts };
    this.max = this.opts.max;
    this.hp = this.opts.current;
    this.isDead = false;
    this.isLocalPlayer = !!this.opts.local;
    this.hud = this.isLocalPlayer ? this.opts.hud : null;

    // Floating overhead readout. Just the number: "HP: 100/100" in green monospace was
    // the last thing on screen that read like a debug print rather than part of the game.
    this.label = makeLabelSprite(String(this.hp), {
      color: COLOR_HEALTHY,
      plate: false,
      widthM: this.opts.widthM,
      y: this.opts.y,
      font: "700 44px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      maxChars: 3,
    });
    if (node) node.add(this.label);

    if (this.hud) {
      this.hud.setHealth(this.hp, this.max);
      // No armour exists on the server yet. Showing a real 0 on a dimmed plate is honest;
      // inventing a value that never moves would not be. Wire the pickup and this becomes
      // one hud.setArmor() call.
      this.hud.setArmor(0);
    }
  }

  /** Server-authoritative HP. Was the `sethp` event. */
  setHp(hp) {
    const newHp = Number(hp);
    if (!Number.isFinite(newHp)) return;
    const tookDamage = newHp < this.hp;
    const wasRevived = this.isDead && newHp > 0;
    this.hp = newHp < 0 ? 0 : newHp;

    this.updateLabel();

    if (tookDamage && this.isLocalPlayer) this.flashScreen();

    if (this.hp <= 0 && !this.isDead) this.onDeath();
    else if (wasRevived) this.onRespawn();
  }

  updateLabel() {
    const pct = this.max > 0 ? this.hp / this.max : 0;
    const color = this.isDead ? COLOR_DEAD : pct > 0.6 ? COLOR_HEALTHY : pct > 0.25 ? COLOR_HURT : COLOR_CRITICAL;
    updateLabelSprite(this.label, String(Math.max(0, this.hp)), color);
    if (this.isLocalPlayer && this.hud) this.hud.setHealth(this.hp, this.max);
  }

  onDeath() {
    this.isDead = true;
    updateLabelSprite(this.label, String(Math.max(0, this.hp)), COLOR_DEAD);

    if (!this.isLocalPlayer) return;
    if (this.hud) this.hud.showDeath();
    // Disable firing.
    const weapon = this.game && this.game.systems && this.game.systems.get("first-person-weapon");
    if (weapon) weapon.enabled = false;
    // Emit local-death for spree tracking.
    if (this.game) this.game.events.emit("local-death");
  }

  onRespawn() {
    this.isDead = false;
    this.updateLabel();

    if (!this.isLocalPlayer) return;
    if (this.hud) this.hud.hideDeath();
    const weapon = this.game && this.game.systems && this.game.systems.get("first-person-weapon");
    if (weapon) weapon.enabled = true;
    // The counterpart of local-death above. Anything that got out of the player's way
    // while they were dead needs to know when to come back — pointer-lock-prompt is the
    // first such thing, and there was no event for it to listen to.
    if (this.game) this.game.events.emit("local-respawn");
  }

  flashScreen() {
    if (this.hud) this.hud.damageFlash();
  }

  dispose() {
    if (this.hud) {
      this.hud.release();
      this.hud = null;
    }
    if (this.label) {
      if (this.label.parent) this.label.parent.remove(this.label);
      disposeLabelSprite(this.label);
      this.label = null;
    }
  }
}
