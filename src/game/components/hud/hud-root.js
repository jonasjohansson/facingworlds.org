// hud-root.js — the shared status bar.
//
// Every 2D overlay the player sees while alive lives here: the bottom-left
// vitals bay (paper doll + armour + health), the bottom-right ammo bay, the
// weapon bar, the frag chip, the scoreboard shell, the message rail, the damage
// vignette and the death screen. Components keep owning their *data* and their
// events; they just stopped owning their pixels.
//
// Why a module and not a component: main.js is off limits this round, so a new
// top-level import is not available. health.js, highscore-display.js and
// kill-notification.js are all already imported by main.js and all import this,
// which gives the HUD one construction point without touching the entry file.
//
// --- What the look is taken from --------------------------------------------
// Two reference screenshots were opened at full size and inspected, not
// remembered:
//
//   1. UT2003/2004 — media.moddb.com "AlternateHUDs_v2.0_Deck17.png" (1920x1440),
//      the UT2003-accurate HUD running in UT2004. What it actually shows:
//        * health bottom-LEFT and ammo bottom-RIGHT, each a wide dark-navy plate
//          with a bright steel-blue outline and a CHAMFERED outer end;
//        * a round recessed disc on the outboard end of each plate carrying the
//          glyph — blue cross for health, green shell for ammo;
//        * the numerals are large, white, chunky and squared, sitting inside the
//          plate with a soft dark halo. They are the dominant element;
//        * armour is a smaller readout with a gold shield glyph, no plate;
//        * a WEAPON BAR of small slots runs along the bottom between the two
//          plates. The slot you are holding is tinted red/salmon, the rest are
//          the same navy as the plates;
//        * small chips in the top corners for scores.
//
//   2. UT99 — media.moddb.com "Screenshot_2023-09-09_015436.png" (1920x1080),
//      retail UT99 on CTF-Face. What it actually shows: two flat translucent
//      blue rectangles top-right (armour over health, each with its glyph on the
//      right), and beside them a full-body PAPER DOLL of the armoured soldier
//      drawn as a glowing team-colour figure with visible panel lines.
//
// This HUD takes the 2003/2004 chassis — plates, bevels, chamfers, big
// typographic numerals, weapon bar — and keeps UT99's paper doll, because that
// is the most distinctive thing either era has and neither the 2003 nor the 2004
// HUD kept it. The doll moves down beside the health plate so the whole vitals
// group reads as one bay.
//
// No UT art or fonts are used or shipped. The doll and every glyph are
// hand-authored inline SVG; the type is a generic squared grotesque from Google
// Fonts behind a full system fallback stack, so the page is unchanged offline
// apart from the exact letterforms.
//
// Presentation lives in styles.css under the `ut-` prefix. Nothing here sets a
// colour, a size or a font inline — this file only builds structure and writes
// text, `data-*` and `is-*` classes.

const FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@500;600;700&family=Saira:wght@600;700;800&display=swap";

// Client-side magazine. There is no ammo model on the server and firing is NOT
// gated on this — it is an honest live count of the shots you have actually
// taken, reset by a cosmetic reload, not a fabricated number. See
// watchLocalShots().
const MAG_SIZE = 50;
const RELOAD_MS = 1400;

// Fat square-armed plus. Blunt arms, not a rounded medical cross.
const SVG_HEALTH =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.4 1h5.2v7.4H22v5.2h-7.4V21H9.4v-7.4H2V8.4h7.4z"/></svg>';
// Blunt shield.
const SVG_ARMOR =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5 3.5 4.4v8.1c0 5.2 3.6 9 8.5 10 4.9-1 8.5-4.8 8.5-10V4.4z"/></svg>';
// Stubby round-nosed cartridge, read as "ammo" without being any particular gun.
const SVG_AMMO =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M12 2c2.4 1.9 3.6 4.3 3.6 7.1v3.3H8.4V9.1C8.4 6.3 9.6 3.9 12 2z"/>' +
  '<path d="M8 13.6h8v6.1a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1z"/>' +
  "</svg>";
// Frag marker for the score chip: crossed-out target ring.
const SVG_FRAG =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M12 1.6a10.4 10.4 0 1 0 0 20.8 10.4 10.4 0 0 0 0-20.8zm0 3.1a7.3 7.3 0 1 1 0 14.6 7.3 7.3 0 0 1 0-14.6z"/>' +
  '<path d="M10.4 8.2h3.2v7.6h-3.2z"/>' +
  '<path d="M8.2 10.4h7.6v3.2H8.2z"/>' +
  "</svg>";
