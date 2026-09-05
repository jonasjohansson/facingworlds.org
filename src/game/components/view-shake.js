// view-shake.js — Epic's PlayerPawn.ShakeView / ClientShake / ViewShake, ported.
//
// This is the ONLY recoil UT99 has. There is no aim kick anywhere in the engine: firing
// never moves ViewRotation.Pitch or .Yaw, so the crosshair does not drift and a shot you
// lined up is the shot you take. What a weapon does instead is call
//
//     PlayerPawn.ShakeView(shaketime, RollMag, vertmag)
//
// which arms a purely COSMETIC oscillation — the view ROLLS around the aim axis and the
// eye jitters vertically — that decays on its own and never touches where the trace goes.
// The previous build had it backwards: it kicked the AIM (a pitch/yaw impulse written
// straight into look-controls, plus a synthetic rotation kick on the weapon model) and
// left the view level, which is a modern-shooter behaviour Epic's code never had. Both of
// those constants are gone from GAME_CONFIG.WEAPON along with the code that read them.
//
// ---------------------------------------------------------------------------
// UNITS
// ---------------------------------------------------------------------------
// Roll is a UE1 ROTATOR component: a 16-bit fixed-point angle where 65536 units is a full
// turn, stored unsigned, so 65486 means -50 (about -0.27 deg). Everything below keeps the
// integer rotator so the comparisons against 32768, 1.3*shakemag and 65536 - 1.3*shakemag
// are Epic's own comparisons rather than a re-derivation in radians.
//
// ShakeVert is in UNREAL UNITS of eye displacement, converted here at UT99 PAWN scale
// (0.0235 m/UU — src/shared/map-transform.js), which is the scale this game's rig and
// avatars are built at. A TournamentWeapon's default vert of 5 UU is therefore ~11.7 cm
// of eye movement, which is genuinely large; that is what the engine does, and it is over
// inside a tenth of a second.
//
// ---------------------------------------------------------------------------
// THE ONE THING THAT IS NOT EPIC'S
// ---------------------------------------------------------------------------
// When shaketimer runs out UT99 walks ViewRotation.Roll back to level. The exact per-frame
// step it uses is not reproduced here; instead the roll decays LINEARLY at
// ROLL_DECAY_UU_PER_SEC, chosen so a full excursion at the TournamentWeapon default
// (1.3 * 300 = 390 units) unwinds in about 0.2 s. Everything above this line is Epic's.
//
// No THREE, no DOM, no A-Frame: this module is pure arithmetic so server/test can run it
// with an injected random and assert the numbers instead of eyeballing the screen.
import { UU_TO_M } from "../../shared/map-transform.js";

/** A full turn in UE1 rotator units. */
export const ROTATION_UNITS = 65536;

/**
 * Botpack.TournamentWeapon's own ShakeView arguments, used when a weapon's manifest
 * carries no `shake` block of its own. Every stock weapon that does not override
 * ShakeView gets exactly this.
 */
export const DEFAULT_SHAKE = { time: 0.1, mag: 300, vert: 5 };

/** See "THE ONE THING THAT IS NOT EPIC'S" above. Rotator units per second. */
export const ROLL_DECAY_UU_PER_SEC = 1950;

/**
 * @param {() => number} [random] stand-in for UnrealScript's FRand(), injectable for tests.
 * @returns {{
 *   clientShake: (x: number, y: number, z: number) => void,
 *   shakeView: (time: number, rollMag: number, vertMag: number) => void,
 *   tick: (dt: number) => void,
 *   reset: () => void,
 *   rollUU: () => number, rollRad: () => number,
 *   vertUU: () => number, vertM: () => number,
 *   active: () => boolean, magnitude: () => number,
 * }}
 */
