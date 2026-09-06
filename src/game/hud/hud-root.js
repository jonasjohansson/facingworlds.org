import { GAME_CONFIG } from "../config/game-config.js";
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
// With GAME_CONFIG.HUD.ATLAS off, no UT art is used: the doll and every glyph are
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

// ChallengeHUD.DrawStatus: `if (Health < 50)` — absolute, not a fraction of
// max, so a 49 on a 199-boosted player still trips it. Below it the cross tile
// turns WHITE and ramps 100% -> 25% on a 2 Hz sawtooth while the digits dim to
// ~50% and recover on the same clock. Nothing turns orange or red, and nothing
// switches off. 25 does nothing special.
const LOW_HEALTH = 50;

// Health cross — HudElements1 tile (128,128,128,64), PIXEL-DUMPED at ink
// threshold 140 rather than remembered: the ink runs cols 79..122 / rows 9..52
// of the tile, a 44 x 44 isometric plus. Per-row runs off the atlas:
//
//   rows  9..52   cols 93..106      the stem, 14 texels wide, full height
//   rows 23..37   cols 79..92       the LEFT arm, its lit top edge at rows 23..25
//   rows 26..40   cols 107..122     the RIGHT arm, sitting ~5 texels LOWER
//   row  31       cols 80..121      the one row that spans the whole 44
//
// So the band is not level: it drops from left to right, and that tilt is the
// whole of the glyph's perspective. Local coordinates below are atlas minus
// (79, 9), so the viewBox IS the ink bbox and CSS only has to place it.
// Within the stem a row reads `*########%****`: col 93 mid, 94..101 the front
// face, 102 a 1-texel highlight column, 103..106 the shaded right face.
//
// The alphas below are NOT the atlas luminances: every one is pre-composited
// over the tile's own 0.26 fill, since in the original the glyph texel REPLACES
// the box texel instead of sitting on top of it. a_css = (lum - .26) / .74.
//   lum .70 front face -> .595   lum .90 lit face -> .865
//   lum .45 shaded     -> .257   lum .95 highlight -> .932
const SVG_HEALTH =
  '<svg viewBox="0 0 44 44" aria-hidden="true">' +
  // the stem: atlas cols 93..106 -> 14..27, all 44 rows
  '<path class="ut-glyph-face" d="M14 0h14v44H14z"/>' +
  // stem shading, painted BEFORE the band so the band covers it where it
  // crosses — which is exactly what the atlas shows (row 31 is flat across)
  '<path class="ut-glyph-lit" d="M14 0h14v3H14z"/>' +
  '<path class="ut-glyph-dark" d="M24 0h4v44h-4z"/>' +
  '<path class="ut-glyph-dark" d="M14 42h14v2H14z"/>' +
  '<path class="ut-glyph-hi" d="M23 0h1v44h-1z"/>' +
  // the band: full 44 wide, dropping 5 texels from the left arm to the right
  '<path class="ut-glyph-face" d="M0 14L44 19L44 31L0 27Z"/>' +
  // its lit top edge (atlas rows 23..25 left, 26..28 right)
  '<path class="ut-glyph-lit" d="M0 14L44 19v3L0 17Z"/>' +
  // its shaded bottom edge (atlas rows 35..37 left, 38..40 right)
  '<path class="ut-glyph-dark" d="M0 25L44 29v2L0 27Z"/>' +
  // the bright band near the right arm's tip (atlas cols 118..119)
  '<path class="ut-glyph-hi" d="M39 18h2v13h-2z"/>' +
  "</svg>";
// Armour shield — HudElements1 tile (0,192,128,64), cols 84..123, rows 196..250,
// a 40 x 55 texel heraldic shield. Read off the blown-up atlas, not remembered:
// a bright 2-texel rim, a pointed top with a small notch, an INTERIOR that is
// brighter than the box fill (mottled lum ~110..180 against the 66 fill — it is
// not the fill showing through) carrying a faint eagle crest, and the brightest
// band down the lower-right of the rim. Earlier drafts painted two tall "II"
// bosses here; the atlas has no such thing. Same pre-composited alpha model as
// the cross.
const SVG_ARMOR =
  '<svg viewBox="0 0 40 55" aria-hidden="true">' +
  // interior first so the rim overdraws its edge
  '<path class="ut-glyph-face" d="M3 4H18L20 2L22 4H37V35Q37 47 20 52Q3 47 3 35Z"/>' +
  // faint crest: spread wings and a body, darker than the face
  '<path class="ut-glyph-dark" d="M20 14l-2 6-8-2 6 5-3 6 7-3 7 3-3-6 6-5-8 2Z" opacity=".55"/>' +
  '<path class="ut-glyph-dark" d="M18 26h4v12h-4z" opacity=".45"/>' +
  // rim
  '<path class="ut-glyph-rim" fill-rule="evenodd" d="M0 2H18L20 0L22 2H40V36Q40 50 20 55Q0 50 0 36Z M3 4V35Q3 47 20 52Q37 47 37 35V4H22L20 2L18 4Z"/>' +
  // brightest run of the rim, lower right (atlas cols 112..121, rows 228..246)
  '<path class="ut-glyph-hi" d="M37 30v6q0 9-11 14l-1-2q10-4 10-12v-6z"/>' +
  "</svg>";
// Ammo box glyph: HudElements1 (128,192,128,64), the bullets that sit on the
// RIGHT of the tile. Measured off the atlas, not remembered: the ink bbox is
// cols 87..120 / rows 8..57 of the 128x64 tile, and it is TWO identical upright
// rifle cartridges side by side, ~16 texels each with a 2-texel gap, pointing
// up: a pointed ogive, a neck, a shoulder that flares into a straight case, and
// a 2-texel rim at the base. The shading is a single bright column down the
// left third (lum 255) and a broad highlight band on the right of the case.
// Redrawn here to that geometry; the viewBox IS the ink bbox, so CSS places it
// at the measured offset inside the tile and nothing has to be re-derived.
const SVG_CARTRIDGE =
  '<path class="g-body" d="M8 0c2.6 3.4 4 6.2 4 9.4V16l2 3v26H2V19l2-3V9.4C4 6.2 5.4 3.4 8 0Z"/>' +
  '<path class="g-hi" d="M0 45h16v5H0z"/>' +
  '<path class="g-hi" d="M4.2 6h1.5v39H4.2z"/>' +
  '<path class="g-mid" d="M11 19h2.6v26H11z"/>';
const SVG_AMMO =
  '<svg viewBox="0 0 34 50" aria-hidden="true">' +
  "<g>" + SVG_CARTRIDGE + "</g>" +
  '<g transform="translate(18 0)">' + SVG_CARTRIDGE + "</g>" +
  "</svg>";
