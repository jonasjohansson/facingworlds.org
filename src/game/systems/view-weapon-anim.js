// view-weapon-anim.js — UT99's view-mesh animation states, over a THREE.AnimationMixer.
//
// UE1 view weapons are not rigged; they are VERTEX animations, a table of whole-mesh poses
// the engine tweens between. scripts/build-ut-viewmodels.mjs bakes each named sequence out
// as a glTF morph-target clip with the sequence's own name ("Select", "Shoot", "Sway",
// "Twiddle", "Down", ...), so what a weapon class calls
//
//     PlayAnim('Shoot', 0.81)      one shot, at 0.81x the sequence's authored rate
//     LoopAnim('Sway', 0.2)        the idle, looping at a fifth speed
//     PlayAnim('Select')           bring-up, with the class's SelectSound
//
// becomes one clipAction here with `timeScale` set to Epic's rate multiplier. That is the
// whole mapping: UnrealScript's rate IS a time scale, and the clips are authored at their
// sequence's native fps, so nothing else has to be converted.
//
// TRANSITIONS ARE HARD CUTS, deliberately. UE1's PlayAnim replaces the playing sequence
// outright — there is no blend unless the script asks for TweenAnim, and none of the six
// weapons does on these transitions. Crossfading would look smoother and would be wrong;
// the snap between Sway and Shoot is a large part of why UT99 weapons read as fast.
//
// This module owns NO placement: where the gun sits, how big it is and which way it faces
// are first-person-weapon.js's business. It only decides which pose the mesh is in.

import * as THREE from "three";

/**
 * @param {object} root the loaded glTF model root (assets.attachModel's `root`)
 * @param {Array} clips the clips that came with it (root.animations)
 * @param {object|null} anims the weapon manifest's `view.anims` block, or null
 * @param {() => number} [random]
 */