export function createViewShake(random = Math.random) {
  // Epic's names, kept verbatim so the port can be read against the .uc side by side.
  let shakemag = 0; // rotator units of roll amplitude
  let shaketimer = 0; // seconds of shaking left
  let maxshake = 0; // UU of vertical amplitude
  let verttimer = 0; // seconds until the next vertical re-roll
  let shakeVert = 0; // UU of vertical eye offset, the value the camera reads
  let roll = 0; // ViewRotation.Roll, an integer rotator component
  let bShakeDir = false; // true = roll is currently increasing

  /**
   * PlayerPawn.ClientInstantFlash's sibling: the only way to arm a shake.
   *
   * The guard is what makes shakes compose instead of stacking. A NEW shake is only
   * accepted if it is stronger than what is already running, or if what is running has
   * less time left than the new one asks for — so a rocket landing next to you is not
   * quietly cancelled by your own pistol shot half a frame later.
   */
  function clientShake(x, y, z) {
    if (shakemag < x || shaketimer <= 0.01 * y) {
      shakemag = x;
      shaketimer = 0.01 * y;
      maxshake = 0.01 * z;
      verttimer = 0;
      shakeVert = -1.1 * maxshake;
    }
  }

  /**
   * PlayerPawn.ShakeView. The x100s are Epic's: ClientShake takes hundredths, so the
   * caller's seconds and UU are multiplied up here and divided back down there.
   */
  function shakeView(time, rollMag, vertMag) {
    clientShake(rollMag, 100 * time, 100 * vertMag);
  }

  /** ViewRotation.Roll as a SIGNED rotator value, i.e. 65486 read back as -50. */
  function signedRoll() {
    const r = ((roll % ROTATION_UNITS) + ROTATION_UNITS) % ROTATION_UNITS;
    return r < ROTATION_UNITS / 2 ? r : r - ROTATION_UNITS;
  }

  /**
   * PlayerPawn.ViewShake(DeltaTime), called once per rendered frame.
   *
   * The roll is a hunted oscillation rather than a sine: it runs in one direction at
   * 10 * shakemag units per second (capped at a 0.1 s step so a frame hitch cannot fling
   * it), turns around when it passes a RANDOM threshold between 0.5x and 1.5x shakemag,
   * is hard-clamped at 1.3x shakemag, and additionally has a 3*dt chance per frame of
   * reversing for no reason at all. That randomness is why two shots never look alike.
   *
   * Note `roll` is deliberately allowed to go NEGATIVE inside a frame and is masked back
   * into 0..65535 at the top of the next one — that is exactly what the UnrealScript does
   * (`ViewRotation.Roll &= 65535`), and the "> 32768" tests below only make sense once
   * that masking has happened, which is why the clamp can overshoot by one step.
   */
  function tick(dt) {
    if (!(dt > 0)) dt = 0;

    if (shaketimer > 0) {
      shaketimer -= dt;

      // Vertical. One jolt DOWN (-1.1 * maxshake) when the shake is armed, held for
      // 0.1 s, then a fresh random offset in +/-maxshake every 0..0.2 s.
      if (verttimer === 0) {
        verttimer = 0.1;
        shakeVert = -1.1 * maxshake;
      } else {
        verttimer -= dt;
        if (verttimer < 0) {
          verttimer = 0.2 * random();
          shakeVert = (2 * random() - 1) * maxshake;
        }
      }

      roll &= ROTATION_UNITS - 1;
      const step = Math.trunc(10 * shakemag * Math.min(0.1, dt));

      if (bShakeDir) {
        roll += step;
        bShakeDir = roll > 32768 || roll < (0.5 + random()) * shakemag;
        if (roll < 32768 && roll > 1.3 * shakemag) {
          roll = Math.trunc(1.3 * shakemag);
          bShakeDir = false;
        } else if (random() < 3 * dt) {
          bShakeDir = !bShakeDir;
        }
      } else {
        roll -= step;
        bShakeDir = roll < 32768 && roll > ROTATION_UNITS - (0.5 + random()) * shakemag;
        if (roll > 32768 && roll < ROTATION_UNITS - 1.3 * shakemag) {
          roll = Math.trunc(ROTATION_UNITS - 1.3 * shakemag);
          bShakeDir = true;
        } else if (random() < 3 * dt) {
          bShakeDir = !bShakeDir;
        }
      }
    } else {
      shaketimer = 0;
      shakemag = 0;
      maxshake = 0;
      verttimer = 0;
      shakeVert = 0;

      // The deviation documented at the top of the file: a plain linear unwind.
      let signed = signedRoll();
      if (signed !== 0) {
        const d = ROLL_DECAY_UU_PER_SEC * dt;
        signed = signed > 0 ? Math.max(0, signed - d) : Math.min(0, signed + d);
        // Below one rotator unit there is nothing left to see (1/65536 of a turn), and
        // stopping here is what keeps the decay from creeping forever at tiny dt.
        roll = Math.abs(signed) < 1 ? 0 : Math.trunc(signed) & (ROTATION_UNITS - 1);
      }
    }
  }

  function reset() {
    shakemag = shaketimer = maxshake = verttimer = shakeVert = roll = 0;
    bShakeDir = false;
  }

  return {
    clientShake,
    shakeView,
    tick,
    reset,
    /** Signed roll in rotator units. */
    rollUU: signedRoll,
    /** Signed roll in radians, ready for an Object3D's rotation.z. */
    rollRad: () => (signedRoll() / ROTATION_UNITS) * Math.PI * 2,
    /** Vertical eye offset in Unreal Units, Epic's own value. */
    vertUU: () => shakeVert,
    /** Vertical eye offset in metres at UT99 pawn scale. */
    vertM: () => shakeVert * UU_TO_M,
    /** True while a shake is armed; false once it is only unwinding. */
    active: () => shaketimer > 0,
    /** Current roll amplitude in rotator units — 0 when nothing is armed. */
    magnitude: () => shakemag,
  };
}