// Frag box glyph: HudElements1 (0,128,128,64), the skull on the LEFT of the
// tile. Measured, not remembered: ink bbox cols 8..39 / rows 9..56 of the
// 128x64 tile (so it leaves cols 40..127 for the digits, which is exactly where
// DrawBigNum's X + 40 S origin puts them). Inside it, cranium widest at rows
// 20..21, two slanted sockets at cols 12..19 / 27..34 rows 22..30, a nasal
// cavity rows 32..37, bright cheekbones either side of it, an upper tooth arc
// rows 38..47 and a jaw rows 48..56 that is the brightest thing in the glyph.
// The sockets and the nasal cavity are DARKER than the tile's own fill, so
// under the screen blend they read as the world showing through.
// The viewBox is the ink bbox; CSS places it at the measured offset.
const SVG_SKULL =
  '<svg viewBox="0 0 32 48" aria-hidden="true">' +
  // cranium -> zygomatic arch -> jaw
  '<path class="g-body" d="M16 0C8.2 0 2 5.6 2 13.4c0 3.6.4 6.4 1.5 8.9l1.1 2.6' +
  "c.4 1 .7 2.1.8 3.2l.5 5.1c.3 2.9 1.9 5.4 4.3 6.8l.4.2v4.9c0 1.5 1.2 2.7 2.7 2.7" +
  'h5.4c1.5 0 2.7-1.2 2.7-2.7V40.2l.4-.2c2.4-1.4 4-3.9 4.3-6.8l.5-5.1' +
  'c.1-1.1.4-2.2.8-3.2l1.1-2.6C29.6 19.8 30 17 30 13.4 30 5.6 23.8 0 16 0Z"/>' +
  // brow ridges: the two bright patches over the sockets
  '<path class="g-hi" d="M3.1 8.6C5 6.5 8 5.1 11.7 4.6l.7 3.9c-3 .5-5.4 1.7-6.8 3.4z"/>' +
  '<path class="g-hi" d="M28.9 8.6C27 6.5 24 5.1 20.3 4.6l-.7 3.9c3 .5 5.4 1.7 6.8 3.4z"/>' +
  // cheekbones, either side of the nasal cavity
  '<path class="g-hi" d="M3.4 23.2 10 25.4l-.6 5.4-4.6-1.5-1-3.7z"/>' +
  '<path class="g-hi" d="M28.6 23.2 22 25.4l.6 5.4 4.6-1.5 1-3.7z"/>' +
  // the jaw is the brightest band in the tile
  '<path class="g-hi" d="M10.4 40.4h11.2v3.6H10.4z"/>' +
  // sockets, nasal cavity, tooth gaps: all darker than the tile fill
  '<path class="g-hole" d="M4.2 14.4l6.6-.9c.8-.1 1.5.5 1.5 1.3l-.2 4.6' +
  'c0 .7-.5 1.3-1.2 1.4l-4.9.9c-.8.2-1.6-.4-1.7-1.2l-.5-4.6c-.1-.7.4-1.4 1.1-1.5Z"/>' +
  '<path class="g-hole" d="M27.8 14.4l-6.6-.9c-.8-.1-1.5.5-1.5 1.3l.2 4.6' +
  'c0 .7.5 1.3 1.2 1.4l4.9.9c.8.2 1.6-.4 1.7-1.2l.5-4.6c.1-.7-.4-1.4-1.1-1.5Z"/>' +
  '<path class="g-hole" d="M16 21.5l3.4 7.5h-6.8Z"/>' +
  '<path class="g-hole" d="M9.5 30.4h.8v7h-.8zM12.3 30.4h.8v7h-.8z' +
  "M15.1 30.4h.8v7h-.8zM17.9 30.4h.8v7h-.8zM20.7 30.4h.8v7h-.8z" +
  'M8 37.2h16v.9H8z"/>' +
  "</svg>";
// The weapon in a slot. Both looks come from the same path: the HELD slot draws
// W.StatusIcon (UseAutoM) in SOLID BLACK inside an opaque tinted box, every
// other slot draws the same weapon as the 1-texel ghost OUTLINE the HUDWeapons
// cell carries at 0.5 * HUDColor. CSS picks fill or stroke, so there is one
// shape, not two.
//
// Traced off UseAutoM: the black texels run cols 40..108 / rows 8..42 of the
// 128x64 tile, so the viewBox below IS that ink bbox at 1 unit per texel. The
// grip hangs off the left of the receiver, the magazine block off the right,
// and there is one enclosed light rectangle between them (cols 56..65, rows
// 22..27) which is why the path is filled even-odd.
const ENFORCER_PATH =
  "M7 0 64 0 67 1 68 2 68 28 67 29 67 30 65 31 65 32 44 32 44 34 30 34 30 32 " +
  "28 32 28 29 27 22 26 21 13 21 13 29 12 30 10 30 3 29 2 28 4 20 4 19 6 14 " +
  "6 13 5 12 3 11 0 10 0 8 1 4 3 1Z M16 14 26 14 26 20 16 20Z";
const SVG_ENFORCER =
  '<svg viewBox="0 0 69 35" aria-hidden="true">' +
  '<path fill-rule="evenodd" d="' + ENFORCER_PATH + '"/>' +
  "</svg>";
// Dual Enforcers: the same profile twice, the second offset down and right,
// which is how the original tells the pair apart from the single at slot size.
const SVG_ENFORCER_DUAL =
  '<svg viewBox="0 0 69 35" aria-hidden="true">' +
  '<g transform="translate(0 -1) scale(0.8)">' +
  '<path fill-rule="evenodd" d="' + ENFORCER_PATH + '"/></g>' +
  '<g transform="translate(13.8 6) scale(0.8)">' +
  '<path fill-rule="evenodd" d="' + ENFORCER_PATH + '"/></g>' +
  "</svg>";
// Ghost outlines for the nine groups this build does not ship. The HUDWeapons
// cell for EVERY group carries a 1-texel outline of that group's weapon plus a
// small caret, drawn at 0.5 * HUDColor — an unowned slot is a dim box WITH a
// silhouette in it, never a blank rectangle, and that is what stops the empty
// bar reading as ten identical panels. These are schematic profiles on the same
// 69 x 35 ink bbox the Enforcer uses, stroked (not filled) by
// `.ut-wslot__icon svg path`, so at ~10% alpha they read as a faint wireframe.
// Each ends with the caret the cell art carries under the muzzle.
const GHOST_CARET = " M60 30 64 34 68 30";
/**
 * Wrap a ghost profile in the shared 69 x 35 ink-bbox viewBox.
 * @param {string} d profile path data, in texels of the HUDWeapons cell
 * @returns {string} an <svg> string
 */