// Slot glyph for the one weapon that exists. A blocky sidearm silhouette —
// authored here, not traced from anything.
const SVG_ENFORCER =
  '<svg viewBox="0 0 32 20" aria-hidden="true">' +
  '<path d="M2 4h22l4 2v4h-6l-2 3h-5l-1 5H8l1-5H5a3 3 0 0 1-3-3z"/>' +
  "</svg>";

// The paper doll. A front-facing armoured figure with the massing UT99's doll
// has — helmet with a visor band, wide pauldrons, a plated chest, a belt, heavy
// thighs and boots — built from plain polygons rather than traced from any
// artwork. `.ut-doll__lit` paints the visor, chest plate and belt a shade
// brighter, which is what stops the silhouette reading as one blob.
const SVG_DOLL =
  '<svg viewBox="0 0 72 118" aria-hidden="true">' +
  '<g class="ut-doll__body">' +
  // helmet + neck
  '<path d="M30 3h12l4 5v10l-3 4H29l-3-4V8z"/>' +
  '<path d="M32.5 22h7v4.5h-7z"/>' +
  // pauldrons
  '<path d="M27 26 15 30l-4 10 2 8 12 2 3-7V28z"/>' +
  '<path d="M45 26l12 4 4 10-2 8-12 2-3-7V28z"/>' +
  // torso
  '<path d="M28 26h16l4 5 1 15-2 15-3 7H29l-3-7-2-15 1-15z"/>' +
  // upper arms + forearms + fists
  '<path d="M12 41l9 2 1 15-1 9-9-1-3-11z"/>' +
  '<path d="M60 41l-9 2-1 15 1 9 9-1 3-11z"/>' +
  '<path d="M12 67h9l1 12-1 8h-8l-2-9z"/>' +
  '<path d="M60 67h-9l-1 12 1 8h8l2-9z"/>' +
  // pelvis
  '<path d="M28 66h16l2 6-2 7H28l-2-7z"/>' +
  // legs + boots
  '<path d="M28.5 77h7.5v14l-1 12 1 9h-11l1-11 1.5-13z"/>' +
  '<path d="M43.5 77H36v14l1 12-1 9h11l-1-11-1.5-13z"/>' +
  "</g>" +
  '<g class="ut-doll__lit">' +
  // visor band, chest plate, belt buckle
  '<path d="M29.5 9h13v6.5h-13z"/>' +
  '<path d="M30 31h12l2.5 8-1.5 13-2 7h-10l-2-7-1.5-13z"/>' +
  '<path d="M32.5 68h7v5h-7z"/>' +
  "</g>" +
  "</svg>";

// Weapon bar. Only the Enforcer exists in this build, so only slot 2 is filled;
// the other slots render empty rather than being stocked with weapons the player
// does not have. Add a weapon and it gets a row here.
const WEAPON_SLOTS = [
  { key: "1", name: "", icon: null },
  { key: "2", name: "Enforcer", icon: SVG_ENFORCER },
  { key: "3", name: "", icon: null },
  { key: "4", name: "", icon: null },
  { key: "5", name: "", icon: null },
];
const ACTIVE_SLOT = 1; // index into WEAPON_SLOTS

let instance = null;
let refCount = 0;

/**
 * Build (or return) the HUD singleton. Call release() for each getHud().
 * @returns {object} the HUD facade
 */
export function getHud() {
  if (!instance) instance = createHud();
  refCount++;
  return instance;
}

function ensureFont() {
  if (document.getElementById("ut-hud-font")) return;
  // --ut-font-ui / --ut-font-num in CSS both fall back to condensed system
  // faces, so a blocked or offline fonts.googleapis.com costs the page nothing
  // but the exact letterforms.
  const pre = document.createElement("link");
  pre.rel = "preconnect";
  pre.href = "https://fonts.gstatic.com";
  pre.crossOrigin = "anonymous";
  document.head.appendChild(pre);

  const link = document.createElement("link");
  link.id = "ut-hud-font";
  link.rel = "stylesheet";
  link.href = FONT_HREF;
  document.head.appendChild(link);
}

function div(className, parent) {
  const el = document.createElement("div");
  el.className = className;
  if (parent) parent.appendChild(el);
  return el;
}