export function createViewAnim(root, clips, anims, random = Math.random) {
  if (!root) return null;

  const mixer = new THREE.AnimationMixer(root);
  const cache = new Map();

  // Every mesh under the root that carries morph targets. Needed because
  // stopAllAction() leaves the LAST EVALUATED weights on the mesh — stopping the idle
  // without this would freeze the gun mid-Sway rather than returning it to the base pose.
  const morphs = [];
  root.traverse((o) => {
    if (o.isMesh && o.morphTargetInfluences) morphs.push(o);
  });

  /** The mesh's authored rest pose — UE1's 'Still' frame, every weight at zero. */
  function restPose() {
    for (let i = 0; i < morphs.length; i++) {
      const w = morphs[i].morphTargetInfluences;
      for (let j = 0; j < w.length; j++) w[j] = 0;
    }
  }

  function actionFor(name) {
    if (!name) return null;
    if (cache.has(name)) return cache.get(name);
    const clip = clips && clips.length ? THREE.AnimationClip.findByName(clips, name) : null;
    const action = clip ? mixer.clipAction(clip) : null;
    cache.set(name, action);
    return action;
  }

  let current = null; // the action that is playing, or null for the rest pose
  let currentKind = "none"; // "select" | "fire" | "idle" | "fidget" | "down" | "none"
  let firing = false; // a LoopAnim'd fire clip is running (Shock, Ripper)

  /**
   * PlayAnim / LoopAnim. `spec` is {clip, rate, tween} straight out of the manifest.
   *
   * `tween` is PlayAnim's TweenTime: UE1 blends from the pose the mesh is in to the new
   * sequence's first frame over that many seconds, and nearly every call site passes one
   * (0.02-0.05 s into a fire clip, up to 0.5 s into an idle). A hard cut is what UE1 does
   * when it is 0 — the Redeemer's PlayAnim('Fire', 0.3) — and what this did for everything
   * before, which put a measured 95 px snap at the start of every Shock Rifle burst.
   *
   * three.js expresses the same thing as a crossfade: the outgoing action fades out while
   * the new one fades in, and since both are one-hot morph weights the mesh passes through
   * the in-between pose exactly as UE1's tween does. Nothing else may be running during
   * it, or the fade blends three poses instead of two.
   */
  function play(spec, kind, loop) {
    if (!spec) return false;
    const action = actionFor(spec.clip);
    if (!action) return false;

    const tween = typeof spec.tween === "number" && spec.tween > 0 ? spec.tween : 0;
    // "The pose the mesh is in" includes a one-shot that has finished and is holding its
    // last frame (clampWhenFinished below), which is what UE1 tweens from when the idle
    // follows a fire. A paused action still fades: fades are driven by the mixer's clock.
    const from =
      current && current !== action && current.enabled && current.getEffectiveWeight() > 0
        ? current
        : null;
    for (const a of cache.values()) if (a && a !== action && a !== from) a.stop();
    if (!from) restPose();

    action.reset();
    action.timeScale = typeof spec.rate === "number" && spec.rate > 0 ? spec.rate : 1;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    // UE1 holds the LAST frame of a finished sequence until something else plays: the
    // Redeemer, which has no idle at all, simply stays where 'Fire' left it. With this
    // false the mesh snapped back to its rest pose the instant a fire clip ended.
    action.clampWhenFinished = true;
    action.enabled = true;
    if (from && tween > 0) {
      // crossFadeTo fades `from` out and `action` in over the tween, weights summing to 1.
      from.crossFadeTo(action, tween, false);
      action.play();
    } else {
      if (from) from.stop();
      action.setEffectiveWeight(1);
      action.play();
    }

    current = action;
    currentKind = kind;
    return true;
  }

  /** Back to whatever this weapon does when nothing is happening. */
  function idle() {
    firing = false;
    if (anims && anims.idle && play(anims.idle, "idle", anims.idle.loop !== false)) return;
    // No idle sequence (the Redeemer; TournamentWeapon.PlayIdleAnim is empty). Whatever
    // one-shot just finished keeps holding its last frame, as in UE1; only a looping fire
    // that was stopped has to be put down, and it lands on the rest pose.
    if (current && current.loop === THREE.LoopRepeat) {
      current.stop();
      restPose();
      current = null;
    }
    currentKind = "none";
  }

  mixer.addEventListener("finished", (e) => {
    if (e.action !== current) return;
    // Select and the one-shot fires both hand back to the idle; so does the fidget. This
    // is where 'Shoot' ends and 'Sway' picks up again, which is the whole loop for five of
    // the six weapons.
    idle();
  });

  mixer.addEventListener("loop", (e) => {
    if (e.action !== current || currentKind !== "idle") return;
    // Enforcer: LoopAnim('Sway', 0.2) with a 4% chance of one 'Twiddle' at each loop end.
    // The chance is per LOOP, not per second, which is why it hangs off this event.
    const f = anims && anims.idleFidget;
    if (!f) return;
    const chance = typeof f.chance === "number" ? f.chance : 0;
    if (random() < chance) play(f, "fidget", false);
  });

  return {
    /** Bring-up. The SelectSound is the caller's business; this is only the mesh. */
    select() {
      if (!(anims && anims.select && play(anims.select, "select", false))) idle();
    },

    /**
     * One shot. UT99 picks at random among the fire sequences a weapon has (the Enforcer
     * has one, the Ripper alternates), so the manifest ships an ARRAY and this picks.
     */
    fire() {
      const list = anims && Array.isArray(anims.fire) ? anims.fire : null;
      if (!list || !list.length) return;
      const spec = list[Math.floor(random() * list.length) % list.length];

      if (anims.fireLoops) {
        // Shock and Ripper LoopAnim while the trigger is down. Re-triggering every shot
        // would restart the loop mid-swing, so an already-running loop is left alone.
        if (firing && currentKind === "fire") return;
        firing = play(spec, "fire", true);
        return;
      }
      play(spec, "fire", false);
    },

    /** The trigger came up (or the shots stopped) on a looping-fire weapon. */
    stopFire() {
      if (firing) idle();
    },

    /** True while a looped fire animation is running, so the caller knows to stop it. */
    isLoopingFire: () => firing,

    // There is deliberately no down(). UT99 plays 'Down' and waits for it to finish
    // before swapping weapons; this build swaps the moment the server says so, and
    // dressSlot swaps the mesh in the same call — so a Down pose would have no frames to
    // be seen in. See dressSlot() in first-person-weapon.js.

    idle,

    /** Drive the mixer. dt in SECONDS. */
    update(dt) {
      mixer.update(dt);
    },

    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
      cache.clear();
      restPose();
    },
  };
}
