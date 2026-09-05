// remote-fire-state.js — when a remote pawn is "shooting", as UT99's TournamentPlayer means it.
//
// UT99 does not have a fire animation that plays on top of a run. It has a SECOND SET OF
// LOCOMOTION SEQUENCES: for every movement sequence there is an identical one authored
// with the arms up and the weapon levelled, named with an FR suffix — 'RunSM' becomes
// 'RunSMFR', 'WalkSM' becomes 'WalkSMFR'. TournamentPlayer.PlayFiring writes
//
//     if (bIsWalking) AnimSequence = 'WalkSMFR'; else AnimSequence = 'RunSMFR';
//
// straight over the sequence that was already playing, at the frame it had reached, and
// PlayWaiting puts the plain one back when the trigger comes up. A pawn standing still
// gets PlayRecoil instead — an 8 frame one-shot over the standing pose.
//
// So there are exactly two decisions per frame, and they are mutually exclusive:
//
//   recoil      the body is standing: play the one-shot 'Fire' over the idle
//   locomotion  the body is moving: swap Walk/Run for WalkFire/RunFire
//
// Both are held for HOLD_MS after the LAST shot rather than being edge-triggered, because
// a client only ever sees discrete shots. The trigger being down is not on the wire; a
// stream of `fire` messages 250 ms apart (the Enforcer's own cadence) is. Holding for
// half a second means a burst reads as one continuous firing pose instead of flickering
// back to the idle between rounds, and a single shot still returns to normal promptly.
//
// This is a pure function with no THREE, no DOM and no config import so it can be tested
// on its own — see server/test/remote-fire-state.test.mjs. remote-avatar.js is the only
// consumer; it turns these two booleans into which action each blend weight drives.

/**
 * How long after a shot the firing pose is held, in ms.
 *
 * 500 ms is two Enforcer shots' worth of cadence (fireRate 4/s) plus slack, and it is
 * also about the length of UT99's own PlayRecoil (8 frames at 15 fps = 533 ms), so the
 * standing recoil finishes at almost exactly the moment the hold lets go of it.
 */
export const FIRE_HOLD_MS = 500;

/**
 * How long a shot counts as a REPEAT of the one before it, in ms.
 *
 * The Enforcer view mesh has two fire sequences: 'Shoot' for a shot out of the blue and
 * 'shot2' for the follow-ups, and UT99 picks between them on exactly this test. The
 * third-person AutoHand carries the same pair.
 */
export const FIRE_REPEAT_MS = 400;

/**
 * @param {number} now       monotonic ms (performance.now())
 * @param {number} lastShot  when this pawn last fired, same clock; 0/NaN for "never"
 * @param {boolean} moving   is the body walking or running right now
 * @param {number} [holdMs]  override for FIRE_HOLD_MS
 * @returns {{firing: boolean, recoil: boolean, locomotion: boolean}}
 */
export function fireState(now, lastShot, moving, holdMs = FIRE_HOLD_MS) {
  // `dt >= 0` rejects a shot stamped in the future, which is what a clock that went
  // backwards looks like — better a missed animation than one stuck on for ever.
  const dt = now - lastShot;
  const firing = Number.isFinite(lastShot) && lastShot > 0 && dt >= 0 && dt < holdMs;
  return {
    firing,
    recoil: firing && !moving,
    locomotion: firing && !!moving,
  };
}

/**
 * Which of a weapon's own fire sequences to play for this shot.
 *
 * `anims` is the third-person manifest block, `{ fire: [{clip, rate}], fireRepeat }`, and
 * every part of it is optional — a weapon whose held model has no animation at all
 * returns null and the caller simply does not play anything.
 *
 * @param {object|null} anims
 * @param {number} sinceLastShotMs  ms since the previous shot, Infinity for the first
 * @param {() => number} [random]
 * @returns {{clip: string, rate?: number}|null}
 */
export function pickFireClip(anims, sinceLastShotMs, random = Math.random) {
  if (!anims) return null;
  // UT99's Enforcer: the second and later shots of a burst use the shorter 'shot2', which
  // is why an Enforcer emptied at full cadence looks like a stutter rather than a series
  // of separate draws.
  if (anims.fireRepeat && sinceLastShotMs < FIRE_REPEAT_MS) return anims.fireRepeat;
  const list = Array.isArray(anims.fire) ? anims.fire : null;
  if (!list || !list.length) return null;
  // An ARRAY because a weapon can have several (the Ripper alternates); UT99 picks at
  // random among them, and so does the first-person path in view-weapon-anim.js.
  return list[Math.floor(random() * list.length) % list.length] || list[0];
}