/**
 * A chamfered plate. The outline is the outer element's own background showing
 * through a 2px padding ring — clip-path cuts both boxes with the same corner,
 * so the diagonal keeps its stroke, which a clipped `border` would not.
 * @param {string} className extra classes for the outer element
 * @returns {{el: HTMLElement, inner: HTMLElement}}
 */
function makePanel(className) {
  const el = div(`ut-panel ${className}`);
  const inner = div("ut-panel__in", el);
  return { el, inner };
}

/**
 * A fixed-width numeral. Tabular figures plus a reserved min-width keep the
 * plate from resizing as the value gains or loses a digit — the original bar
 * does not breathe around the number either.
 * @param {string} className
 * @param {number} slots digit positions to reserve
 * @returns {{el: HTMLElement, set: (v: number) => void, text: (s: string) => void}}
 */
// Seven-segment digits.
//
// This is not a stylistic choice, it is what UT99 uses: the health, armour and
// ammo readouts are LCD-style seven-segment numerals, with the UNLIT segments
// still faintly visible the way a real segment display shows its dead bars.
// Verified against a retail UT99 screenshot rather than from memory.
//
// Every digit renders all seven segments always; `set()` only toggles which are
// lit. That is what produces the dim ghost bars, and it means no layout ever
// reflows — the width is fixed by the slot count.
const SEG_KEYS = ["a", "b", "c", "d", "e", "f", "g"];
const SEG_MAP = {
  0: "abcdef",
  1: "bc",
  2: "abdeg",
  3: "abcdg",
  4: "bcfg",
  5: "acdfg",
  6: "acdefg",
  7: "abc",
  8: "abcdefg",
  9: "abcdfg",
};

function makeDigit(parent) {
  const d = div("ut-seg", parent);
  const segs = {};
  for (const k of SEG_KEYS) {
    const i = document.createElement("i");
    i.className = `ut-seg__${k}`;
    d.appendChild(i);
    segs[k] = i;
  }
  return {
    el: d,
    /** @param {string|null} ch a single digit, or null for a fully blank cell */
    show(ch) {
      const on = ch === null ? "" : SEG_MAP[ch] || "";
      for (const k of SEG_KEYS) segs[k].classList.toggle("is-on", on.includes(k));
    },
  };
}

function makeNumber(className, slots) {
  const wrap = div(`ut-num ${className}`);
  const digits = [];
  for (let i = 0; i < slots; i++) digits.push(makeDigit(wrap));
  return {
    el: wrap,
    /**
     * Right-aligned, leading cells blanked rather than zero-padded — UT99 shows
     * "100" and "0", never "000". Clamped to the reserved width so a value that
     * outgrows the display cannot widen it and shove the rest of the row.
     */
    set(value) {
      const n = Math.max(0, Math.round(value || 0));
      const text = String(Math.min(n, Math.pow(10, slots) - 1));
      const pad = slots - text.length;
      for (let i = 0; i < slots; i++) {
        digits[i].show(i < pad ? null : Number(text[i - pad]));
      }
    },
  };
}

function makeDisc(className, svg) {
  const el = div(`ut-disc ${className}`);
  const glyph = div("ut-disc__glyph", el);
  glyph.innerHTML = svg;
  return el;
}

/**
 * One readout: a disc and a chamfered plate holding a big numeral, plus an
 * optional caption inside the plate.
 * @param {string} modifier
 * @param {string} svg glyph for the disc
 * @param {number} slots digit positions
 * @param {boolean} discFirst disc on the left (health/armour) or right (ammo)
 */
function makeMeter(modifier, svg, slots, discFirst) {
  const row = div(`ut-meter ${modifier}`);
  const disc = makeDisc("", svg);
  const panel = makePanel("ut-panel--meter");
  const num = makeNumber("ut-num--meter", slots);
  panel.inner.appendChild(num.el);

  if (discFirst) {
    row.appendChild(disc);
    row.appendChild(panel.el);
  } else {
    row.appendChild(panel.el);
    row.appendChild(disc);
  }
  return { row, num, panel, disc };
}

/** A small corner chip: glyph, numeral, caption. */
function makeChip(modifier, svg, slots, labelText) {
  const panel = makePanel(`ut-chip ${modifier}`);
  const glyph = div("ut-chip__glyph", panel.inner);
  glyph.innerHTML = svg;
  const num = makeNumber("ut-num--chip", slots);
  panel.inner.appendChild(num.el);
  const label = div("ut-chip__label", panel.inner);
  label.textContent = labelText;
  return { el: panel.el, num, label };
}