function ghost(d) {
  return (
    '<svg viewBox="0 0 69 35" aria-hidden="true">' +
    '<path d="' + d + GHOST_CARET + '"/>' +
    "</svg>"
  );
}
// 1 Impact Hammer   piston head, collar, grip block, shaft
const GHOST_HAMMER = ghost("M2 3h16v26H2Z M18 9h10v14H18Z M28 6h9v20h-9Z M37 13h30v7H37Z");
// 3 Bio Rifle       tank over a stubby body, short fat muzzle
const GHOST_BIO = ghost("M10 1h20v7H10Z M4 8h32v20H4Z M36 13h16v9H36Z M52 10h15v15H52Z");
// 4 Shock Rifle     long slim barrel, boxed breech, grip
const GHOST_SHOCK = ghost("M2 13h42v9H2Z M44 8h10v19H44Z M54 14h13v7H54Z M8 22h11v11H8Z");
// 5 Pulse Gun       broad receiver, vented barrel, grip
const GHOST_PULSE = ghost("M3 9h34v16H3Z M37 5h9v24h-9Z M46 12h21v11H46Z M9 25h10v9H9Z");
// 6 Ripper          disc magazine on top of a flat body
const GHOST_RIPPER = ghost("M2 10h30v15H2Z M46 1h12v12H46Z M32 6h13v23H32Z M45 13h22v9H45Z");
// 7 Minigun         three barrels off a drum
const GHOST_MINIGUN = ghost("M2 8h18v20H2Z M20 10h20v16H20Z M40 8h27v5H40Z M40 15h27v5H40Z M40 22h27v5H40Z");
// 8 Flak Cannon     hopper, breech, flared muzzle
const GHOST_FLAK = ghost("M3 5h25v24H3Z M28 10h16v15H28Z M44 3h10v29H44Z M54 9h13v17H54Z");
// 9 Rocket Launcher two stacked tubes and a block sight
const GHOST_ROCKET = ghost("M2 4h46v11H2Z M2 17h46v11H2Z M48 6h19v21H48Z M14 0h14v4H14Z");
// 0 Sniper Rifle    long barrel, scope over the receiver, stock
const GHOST_SNIPER = ghost("M2 14h32v9H2Z M34 12h33v5H34Z M20 3h22v6H20Z M14 23h11v10H14Z");
// 2 Enforcer        the group this build owns: the same profile as the icon,
// so an emptied slot 2 still shows the weapon it wants back.
const GHOST_ENFORCER = ghost(ENFORCER_PATH);

// CTF flag icon — I_Home / I_Capt / I_Down redrawn to the texel geometry in the
// exact spec (§4.8). One 32x32 icon carrying all three interiors; `data-flag` on
// the row picks which one is visible, so the state change costs no DOM work.
//
//   pole    cols 1..2, rows 3..31, lum 61 (0.24), a lum 99 cap texel at row 3
//   frame   1-texel outline of cols 1..30 x rows 6..24, lum 128 (0.50), with a
//           3-texel left post and the col-7 divider that cuts the inner panel
//   cloth   lum 99 (0.39) when home, lum 61 (0.24) when held or down
//   I_Capt  a lum 128 "!" — block cols 15..20 rows 9..17, dot cols 16..19 rows 20..22
//   I_Down  a lum 128 arrow — shaft cols 16..20 rows 10..13, head cols 11..25 at
//           row 14 narrowing to col 18 at row 21
//
// Drawn at 64 S = 5 vw square in TeamColor (255,0,0) / (0,128,255), translucent.
const SVG_FLAG =
  '<svg viewBox="0 0 32 32" shape-rendering="crispEdges" aria-hidden="true">' +
  '<rect class="ut-flag__pole" x="1" y="4" width="2" height="27"/>' +
  '<rect class="ut-flag__cap" x="1" y="3" width="2" height="1"/>' +
  '<rect class="ut-flag__cloth" x="1" y="6" width="29" height="18"/>' +
  '<rect class="ut-flag__frame" x="1.5" y="6.5" width="28" height="17"/>' +
  '<rect class="ut-flag__post" x="1" y="6" width="3" height="18"/>' +
  '<rect class="ut-flag__post" x="7" y="9" width="1" height="13"/>' +
  '<g class="ut-flag__mark ut-flag__mark--capt">' +
  '<rect x="15" y="9" width="6" height="9"/>' +
  '<rect x="16" y="20" width="4" height="3"/>' +
  "</g>" +
  '<g class="ut-flag__mark ut-flag__mark--down">' +
  '<rect x="16" y="10" width="5" height="4"/>' +
  '<path d="M11 14h15l-7.5 7z"/>' +
  "</g>" +
  "</svg>";

// The paper doll — `Icons.Man`, a 128 x 256 texture drawn at 128S x 256S in the
// top-right corner, i.e. 10vw x 20vw with its right edge on the screen edge.
// This is a REDRAW to the measured geometry of the original, not a trace:
//
//   figure bbox   x 8..104, y 8..197 of the 128x256 tile
//   head 8..30 (visor gap 19..21), pauldrons 28..46 spanning cols 18..90,
//   torso 32..96 tapering 60 -> 34 wide, belt 96..104, thighs 104..148,
//   shins 148..180, boots 180..197 flaring to 20 wide each
//
// Material: fill lum 90 (.35), a 4-texel-pitch wireframe grid at lum 138 (.54)
// over the whole fill, and a 2-texel lum 255 outline with the panel lines. The
// same silhouette is drawn three times — fill, grid, outline — from one <defs>
// group so the three layers can never drift apart.
const DOLL_BODY =
  // helmet + visor brow + neck
  '<path d="M54 12q0-4 10-4t10 4v14l-4 4H58l-4-4z"/>' +
  '<path d="M60 30h8v5h-8z"/>' +
  // pauldrons
  '<path d="M46 30 22 34l-4 10 4 6 22-2z"/>' +
  '<path d="M82 30l24 4 4 10-4 6-22-2z"/>' +
  // torso
  '<path d="M34 32h60l-8 64H42z"/>' +
  // upper arms out to the elbows, forearms in to the hips
  '<path d="M20 46l18 2-2 28-14 2z"/>' +
  '<path d="M108 46l-18 2 2 28 14 2z"/>' +
  '<path d="M22 78l14-2 16 24-6 8z"/>' +
  '<path d="M106 78l-14-2-16 24 6 8z"/>' +
  // belt
  '<path d="M42 96h44v8H42z"/>' +
  // thighs, shins, boots
  '<path d="M44 104h18v44H46z"/>' +
  '<path d="M84 104H66v44h16z"/>' +
  '<path d="M46 148h16l-2 32H48z"/>' +
  '<path d="M82 148H66l2 32h12z"/>' +
  '<path d="M44 180h18v17H42z"/>' +
  '<path d="M84 180H66v17h20z"/>';
const SVG_DOLL =
  // viewBox min-x 8: the figure is NOT centred in the tile. Its bbox is
  // x 8..104 of 128, i.e. 8 texels of margin on the left and 24 on the right,
  // so the whole drawing is shifted 8 texels left of centre.
  '<svg viewBox="8 0 128 256" aria-hidden="true">' +
  "<defs>" +
  '<g id="ut-doll-fig">' + DOLL_BODY + "</g>" +
  '<pattern id="ut-doll-grid" width="4" height="4" patternUnits="userSpaceOnUse">' +
  '<path d="M0 0.5H4M0.5 0V4"/>' +
  "</pattern>" +
  "</defs>" +
  '<use href="#ut-doll-fig" class="ut-doll__fill"/>' +
  '<use href="#ut-doll-fig" class="ut-doll__grid"/>' +
  '<use href="#ut-doll-fig" class="ut-doll__edge"/>' +
  // panel lines: visor slot, chest plate edge, knee line
  '<g class="ut-doll__panel">' +
  '<path d="M56 18h16v4H56z"/>' +
  '<path d="M40 40h48v2H40z"/>' +
  '<path d="M46 148h36v2H46z"/>' +
  "</g>" +
  // Chest armour overlay: `Man` sub-rect (128,0,128,64) drawn at HUDColor times
  // min(ChestAmount/100, 1). hud-root writes --ut-chest; at 0 it is invisible.
  '<g class="ut-doll__plate">' +
  '<path d="M34 32h60l-6 30H40z"/>' +
  '<path d="M46 30 26 34l-2 8 20-2z"/>' +
  '<path d="M82 30l20 4 2 8-20-2z"/>' +
  "</g>" +
  "</svg>";

