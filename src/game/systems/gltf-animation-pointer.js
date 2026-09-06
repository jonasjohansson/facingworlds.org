// gltf-animation-pointer.js — the map's own glTF animation clips, on their own mixer.
//
// KHR_animation_pointer clips ride in FacingWorlds_tex_5.glb; GLTFLoader parses them into
// ordinary AnimationClips, so all this needs is a mixer of its own, kept off the character
// mixers so the map's timeline never interferes with a soldier's.
//
// Two things to know before touching the weights:
//
//  - The A-Frame component this replaces read its clips from
//    `this.el.components["gltf-model"].data.animations`, and gltf-model's schema is a
//    plain model string — `data.animations` was always undefined, so it logged
//    "No animations found" and never built a mixer at all. The clips are passed in
//    properly here, but they are still bound at effective weight 0, exactly as the old
//    code asked for, so the visible result is unchanged. Raise a weight through
//    setWeight(i, w) to actually see a clip.
//  - assets-optimized/3d/map/FacingWorlds_tex_5.glb currently carries ZERO clips (check
//    with `npm run inspect:assets`), so today this takes the empty branch either way. It
//    stays because the map is regenerated from source by scripts/optimize-assets.mjs and
//    the clips are a property of that pipeline, not of this file.
import * as THREE from "three";

const DEFAULTS = {
  enabled: true,
  autoPlay: true,
  loop: true,
  speed: 1.0,
};

export class GltfAnimationPointer {
  constructor(game, root, animations, opts = {}) {
    this.game = game;
    this.opts = { ...DEFAULTS, ...opts };
    this.mixer = null;
    this.actions = [];

    if (!root || !animations || animations.length === 0) {
      console.log("[gltf-animation-pointer] No animations found in model");
      return;
    }

    this.mixer = new THREE.AnimationMixer(root);

    for (const clip of animations) {
      const action = this.mixer.clipAction(clip);
      action.setLoop(this.opts.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      action.enabled = true;
      action.setEffectiveTimeScale(this.opts.speed);
      action.setEffectiveWeight(0);
      if (this.opts.autoPlay) action.play();
      this.actions.push(action);
    }

    console.log(`[gltf-animation-pointer] Loaded ${animations.length} animations`);
  }

  play() {
    for (const action of this.actions) action.play();
  }

  pause() {
    for (const action of this.actions) action.pause();
  }

  stop() {
    for (const action of this.actions) action.stop();
  }

  setWeight(index, weight) {
    if (this.actions[index]) this.actions[index].setEffectiveWeight(weight);
  }

  setTimeScale(index, timeScale) {
    if (this.actions[index]) this.actions[index].setEffectiveTimeScale(timeScale);
  }

  /** The component owned a private THREE.Clock; the loop hands out the delta now. */
  update(dt) {
    if (this.mixer && this.opts.enabled) this.mixer.update(dt);
  }

  dispose() {
    if (!this.mixer) return;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
    this.mixer = null;
    this.actions.length = 0;
  }
}