function createHud() {
  ensureFont();

  const root = div("ut-hud");
  root.id = "ut-hud";

  // LAYOUT IS UT99's, read off a retail screenshot rather than interpreted:
  //
  //   top right   one translucent panel, armour row ABOVE health row, each
  //               number with its glyph to the RIGHT of it, and the paper doll
  //               standing immediately to the right of the panel.
  //   bottom      one translucent strip the full width of the screen: numbered
  //               weapon slots from the left, the held slot in a yellow corner
  //               bracket, ammo at the far right.
  //
  // Numbers are bare inside their panel — UT99 does not box each readout the way
  // UT2003/2004 does. That difference is most of why the previous build read as
  // the later games.

  // ---- top right: armour over health, then the doll ----
  const vitalsBay = div("ut-vitals-bay", root);

  const vitals = makePanel("ut-vitals");
  const armor = makeMeter("ut-meter--armor", SVG_ARMOR, 3, false);
  const health = makeMeter("ut-meter--health", SVG_HEALTH, 3, false);
  vitals.inner.appendChild(armor.row);
  vitals.inner.appendChild(health.row);
  vitalsBay.appendChild(vitals.el);

  const doll = div("ut-doll", vitalsBay);
  doll.innerHTML = SVG_DOLL;

  // ---- top left: frags ----
  // UT99 keeps the running score on the scoreboard rather than the main HUD, but
  // a browser game with no menu needs it visible. Kept, in the same translucent
  // idiom as everything else, rather than invented in a different style.
  const frags = makeChip("ut-chip--frags", SVG_FRAG, 3, "FRAGS");
  root.appendChild(frags.el);

  const hint = div("ut-hint", root);
  hint.innerHTML = '<kbd>TAB</kbd><span>SCORES</span>';

  // ---- bottom strip ----
  const bar = div("ut-bar", root);

  const weaponBar = div("ut-weapons", bar);
  const slots = WEAPON_SLOTS.map((w, i) => {
    const panel = makePanel("ut-wslot");
    if (w.icon) panel.el.classList.add("is-owned");
    if (i === ACTIVE_SLOT) panel.el.classList.add("is-active");
    const key = div("ut-wslot__key", panel.inner);
    key.textContent = w.key;
    const icon = div("ut-wslot__icon", panel.inner);
    if (w.icon) icon.innerHTML = w.icon;
    weaponBar.appendChild(panel.el);
    return panel.el;
  });

  // far right of the strip: ammo, glyph to its right like the vitals rows
  const ammoBay = div("ut-ammo-bay", bar);
  const ammo = makeMeter("ut-meter--ammo", SVG_AMMO, 3, false);
  ammoBay.appendChild(ammo.row);

  // ---- damage vignette ----
  const vignette = div("ut-vignette", root);

  // ---- death screen ----
  const death = div("ut-death", root);
  death.innerHTML =
    '<div class="ut-death__rule"></div>' +
    '<div class="ut-death__title">YOU DIED</div>' +
    '<div class="ut-death__sub">RESPAWNING</div>' +
    '<div class="ut-death__rule"></div>';

  document.body.appendChild(root);

  // ---- state ----
  let hp = 100;
  let hpMax = 100;
  let mag = MAG_SIZE;
  let reloading = false;
  let dead = false;
  let reloadTimer = 0;
  let vignetteTimer = 0;
  let dollTimer = 0;

  function paintHealth() {
    const pct = hpMax > 0 ? Math.max(0, Math.min(1, hp / hpMax)) : 0;
    health.num.set(Math.max(0, hp));
    // Three bands, matching UT's "you are fine / hurt / about to die" read. The
    // doll carries the same band so peripheral vision gets it without reading
    // the number.
    const level = pct > 0.6 ? "ok" : pct > 0.25 ? "warn" : "crit";
    health.row.dataset.level = level;
    doll.dataset.level = level;
  }

  function paintAmmo() {
    // UT99's HUD carries no weapon-name text, so reloading is shown by blinking
    // the ammo readout (.is-reloading in styles.css) rather than by a label the
    // original never had. The digits hold at 0 while it blinks.
    ammo.num.set(reloading ? 0 : mag);
    ammo.row.classList.toggle("is-reloading", reloading);
    ammo.row.dataset.level = reloading || mag <= 10 ? "crit" : "ok";
  }

  function paintArmor(v) {
    const n = Math.max(0, Math.round(v));
    armor.num.set(n);
    armor.row.dataset.level = n > 0 ? "ok" : "empty";
  }

  // ---- local shot detection ----
  // first-person-weapon owns firing and stamps `lastFireTime` on every LOCAL
  // shot. The scene's `bullet-fired` event is no good here: network.js spawns
  // bullet entities for remote players too, so it would drain your magazine when
  // someone else shoots. Reading the component's own stamp is a one-property
  // compare per frame and needs no change to the fire path.
  let rafId = 0;
  let lastSeenFire = 0;
  let fpw = null;
  function watchLocalShots() {
    rafId = requestAnimationFrame(watchLocalShots);
    if (!fpw) {
      const cam = document.querySelector("#cam");
      fpw = (cam && cam.components && cam.components["first-person-weapon"]) || null;
      if (!fpw) return;
      lastSeenFire = fpw.lastFireTime || 0;
    }
    const t = fpw.lastFireTime || 0;
    if (t !== lastSeenFire) {
      lastSeenFire = t;
      // Dead players still stamp lastFireTime: health.js sets
      // first-person-weapon enabled:false, which drops the weapon entity, but
      // the component's tick advances the stamp before fireBullet() bails on
      // the missing weapon. Counting those would drain the magazine — and show
      // RELOADING — on the death screen for shots that were never fired.
      if (!reloading && !dead) {
        mag = Math.max(0, mag - 1);
        slots[ACTIVE_SLOT].classList.remove("is-fired");
        void slots[ACTIVE_SLOT].offsetWidth;
        slots[ACTIVE_SLOT].classList.add("is-fired");
        if (mag === 0) {
          reloading = true;
          clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => {
            mag = MAG_SIZE;
            reloading = false;
            paintAmmo();
          }, RELOAD_MS);
        }
        paintAmmo();
      }
    }
  }
  rafId = requestAnimationFrame(watchLocalShots);

  // requestAnimationFrame is parked while the tab is hidden (so is A-Frame's own
  // render loop), which means the stamp can move without the frames in between
  // ever running. Resync on the way back so a tab switch does not book one
  // phantom shot.
  const onVisibility = () => {
    if (!document.hidden && fpw) lastSeenFire = fpw.lastFireTime || 0;
  };
  document.addEventListener("visibilitychange", onVisibility);

  paintHealth();
  paintArmor(0);
  paintAmmo();

  return {
    root,

    setHealth(current, max) {
      if (typeof max === "number" && max > 0) hpMax = max;
      hp = current;
      paintHealth();
    },

    setArmor: paintArmor,

    setFrags(n) {
      frags.num.set(n || 0);
    },

    /** Red edge vignette on damage — reads as a hit without whiting out the
     *  scene. The doll blinks with it, which is the cheapest way to tie the
     *  feedback to the figure that represents you. */
    damageFlash() {
      vignette.classList.remove("is-on");
      void vignette.offsetWidth;
      vignette.classList.add("is-on");
      clearTimeout(vignetteTimer);
      vignetteTimer = setTimeout(() => vignette.classList.remove("is-on"), 140);

      doll.classList.remove("is-hit");
      void doll.offsetWidth;
      doll.classList.add("is-hit");
      clearTimeout(dollTimer);
      dollTimer = setTimeout(() => doll.classList.remove("is-hit"), 200);
    },

    showDeath() {
      dead = true;
      death.classList.add("is-on");
      root.classList.add("is-dead");
    },

    hideDeath() {
      dead = false;
      death.classList.remove("is-on");
      root.classList.remove("is-dead");
      mag = MAG_SIZE;
      reloading = false;
      clearTimeout(reloadTimer);
      paintAmmo();
    },

    /** Attach an externally-owned overlay (scoreboard, message rail) into the
     *  HUD layer. */
    mount(el) {
      root.appendChild(el);
      return el;
    },

    release() {
      refCount = Math.max(0, refCount - 1);
      if (refCount > 0) return;
      cancelAnimationFrame(rafId);
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(reloadTimer);
      clearTimeout(vignetteTimer);
      clearTimeout(dollTimer);
      if (root.parentNode) root.remove();
      instance = null;
    },
  };
}