// Weapon bar. UT99 draws TEN fixed slots, keys 1-9 then 0, edge to edge between
// the frag box and the ammo box. Only weapons you actually carry are drawn AS
// weapons — a slot number, a black silhouette and a yellow ammo bar. This build
// ships the Enforcer, so slot 2 is the only owned one; the other nine stay the
// faint empty cells the original leaves for weapons you do not have, which is
// what keeps the bar the right shape. Add a weapon and it claims its own slot.
// `icon` is the weapon as it is drawn when you OWN the group; `ghost` is the
// 1-texel outline the cell art carries when you do not. Every slot has a ghost.
const WEAPON_SLOTS = [
  { key: "1", name: "Impact Hammer", icon: null, ghost: GHOST_HAMMER },
  { key: "2", name: "Enforcer", icon: SVG_ENFORCER, ghost: GHOST_ENFORCER },
  { key: "3", name: "Bio Rifle", icon: null, ghost: GHOST_BIO },
  { key: "4", name: "Shock Rifle", icon: null, ghost: GHOST_SHOCK },
  { key: "5", name: "Pulse Gun", icon: null, ghost: GHOST_PULSE },
  { key: "6", name: "Ripper", icon: null, ghost: GHOST_RIPPER },
  { key: "7", name: "Minigun", icon: null, ghost: GHOST_MINIGUN },
  { key: "8", name: "Flak Cannon", icon: null, ghost: GHOST_FLAK },
  { key: "9", name: "Rocket Launcher", icon: null, ghost: GHOST_ROCKET },
  { key: "0", name: "Sniper Rifle", icon: null, ghost: GHOST_SNIPER },
];
const ACTIVE_SLOT = 1; // index into WEAPON_SLOTS

let instance = null;
let refCount = 0;

/**
 * Build (or return) the HUD singleton. Call release() for each getHud().
 *
 * @param {object} game the engine handle (core/main.js): the bus is game.events and the
 *   weapon is the registered "first-person-weapon" system.
 * @returns {object} the HUD facade
 */
