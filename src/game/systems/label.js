// label.js — world-space text, drawn on a canvas and hung in the scene as a Sprite.
//
// Two things used to draw text over a body, in two different ways:
//
//   health.js      an A-Frame `text` entity (an MSDF mesh) plus `look-at="[camera]"`,
//                  turned to face the camera by a component that ran every frame.
//   ar/three/players.js  a 256x64 canvas redrawn on a name change, on a THREE.Sprite.
//
// A Sprite is always camera-facing by construction — the renderer builds its model-view
// matrix from the camera, so there is nothing to update per frame and no look-at
// component to get wrong (the A-Frame one read the CAMERA ENTITY's rotation, which is
// why the sprites in this scene needed getWorldQuaternion to point the right way at all).
// So there is one implementation now, and it is the canvas one: no font atlas to load, no
// MSDF shader, and the plate/outline that makes a name readable over a bright map texture
// is three canvas calls rather than a second mesh.
//
// One canvas + one texture per label, redrawn only when the text or the colour changes.
// Sprites do not receive light, which is what both callers wanted anyway.
import * as THREE from "three";

export const LABEL_DEFAULTS = {
  // Canvas pixels. 256x64 is what the AR view has used since the labels landed; it is
  // one 64 KB texture per player and stays sharp to about 4 m on a 1080p screen.
  canvasWidth: 256,
  canvasHeight: 64,
  // World width of the sprite, in metres. The height follows from the canvas aspect, so
  // the drawing is never stretched.
  widthM: 1.8,
  color: "#ffffff",
  // The dark rounded plate behind the text (names). Numbers over a body read better
  // without it — see health.js, which draws an outline instead.
  plate: true,
  font: "600 28px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  // Longer text is cut rather than shrunk: a 40-character name must not turn every other
  // name on screen into a smear.
  maxChars: 16,
  // Sprites are unlit and normally want to be hidden by geometry in front of them — a
  // name behind a tower should be behind the tower. Off for anything that has to stay
  // visible through the body it is attached to.
  depthTest: true,
  opacity: 1,
  // Where the sprite sits above its parent's origin, in metres.
  y: 0,
};

/**
 * A camera-facing text sprite. `opts` overrides LABEL_DEFAULTS.
 * The sprite owns its canvas and texture (userData.label); dispose with
 * disposeLabelSprite when the body goes away.
 */
export function makeLabelSprite(text, opts = {}) {
  const o = { ...LABEL_DEFAULTS, ...opts };
  const canvas = document.createElement("canvas");
  canvas.width = o.canvasWidth;
  canvas.height = o.canvasHeight;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // No mipmaps: the label is redrawn in place and a mip chain would have to be rebuilt
  // with it. LinearFilter alone is what the AR labels have always used.
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  // SpriteMaterial.sizeAttenuation is LEFT AT ITS DEFAULT (true) on purpose: it is what
  // makes `scale` mean metres in the world rather than a fraction of the screen, so the
  // label shrinks with distance exactly as the world-space text mesh it replaces did.
  // Turning it off would peg every name and every HP number at one on-screen size, which
  // is a HUD, not a label over a body 60 m across the map.
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: o.depthTest,
    opacity: o.opacity,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(o.widthM, (o.widthM * o.canvasHeight) / o.canvasWidth, 1);
  sprite.position.y = o.y;
  // Labels are chrome, not geometry: they must never be picked up by a raycast against
  // the world or by a shadow pass.
  sprite.castShadow = false;
  sprite.receiveShadow = false;
  sprite.raycast = () => {};

  sprite.userData.label = { canvas, texture, opts: o, text: null, color: null };
  drawLabel(sprite, text, o.color);
  return sprite;
}

/** Redraw a label. A no-op when neither the text nor the colour changed. */
export function updateLabelSprite(sprite, text, color) {
  const state = sprite && sprite.userData && sprite.userData.label;
  if (!state) return;
  drawLabel(sprite, text, color || state.color || state.opts.color);
}

/** Free the canvas texture and the sprite material. The caller removes the node. */
export function disposeLabelSprite(sprite) {
  const state = sprite && sprite.userData && sprite.userData.label;
  if (!state) return;
  state.texture.dispose();
  sprite.material.dispose();
  sprite.userData.label = null;
}

function drawLabel(sprite, text, color) {
  const state = sprite.userData.label;
  const o = state.opts;
  const str = String(text == null ? "" : text).slice(0, o.maxChars);
  if (state.text === str && state.color === color) return;
  state.text = str;
  state.color = color;

  const canvas = state.canvas;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (o.plate) {
    // Dark plate, so a light name stays readable over the bright map textures. The
    // border carries the colour (the team's); the text stays white.
    ctx.fillStyle = "rgba(6, 10, 16, 0.72)";
    roundedRect(ctx, 4, 10, w - 8, h - 20, 10);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.font = o.font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (o.plate) {
    ctx.fillStyle = "#ffffff";
    ctx.fillText(str, w / 2, h / 2 + 1, w - 24);
  } else {
    // No plate: a dark outline does the same job in a third of the pixels, which is what
    // a two- or three-digit number over a body needs.
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.lineWidth = Math.max(2, Math.round(h * 0.09));
    ctx.strokeStyle = "rgba(6, 10, 16, 0.85)";
    ctx.strokeText(str, w / 2, h / 2, w - 8);
    ctx.fillStyle = color;
    ctx.fillText(str, w / 2, h / 2, w - 8);
  }

  state.texture.needsUpdate = true;
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