export function getHud(game) {
  if (!instance) instance = createHud(game);
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
// BigNumbers — HudElements1 rows 0..63.
//
// Seven-segment, but NOT an LCD: the atlas is masked, so the unlit segments are
// simply not in the texture. There are no ghost bars anywhere on this HUD. Each
// digit is a 25 x 64 texel CELL carrying a 22 x 36 glyph at the TOP of it, so
// the number's ink sits 36S below the DrawBigNum origin and the bottom 28S of
// every cell is empty.
//
// Every digit still renders all seven segment elements; CSS hides the ones
// without `.is-on`, and a fully blank cell is removed from the flow entirely
// (DrawBigNum draws nothing at all for a leading blank — see makeNumber).
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
  d.classList.add("is-blank"); // nothing is drawn until show() lights it
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
      // A blank leading cell is not drawn AND takes no space: DrawBigNum skips
      // leading zeros by advancing CurX, which makeNumber reproduces as the
      // field-start padding, so a blank cell must be out of the flow entirely.
      d.classList.toggle("is-blank", ch === null);
      // DrawDigit kerns a "1" by 0.625 * Step instead of 0.25 * Step — 6S
      // further left than any other digit, which is why "100" reads tighter
      // than "800". The cell still advances the same 28S afterwards.
      d.classList.toggle("is-one", ch === 1);
      // Atlas mode picks the HudElements1 digit cell off this attribute.
      if (ch === null) delete d.dataset.d;
      else d.dataset.d = String(ch);
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
      // DrawBigNum walks hundreds -> tens -> ones and adds `Step = 16 * UpScale`
      // for every leading position it skips, so the field START moves 16S right
      // for each digit the number does NOT have: -4S for three digits, +12S for
      // two, +28S for one (16S twice, then the first digit's own -4S). The
      // number is therefore neither left- nor right-aligned in its box.
      wrap.style.paddingLeft =
        "calc(" + 16 * (3 - text.length) + " * var(--ut-s))";
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

/**
 * One status tile — DrawStatus's armour and health boxes.
 *
 * Both are the SAME 128x64 HudElements1 tile art (a grid box with a 3-texel
 * border) with their glyph baked into the right 30%, drawn flush on top of each
 * other at X = W - 128*StatScale - 140*Scale. There is no gap and no divider
 * between them: each tile carries its own border, so the seam reads as a double
 * rule. The digits are a separate DrawBigNum pass at (X + 4S, Y + 16S), which is
 * why `.ut-vital__art` — the box and the glyph — is its own layer: below 50
 * health the tile ramps and the digits do not ramp with it.
 *
 * @param {string} modifier
 * @param {string} svg the glyph, in its own texel viewBox
 * @param {HTMLElement} parent
 */
function makeVitalTile(modifier, svg, parent) {
  const el = div(`ut-vital ${modifier}`, parent);
  const art = div("ut-tile ut-vital__art", el);
  const glyph = div("ut-vital__glyph", art);
  glyph.innerHTML = svg;
  const num = makeNumber("ut-num--vital", 3);
  el.appendChild(num.el);
  return { el, art, num };
}

/**
 * The frag box: UT99's score readout. Skull glyph on the left, a two-cell
 * seven-segment count beside it, in its own tinted box at the bottom-left
 * corner — NOT a captioned chip in the top corner. There is no label; the
 * skull is the label.
 * @returns {{el: HTMLElement, num: {set: (v: number) => void}}}
 */
function makeFragBox() {
  const el = div("ut-frags ut-box");
  div("ut-frags__flash", el);
  const glyph = div("ut-frags__skull", el);
  glyph.innerHTML = SVG_SKULL;
  // Four cells, because DrawBigNum has no width limit and a CTF Score is frags
  // plus capture bonuses. Leading cells that are not used draw nothing AND take
  // no room — the field start is what positions the number.
  const num = makeNumber("ut-num--frags", 4);
  el.appendChild(num.el);
  return { el, num };
}

/**
 * One weapon slot. Ten of these sit between the frag box and the ammo box.
 * An owned slot carries a yellow seven-segment slot number in the top-left, a
 * solid black weapon silhouette and a yellow ammo bar along the bottom edge; an
 * unowned slot is an empty tinted cell at a fraction of the alpha.
 * @param {{key: string, icon: string|null, ghost: string|null}} w
 * @returns {{el: HTMLElement, icon: HTMLElement, ammo: HTMLElement|null}}
 */
function makeWeaponSlot(w) {
  // NOT a .ut-box: a slot is the HUDWeapons 64x32 cell scaled 2x, which is a
  // different piece of art from the 128x64 corner tiles — a vertical ramp with
  // its own 1-texel border, not a flat fill with a 3-texel one.
  const el = div("ut-wslot");
  div("ut-wslot__bracket", el);
  const icon = div("ut-wslot__icon", el);
  let ammo = null;
  // An UNOWNED slot is not empty: the HUDWeapons cell for that group carries a
  // 1-texel ghost outline of its weapon at 0.5 * HUDColor. Draw it, or the bar
  // reads as ten blank rectangles.
  if (!w.icon && w.ghost) icon.innerHTML = w.ghost;
  if (w.icon) {
    el.classList.add("is-owned");
    icon.innerHTML = w.icon;
    const key = div("ut-wslot__key", el);
    makeDigit(key).show(Number(w.key));
    ammo = div("ut-wslot__ammo", el);
  }
  return { el, icon, ammo };
}

export function createHud(game) {
  if (!game || !game.events || !game.systems) {
    throw new Error("createHud: needs the engine handle (game.events, game.systems) — see core/main.js getHud(game)");
  }
  ensureFont();

  // ---- the two things this DOM module needs from the scene ----
  //
  // The HUD is DOM and stays DOM; these are its only two touch points: the event bus
  // (game.events) and the held weapon (the registered first-person-weapon system).
  const busOn = (name, handler) => game.events.on(name, handler);
  const busOff = (name, handler) => game.events.off(name, handler);
  const findWeapon = () => game.systems.get("first-person-weapon") || null;

  const root = div("ut-hud");
  root.id = "ut-hud";
  // Atlas mode: the CSS under `.ut-hud--atlas` masks every glyph, digit, box,
  // weapon cell and the doll out of the original UT99 textures instead of the
  // SVG/CSS recreations built below. The DOM is the same either way.
  if (GAME_CONFIG.HUD && GAME_CONFIG.HUD.ATLAS) root.classList.add("ut-hud--atlas");

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

  // ---- top right: armour over health, doll on the corner ----
  // DrawStatus, in S = ClipX/1280 = 0.078125vw:
  //   doll   (W - 128S, 0)   128 x 256   -> right 0,        top 0
  //   shield (W - 268S, 0)   128 x  64   -> right 10.9375vw, top 0
  //   cross  (W - 268S, 64S) 128 x  64   -> right 10.9375vw, top 5vw
  // i.e. a 12S gap between the boxes and the doll, and NO gap between the two
  // boxes. All three are bottom-of-the-atlas tiles drawn with STY_Translucent,
  // which is a screen blend, not an alpha wash.
  const vitalsBay = div("ut-vitals-bay", root);

  const armor = makeVitalTile("ut-vital--armor", SVG_ARMOR, vitalsBay);
  const health = makeVitalTile("ut-vital--health", SVG_HEALTH, vitalsBay);

  const doll = div("ut-doll", vitalsBay);
  doll.innerHTML = SVG_DOLL;
  // ChallengeHUD.SetDamage parks up to four minus-sign tiles ON the doll where
  // you were hit and clears them after a second. This is the whole of UT99's
  // damage feedback on the HUD — there is no screen vignette and no health
  // tint anywhere in ChallengeHUD.
  const dollHits = div("ut-doll__hits", doll);

  const hint = div("ut-hint", root);
  hint.innerHTML = '<kbd>TAB</kbd><span>SCORES</span>';

  // ---- bottom edge: frag box | ten weapon slots | ammo box ----
  // Not a strip. UT99 lays three separate tinted islands along the bottom edge
  // and lets the world show between the empty slots; the score lives in the
  // left-hand one, which is why the frag chip that used to sit top-left is gone.
  const bar = div("ut-bar", root);

  const frags = makeFragBox();
  bar.appendChild(frags.el);

  const weaponBar = div("ut-weapons", bar);
  const built = WEAPON_SLOTS.map((w, i) => {
    const slot = makeWeaponSlot(w);
    if (i === ACTIVE_SLOT) slot.el.classList.add("is-active");
    weaponBar.appendChild(slot.el);
    return slot;
  });
  const slots = built.map((s) => s.el);
  const activeSlot = built[ACTIVE_SLOT];

  // Far right: DrawAmmo. One 128 S x 64 S tile whose bullets glyph is part of
  // the tile art (cols 87..120), not a separate disc beside a plate, with
  // DrawBigNum(AmmoAmount, X + 4 S, Y + 16 S) in white over it.
  const ammoBay = div("ut-ammo-bay ut-box", bar);
  const ammoGlyph = div("ut-ammo-bay__bullets", ammoBay);
  ammoGlyph.innerHTML = SVG_AMMO;
  const ammoNum = makeNumber("ut-num--ammo", 4);
  ammoBay.appendChild(ammoNum.el);
  const ammo = { row: ammoBay, num: ammoNum };

  // ---- CTF: team scores and flag status, right edge, mid height ----
  // ChallengeCTFHUD.DrawTeam, not a stacked panel: for each team the score
  // digits sit at (W-144S, H-336S-150S*i) and the flag icon at (W-70S,
  // H-350S-150S*i), team 0 (RED) on the LOWER row and team 1 (BLUE) above it.
  // Both are absolutely placed against the viewport, so the row element only
  // exists to carry `data-flag` for the icon state.
  //
  // The whole block is hidden by CSS unless the document carries a team —
  // network.js sets html[data-team] only when the server puts you on one, i.e.
  // only in CTF — so DM never sees it.
  const flags = div("ut-flags", root);
  const flagRows = {};
  for (const team of ["red", "blue"]) {
    const row = div(`ut-flagrow ut-flagrow--${team}`, flags);
    const num = makeNumber("ut-num--flag", 2);
    row.appendChild(num.el);
    const icon = div("ut-flag", row);
    icon.innerHTML = SVG_FLAG;
    row.dataset.flag = "home";
    num.set(0);
    flagRows[team] = { row, num };
  }

  // ---- CTF carry banners (bottom centre, CTFMessage2) ----
  // CTFMessage2 has Lifetime 1 and ChallengeCTFHUD.Timer re-sends it every
  // second while the condition holds, with bFadeMessage — so it PULSES: full
  // brightness on the second, fading linearly to black before the next one.
  // switch 0 is yellow at H - 2*YL - 0.0833H, switch 1 red at H - 3*YL - 0.0833H,
  // i.e. the red line sits one line ABOVE the yellow one.
  const ctfBanner = div("ut-ctfmsg", root);
  const ctfEnemyLine = div("ut-ctfmsg__line ut-ctfmsg__line--enemy", ctfBanner);
  ctfEnemyLine.textContent = "The enemy has your flag, recover it!";
  const ctfMineLine = div("ut-ctfmsg__line ut-ctfmsg__line--mine", ctfBanner);
  ctfMineLine.textContent = "You have the flag, return to base!";

  // ---- centre message (CriticalEventPlus family) ----
  // Everything the LocalMessage path puts on screen mid-height lands here: at
  // 0.2552 * H, big font, (0,128,255) unless the message class overrides it to
  // red, and a LINEAR fade of DrawColor * remaining/Lifetime over the full 3 s.
  // No fade-in, no scale punch — the announcement is at full strength on frame
  // one and only ever gets dimmer.
  const centerMsg = div("ut-center", root);

  // ---- match end ----
  // The winner line itself is a normal 3 s centre message ("Red team is the
  // winner!"); this is the standing card underneath it that holds the final
  // score up until the server's match-reset, which the transient message cannot.
  const matchEnd = div("ut-matchend", root);

  // ---- message rail (top left) ----
  // ChallengeHUD's four-line message area: SetPos(6, 2 + YL*line), plain bitmap
  // sans at 10/14/16 px by ClipX, 3 s lifetime, left aligned, no animation.
  // Death lines are (255,0,0), Say/TeamSay (0,255,0), pickups and everything
  // else white. DrawSpeechArea's faint hue backdrop fades in behind them.
  const msgRail = div("ut-msgs", root);
  div("ut-msgs__back", msgRail);
  const msgList = div("ut-msgs__list", msgRail);


  // ---- CTF state ----
  const MSG_LIFETIME = 3000;
  const flagState = { red: "home", blue: "home" };
  let myTeam = null;
  let carriedByMe = null; // the team colour of the flag ON MY BACK, or null
  let centerTimer = 0;
  const msgTimers = [];

  function teamName(t) {
    return t === "red" ? "Red" : t === "blue" ? "Blue" : "";
  }

  /**
   * Push one line onto the top-left rail.
   * @param {string} text
   * @param {"death"|"chat"|"pickup"} [kind] picks the colour; default white.
   */
  function pushMessage(text, kind) {
    if (!text) return;
    const line = div(`ut-msgs__line ut-msgs__line--${kind || "pickup"}`, msgList);
    line.textContent = text;
    // Four lines total, oldest dropped — the source keeps a fixed four-slot
    // array and overwrites the top of it.
    while (msgList.children.length > 4) msgList.removeChild(msgList.firstChild);
    msgRail.classList.add("is-on");
    const t = setTimeout(() => {
      if (line.parentNode) line.remove();
      if (!msgList.children.length) msgRail.classList.remove("is-on");
      const i = msgTimers.indexOf(t);
      if (i > -1) msgTimers.splice(i, 1);
    }, MSG_LIFETIME);
    msgTimers.push(t);
  }

  /**
   * Centre message at 0.2552 H.
   * @param {string} text
   * @param {"team"|"red"} [tone] (0,128,255) or (255,0,0)
   */
  function showCenterMessage(text, tone) {
    if (!text) return;
    centerMsg.textContent = text;
    centerMsg.dataset.tone = tone === "red" ? "red" : "team";
    // Restart the linear fade. bIsUnique messages sharing an offset replace each
    // other, which is exactly what re-running the animation on one element does.
    centerMsg.classList.remove("is-on");
    void centerMsg.offsetWidth;
    centerMsg.classList.add("is-on");
    clearTimeout(centerTimer);
    centerTimer = setTimeout(() => centerMsg.classList.remove("is-on"), MSG_LIFETIME);
  }

  function setTeamScores(a, b) {
    // Accepts either setTeamScores({red, blue}) — the server's own vocabulary —
    // or the legacy positional setTeamScores(blue, red).
    let blue = b;
    let red = a;
    if (a && typeof a === "object") {
      red = a.red;
      blue = a.blue;
    } else {
      blue = a;
      red = b;
    }
    if (typeof blue === "number") flagRows.blue.num.set(blue);
    if (typeof red === "number") flagRows.red.num.set(red);
  }

  /**
   * @param {"red"|"blue"} team
   * @param {"home"|"carried"|"dropped"} state the SERVER's vocabulary, which is
   *   also the source's: bHome -> I_Home, bHeld -> I_Capt, else I_Down.
   */
  function setFlagState(team, state) {
    const row = flagRows[team];
    if (!row) return;
    const s = state === "carried" || state === "dropped" ? state : "home";
    flagState[team] = s;
    row.row.dataset.flag = s;
    paintBanner();
  }

  // The two bottom-centre lines are pure functions of the flag states: you have
  // the enemy flag if one is on your back, they have yours if the flag whose
  // team is yours is being carried.
  function paintBanner() {
    ctfMineLine.classList.toggle("is-on", carriedByMe !== null);
    ctfEnemyLine.classList.toggle(
      "is-on",
      myTeam !== null && flagState[myTeam] === "carried"
    );
  }

  function setLocalTeam(team) {
    myTeam = team === "red" || team === "blue" ? team : null;
    paintBanner();
  }

  // ---- scene wiring ----
  // network.js emits every CTF fact on the a-scene, never on document, and the
  // names/payloads below are its, not ours: `ctf-init` {flags, scores, myTeam},
  // `local-team` {team}, `flag-update` {team, state, event, byName, byTeam,
  // isMine}, `ctf-score` {scores:{red,blue}}, `match-end` {winner, scores},
  // `match-reset`.
  const onCtfInit = (e) => {
    const d = (e && e.detail) || {};
    if (d.myTeam !== undefined) setLocalTeam(d.myTeam);
    if (d.scores) setTeamScores(d.scores);
    carriedByMe = null;
    for (const f of d.flags || []) setFlagState(f.team, f.state);
    root.classList.remove("is-matchover");
    paintBanner();
  };

  const onLocalTeam = (e) => {
    setLocalTeam(((e && e.detail) || {}).team);
  };

  const onFlagUpdate = (e) => {
    const d = (e && e.detail) || {};
    if (!d.team) return;
    // Who is carrying what has to settle BEFORE the banner is painted.
    if (d.isMine && d.state === "carried") carriedByMe = d.team;
    else if (carriedByMe === d.team) carriedByMe = null;
    setFlagState(d.team, d.state);

    // CTFMessage strings (§6). The flag's own colour names the flag; the actor's
    // team names the scorer.
    const flagWord = teamName(d.team).toLowerCase();
    const who = d.byName || "";
    switch (d.event) {
      case "taken":
        showCenterMessage(
          who ? `${who} has the ${flagWord} flag!` : `The ${flagWord} flag was taken!`
        );
        break;
      case "dropped":
        showCenterMessage(
          who
            ? `${who} dropped the ${flagWord} flag!`
            : `The ${flagWord} flag was dropped!`
        );
        break;
      case "returned":
        showCenterMessage(
          who
            ? `${who} returns the ${flagWord} flag!`
            : `The ${flagWord} flag was returned!`
        );
        break;
      case "captured":
        showCenterMessage(
          `${who || "Someone"} captured the ${flagWord} flag!  ` +
            `The ${teamName(d.byTeam).toLowerCase() || "enemy"} team scores!`
        );
        break;
      default:
        break; // "reset" is silent; the match-reset card covers it
    }
  };

  const onCtfScore = (e) => {
    const d = (e && e.detail) || {};
    setTeamScores(d.scores || d);
  };

  const onMatchEnd = (e) => {
    const d = (e && e.detail) || {};
    if (d.scores) setTeamScores(d.scores);
    const s = d.scores || { red: 0, blue: 0 };
    matchEnd.textContent = `Red ${s.red || 0}  -  Blue ${s.blue || 0}`;
    root.classList.add("is-matchover");
    showCenterMessage(`${teamName(d.winner)} team is the winner!`);
  };

  const onMatchReset = () => {
    root.classList.remove("is-matchover");
    carriedByMe = null;
    paintBanner();
  };

  // The CTF feed, off game.events.
  busOn("ctf-init", onCtfInit);
  busOn("local-team", onLocalTeam);
  busOn("flag-update", onFlagUpdate);
  busOn("ctf-score", onCtfScore);
  busOn("match-end", onMatchEnd);
  busOn("match-reset", onMatchReset);

  // ---- damage vignette ----
  const vignette = div("ut-vignette", root);

  // ---- PlayerPawn.ClientInstantFlash ----
  // Not a HUD element at all in UT99 — it is an ENGINE fog, a flat tint blended over the
  // whole rendered view for the frame a weapon fires and gone again immediately after.
  // Botpack gives each weapon a scale and an RGB (Enforcer: -0.2 with a warm
  // 0.325/0.225/0.095), and the tint is what makes a shot light the screen without a
  // muzzle LIGHT existing anywhere in the scene.
  //
  // `screen` blend rather than an alpha wash, because the fog ADDS: a dark room brightens
  // and a bright one barely moves, which is the behaviour you want from a gun flash.
  //
  // THE DEVIATION: UE1 drops the flash back toward zero over the next few frames on its
  // own schedule, which is frame-rate dependent and not worth reproducing. This is a flat
  // 0.1 s LINEAR fade — long enough to survive a 60 Hz frame, short enough to still read
  // as a single flash rather than a glow.
  //
  // ---- Engine.Weapon.RenderOverlays' muzzle flash ----
  // A 2D CANVAS ICON, drawn by Canvas.DrawIcon(MFTexture, MuzzleScale) in Style 3
  // (STY_Translucent, i.e. black is transparent — a screen blend), NOT a quad in the
  // world and NOT a point light. Only the Enforcer and the Sniper Rifle have one at all;
  // Shock, Rocket, Ripper and Redeemer have none, so most weapons never call this.
  //
  // ---- and why BOTH of these are body children, not children of `root` ----
  //
  // `.ut-hud` is `position: fixed; z-index: 900`, which makes it a STACKING CONTEXT, and
  // a stacking context is exactly what mix-blend-mode cannot see out of: a `screen` blend
  // inside it would composite against the HUD's own transparent background instead of
  // against the rendered game, and the muzzle texture's black field — the part that is
  // supposed to disappear — would stay black. So both live beside the HUD in the root
  // stacking context, where their backdrop is the game canvas (<canvas id="game">).
  //
  // At z-index 899 they sit UNDER the whole HUD, which is also the order UE1 draws them
  // in: PlayerPawn.PostRender runs Weapon.RenderOverlays first and the HUD paints on top.
  //
  // `display: block !important` is set INLINE and never changed, which is why hiding
  // the flash below uses `visibility`, not `display`.
  const LAYER =
    "position:fixed;pointer-events:none;z-index:899;mix-blend-mode:screen;";

  // Styled inline rather than from styles.css on purpose: these two elements have no
  // states, no breakpoints and no theme, and every value on them is written per shot.
  const instFlash = document.createElement("div");
  instFlash.className = "ut-inst-flash";
  instFlash.style.cssText = LAYER + "inset:0;opacity:0;background:#000;";
  instFlash.style.setProperty("display", "block", "important");
  document.body.appendChild(instFlash);

  const muzzle = document.createElement("img");
  muzzle.className = "ut-muzzle";
  muzzle.alt = "";
  muzzle.decoding = "async";
  muzzle.style.cssText =
    LAYER +
    "left:0;top:0;visibility:hidden;" +
    // The source art is a 128px UT99 texture shown at up to 2x on a 1280 viewport; a
    // smooth upscale turns a hard flash into a smudge.
    "image-rendering:pixelated;";
  muzzle.style.setProperty("display", "block", "important");
  document.body.appendChild(muzzle);

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
  let muzzleTimer = 0;
  let fragTimer = 0;
  let lastFrags = 0;

  function paintHealth() {
    health.num.set(Math.max(0, hp));
    // NO colour bands, no threshold hues, no doll tint. Under 50 the cross TILE
    // (box and glyph together, `.ut-vital__art`) goes white and ramps 100% ->
    // 25% every half second, and the digits run their own 100% -> 50% -> 62.5%
    // sawtooth on the same clock. Both are pure brightness: the hue never
    // moves and neither ever switches off. Above 50 nothing animates.
    health.el.classList.toggle("is-low", hp > 0 && hp < LOW_HEALTH);
    delete doll.dataset.level;
  }

  function paintAmmo() {
    // UT99's HUD carries no weapon-name text, so reloading is shown by blinking
    // the ammo readout (.is-reloading in styles.css) rather than by a label the
    // original never had. The digits hold at 0 while it blinks.
    ammo.num.set(reloading ? 0 : mag);
    ammo.row.classList.toggle("is-reloading", reloading);
    ammo.row.dataset.level = reloading || mag <= 10 ? "crit" : "ok";
    paintSlotAmmo();
  }

  // The held slot carries its own ammo bar along its bottom edge, as a fraction
  // of a full magazine. It is the same count the ammo box shows, drawn the way
  // the original draws it per slot.
  function paintSlotAmmo() {
    if (!activeSlot.ammo) return;
    // AmmoScale = clamp(88 * WeapScale * ammo/max, 0, 88) -> 0..70.4 S = 0..5.5vw
    // of the slot, NOT a percentage of the slot's own width.
    const pct = MAG_SIZE > 0 ? Math.max(0, Math.min(1, mag / MAG_SIZE)) : 0;
    activeSlot.ammo.style.width = (pct * 5.5).toFixed(3) + "vw";
  }

  function paintArmor(v) {
    // DrawBigNum(Min(150, Armor)) — the box clamps, and a 0 is drawn in the
    // same full white as any other value. It is never dimmed.
    const n = Math.max(0, Math.round(v));
    armor.num.set(Math.min(150, n));
    // The doll's chest plate is drawn at HUDColor * Min(ChestAmount/100, 1), so
    // the figure brightens as you pick armour up. Body Armor is the only
    // armour on CTF-Face, and it maps to ChestAmount.
    doll.style.setProperty("--ut-chest", String(Math.min(1, n / 100)));
  }

  // ---- doll damage markers ----------------------------------------------
  // SetDamage sizes each marker by HitDamage = Clamp(dmg * 0.06, 2, 4) and
  // draws the HudElements1 minus tile (0,64,25,64) at HitPos * StatScale. The
  // real HitPos comes from the hit direction, which the HUD is not told here,
  // so the four canonical body positions are cycled instead.
  const HIT_POS = [
    [40, 44],
    [70, 44],
    [46, 108],
    [66, 108],
  ];
  let hitIndex = 0;
  function dollHit(damage) {
    const d = Math.max(2, Math.min(4, (damage || 20) * 0.06));
    const spot = HIT_POS[hitIndex % HIT_POS.length];
    hitIndex++;
    const dash = document.createElement("i");
    dash.className = "ut-dash";
    // the minus glyph is cols 2..17, rows 16..21 of the 25x64 cell
    dash.style.left = `calc(${(spot[0] + 2 * d).toFixed(2)} * var(--ut-s))`;
    dash.style.top = `calc(${(spot[1] + 16 * d).toFixed(2)} * var(--ut-s))`;
    dash.style.width = `calc(${(15 * d).toFixed(2)} * var(--ut-s))`;
    dash.style.height = `calc(${(6 * d).toFixed(2)} * var(--ut-s))`;
    dollHits.appendChild(dash);
    // four markers live at a time, one second each, exactly as SetDamage keeps
    // them
    while (dollHits.childElementCount > 4) dollHits.firstChild.remove();
    setTimeout(() => dash.remove(), 1000);
  }

  // ---- local shot detection ----
  // first-person-weapon owns firing and stamps `lastFireTime` on every LOCAL
  // shot. The scene's `bullet-fired` event is no good here: network.js emits it for
  // remote players' shots too (it draws their hits), so it would drain your magazine
  // when someone else shoots. Reading the component's own stamp is a one-property
  // compare per frame and needs no change to the fire path.
  let rafId = 0;
  let lastSeenFire = 0;
  let fpw = null;
  function watchLocalShots() {
    rafId = requestAnimationFrame(watchLocalShots);
    if (!fpw) {
      fpw = findWeapon();
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

  // requestAnimationFrame is parked while the tab is hidden (so is the game's own
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
  // The frag box is drawn in CTF too (bHideFrags is false and ChallengeCTFHUD
  // does not override DrawFragCount), so it starts at a real 0, not blank.
  frags.num.set(0);

  return {
    root,

    setHealth(current, max) {
      if (typeof max === "number" && max > 0) hpMax = max;
      hp = current;
      paintHealth();
    },

    setArmor: paintArmor,

    setFrags(n) {
      const v = Math.max(0, Math.round(n || 0));
      // A kill flashes the whole box gold for half a second — the one place
      // UT99 puts a warm colour outside the weapon bar.
      if (v > lastFrags) {
        frags.el.classList.remove("is-scored");
        void frags.el.offsetWidth;
        frags.el.classList.add("is-scored");
        clearTimeout(fragTimer);
        // DrawFragCount holds the flash for 3 s (Whiten < 3.0), not half a one.
        fragTimer = setTimeout(() => frags.el.classList.remove("is-scored"), 3000);
      }
      lastFrags = v;
      frags.num.set(v);
    },

    /** Swap the held weapon's silhouette. "dual" is the Enforcer pair, which
     *  UT99 gives its own two-pistol icon in the same slot. */
    setWeapon(kind) {
      activeSlot.icon.innerHTML =
        kind === "dual" ? SVG_ENFORCER_DUAL : SVG_ENFORCER;
    },

    /** CTF hooks. Normally driven straight off the scene events above; these
     *  stay public so a test or a replay can poke the same state. No-ops in DM:
     *  the rows are hidden unless html[data-team] is set. */
    setTeamScores,
    setFlagState,
    setLocalTeam,

    /** One line on the top-left rail. kind: "death" (red), "chat" (green) or
     *  "pickup" (white, the default). */
    pushMessage,

    /** One line at 0.2552 H. tone: "team" (0,128,255) or "red". */
    showCenterMessage,

    /** Damage feedback. On the HUD itself UT99 draws only the doll markers —
     *  red minus signs where you were hit, one second each; the red wash the
     *  original has is PlayerPawn.ClientFlash, an engine fog, not ChallengeHUD. */
    damageFlash() {
      vignette.classList.remove("is-on");
      void vignette.offsetWidth;
      vignette.classList.add("is-on");
      clearTimeout(vignetteTimer);
      vignetteTimer = setTimeout(() => vignette.classList.remove("is-on"), 140);

      // The doll does not blink and does not change colour: it collects a red
      // minus marker where you were hit, for one second (ChallengeHUD.SetDamage).
      dollHit(20);
    },

    /**
     * PlayerPawn.ClientInstantFlash(scale, fog) — the one-frame screen tint a weapon
     * throws when it fires. See the element's own comment for the blend and the fade.
     * @param {number} scale strength; UT99 ships these NEGATIVE (the Enforcer is -0.2),
     *   so only the magnitude is used.
     * @param {number[]} fog RGB in 0..1 — the manifest has already applied Epic's x0.001.
     */
    instantFlash(scale, fog) {
      const strength = Math.min(1, Math.abs(Number(scale) || 0));
      if (!(strength > 0)) return;
      const c = Array.isArray(fog) ? fog : [1, 1, 1];
      const ch = (v) => Math.max(0, Math.min(255, Math.round((Number(v) || 0) * 255)));
      // Snap on with no transition, then let the next frame animate it back down — the
      // same remove/reflow/add shape the vignette uses, because a CSS transition will not
      // restart on an element that is already at the target value.
      instFlash.style.transition = "none";
      instFlash.style.background = `rgb(${ch(c[0])},${ch(c[1])},${ch(c[2])})`;
      instFlash.style.opacity = String(strength);
      void instFlash.offsetWidth;
      instFlash.style.transition = "opacity 100ms linear";
      instFlash.style.opacity = "0";
    },

    /**
     * Engine.Weapon.RenderOverlays' muzzle icon.
     *
     * @param {string} textureUrl one of the weapon's MFTexture PNGs (the Enforcer picks
     *   among five at random per shot; that choice is the caller's).
     * @param {number} screenX centre, CSS px from the left of the viewport
     * @param {number} screenY centre, CSS px from the top
     * @param {number} sizePx FlashS * MuzzleScale * (viewportWidth / 640)
     * @param {number} seconds FlashLength — 0.02 for the Enforcer, i.e. sub-frame
     */
    muzzleFlash(textureUrl, screenX, screenY, sizePx, seconds) {
      if (!textureUrl || !(sizePx > 0)) return;
      if (muzzle.getAttribute("src") !== textureUrl) muzzle.setAttribute("src", textureUrl);
      muzzle.style.width = `${sizePx}px`;
      muzzle.style.height = `${sizePx}px`;
      // transform rather than left/top: this moves every shot and a transform stays off
      // the layout path.
      muzzle.style.transform = `translate(${Math.round(screenX - sizePx / 2)}px,${Math.round(
        screenY - sizePx / 2
      )}px)`;
      muzzle.style.visibility = "visible";
      clearTimeout(muzzleTimer);
      // FlashLength is 0.02 s — one frame at 50 Hz and LESS than one at 60, so a literal
      // timeout would sometimes hide the flash before a frame ever drew it. Floored at
      // ~two frames, which is the shortest thing a 60 Hz display can actually show.
      muzzleTimer = setTimeout(() => {
        muzzle.style.visibility = "hidden";
      }, Math.max((Number(seconds) || 0) * 1000, 34));
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
      busOff("ctf-init", onCtfInit);
      busOff("local-team", onLocalTeam);
      busOff("flag-update", onFlagUpdate);
      busOff("ctf-score", onCtfScore);
      busOff("match-end", onMatchEnd);
      busOff("match-reset", onMatchReset);
      clearTimeout(centerTimer);
      while (msgTimers.length) clearTimeout(msgTimers.pop());
      clearTimeout(reloadTimer);
      clearTimeout(vignetteTimer);
      clearTimeout(muzzleTimer);
      clearTimeout(fragTimer);
      // Both of these are body children rather than children of root (see their comment
      // above), so root.remove() does not take them with it.
      if (instFlash.parentNode) instFlash.remove();
      if (muzzle.parentNode) muzzle.remove();
      if (root.parentNode) root.remove();
      instance = null;
    },
  };
}
