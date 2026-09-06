/**
 * Unreal Bloom — the composer that owns the screen path.
 *
 * Ported from src/game/components/lighting/bloom.js. Originally adapted from Akbartus's
 * post-processing A-Frame integration (https://github.com/akbartus/A-Frame-Component-Postprocessing);
 * nothing of the A-Frame wrapper survives, but the pass configuration and the two shader
 * guards below do, verbatim, along with the measurements that justify them.
 *
 * The passes come from the stock three addons vendored in assets/three-addons/, which
 * resolve their own `import ... from "three"` through the <script type="importmap"> in
 * play.html — the same r180 module build engine/game.js's renderer is built from, so the
 * passes share class identity with it. (The old file went through a shim,
 * lighting/three-aframe.js, that re-exported A-Frame's bundled r164. There is no shim now.)
 *
 * The addon import stays DYNAMIC and guarded on purpose: post-processing is a
 * nice-to-have, and a failed module resolution must not take main-three.js's module graph
 * down with it. A static import would. `ready` resolves to true only when the composer is
 * actually built and hooked up, so callers can wait before assuming bloom is on.
 *
 * Tone mapping is not configured here and must not be. engine/game.js sets ACES filmic at
 * exposure 1.0 on the renderer; three compiles scene materials with NoToneMapping whenever
 * a render target is bound (WebGLPrograms.getParameters: `toneMapping` falls back to
 * NoToneMapping unless the current render target is null), so the RenderPass writes linear
 * HDR into the composer's buffer, and OutputPass reads renderer.toneMapping /
 * toneMappingExposure / outputColorSpace back off the renderer and applies exactly that
 * curve on the way to the default framebuffer. The frame with bloom on therefore has the
 * same tone mapping as the frame without — the only difference is the added glow.
 *
 * ---------------------------------------------------------------------------------------
 * The "hard-edged black region" artifact
 *
 * Reproduced and measured in Chrome on this machine at a 3389x1884 drawing buffer.
 *
 * MECHANISM. A single non-finite texel in the RGBA16F buffer does not stay one texel once it
 * reaches the bloom pass - it gets *amplified*. See SANITIZE_GLSL below for the step by step.
 * The end result is a large BLACK region with coarse, stepped, axis-aligned edges whose
 * outline loosely follows whatever produced the NaN.
 *
 * MEASURED, by injecting a NaN producer into a scene shader and comparing the final frame
 * against the same frame with the bloom pass lifted out of the chain. Bloom is additive, so
 * any pixel that comes out DARKER than that un-bloomed reference is a defect by construction,
 * which makes the artifact countable instead of a matter of opinion:
 *
 *   34401 NaN texels in the HDR buffer, guard removed  -> 1924013 pixels darker, worst case
 *                                                         fully black: ~1/4 of the frame.
 *   the same 34401 NaN texels, guard in place          -> 0 pixels darker.
 *
 * Independently reproduced since, at a 3200x1682 drawing buffer, by injecting pow() with a
 * base driven negative by a uniform (so it cannot be constant-folded) into the atmosphere
 * shell shader. 395187 NaN half-floats confirmed present in the RenderPass output by scanning
 * it for the half-float NaN bit pattern (exponent 0x1f, mantissa non-zero):
 *
 *   guard removed  -> 1173935 pixels darker, 1129572 of them fully black: 21.8% of the frame,
 *                     and on screen it is unmistakably the reported artifact - a hard-edged
 *                     black region with coarse, stepped, axis-aligned edges.
 *   guard in place -> 0 pixels darker. The injected NaN renders as a contained white disc
 *                     exactly where the bad shader wrote it, and spreads nowhere.
 *
 * It is a real WebGL result, not a browser compositing or screenshot-capture race: a
 * gl.readPixels() of the default framebuffer taken INSIDE the render call, right after
 * composer.render(), contains the black region with the same stepped edges the screen shows.
 * (Reading the canvas back *afterwards* with drawImage/getImageData returns all black
 * everywhere instead, because the context is preserveDrawingBuffer:false - that is a property
 * of the readback, not evidence about the frame.)
 *
 * ELIMINATED, each by toggling one thing at a time against an identical frame and camera:
 *  - MSAA on the HDR target. samples 0 / 2 / 4 amplify identically (1922515 / 1924013 /
 *    1924584 pixels darker), and dropping MSAA does not even reduce the NaN count reaching
 *    the bright pass. Not the trigger, and not a usable lever either. Re-measured at
 *    3200x1682: 32.789% / 32.813% / 32.822% of the frame darker - a 0.03% spread across a
 *    4x change in sample count, i.e. noise.
 *  - the composer's own sizing. Every render target and the whole mip chain are integer-exact
 *    and match getDrawingBufferSize() (see setPixelRatio(1) in buildComposer below).
 *  - "the composer built at page load is somehow different". One rebuilt via buildComposer()
 *    and the one built at load reproduce identically, to the pixel.
 *
 * NOT eliminated - and an earlier version of this comment had it backwards. It claimed the
 * OutputPass was exonerated because "with the bloom pass out of the chain the same NaN input
 * produces no dark region at all". That is false, and the correction matters because it is
 * the argument someone would use to delete patchOutputPass(). Measured at 3200x1682, four
 * frames at one fixed camera, guard stripped, NaN injected/not injected:
 *
 *   RenderPass -> OutputPass only   ->  590129 px darker, 571795 fully black,
 *                                       bbox 1161,405 - 2044,1279  (883 x 874)
 *   RenderPass -> Bloom -> Output   -> 1766126 px darker, 1708115 fully black,
 *                                       bbox 591,0 - 2608,1681     (2017 x 1681)
 *
 * So BOTH passes turn NaN black, and they fail differently. The unguarded OutputPass blackens
 * exactly the texels the bad shader wrote - the bbox is the atmosphere disc and nothing else.
 * The bloom mip chain then triples the damaged area and smears it across nearly the whole
 * frame with the coarse stepped edges that make the artifact recognisable. Guarding only the
 * bright pass would therefore still leave a solid black planet-sized hole. Both guards are
 * load-bearing; neither is decoration.
 *
 * Control for the whole method, same run: on a clean scene, bloom in vs bloom out gives
 * exactly 0 pixels darker. Bloom is purely additive when nothing is non-finite, which is what
 * makes "darker than the un-bloomed reference" a sound defect test rather than a judgement
 * call.
 *
 * Worth recording, because it misleads: switching bloom off makes the artifact vanish
 * completely, which looks like proof that bloom is at fault. It is not. Without the mip chain
 * the same NaN texels are still there, they are just a 1-2px arc and so invisible. The
 * amplifier is the visible part; the source is elsewhere.
 *
 * NO PRODUCER REMAINS IN THE SCENE TODAY. Scanning the RenderPass output for half-float NaN
 * and Inf bit patterns across 73 camera orientations - 575 million pixels - finds zero of
 * each, and nothing negative. Re-run since over a 60-orientation sweep (yaw -180..180 by 30,
 * pitch -60..60 by 30), 16.4 million texels / 65 million half-floats: zero NaN, zero Inf. An
 * earlier version of this comment named the atmosphere shell in earth-sphere.js, whose
 * fragment shader did `pow( dotP, 4.1 )` on a `dotP` that goes negative around the
 * silhouette; GLSL pow is exp2( y * log2( x ) ), so a negative base is NaN. That shader has
 * since been rewritten and now raises a base clamped to [0,1], so the producer is gone - do
 * not go looking for it. The guard below stays regardless: what it buys is that
 * post-processing degrades one bad pixel into one bad pixel rather than into a lost frame,
 * whichever shader in this scene next does arithmetic near a silhouette.
 */
import * as THREE from "three";

/**
 * The vendored addons live at the site root, not under src/. Resolved against this
 * module's own URL so the path survives the file being moved, and so the specifier is a
 * plain absolute URL by the time the dynamic import runs.
 */
const ADDONS = new URL("../../../assets/three-addons/", import.meta.url).href;

/**
 * What the schema on the old A-Frame component defaulted to. quality-tier hands the same
 * numbers down through its `bloomSettings` getter; these are the fallback for a game with
 * no quality-tier registered at all (a test harness, mainly).
 */
const DEFAULTS = {
  // No `enabled` here on purpose: the constructor always computes it from quality-tier's
  // gate, so a default would be dead the moment it was read.
  // Luminance above which a pixel starts to bloom. The composer works on linear
  // HDR values *before* tone mapping, so 1.0 means "brighter than white".
  threshold: 0.85,
  strength: 0.45,
  radius: 0.4,
  // MSAA samples on the HDR buffer. The composer bypasses the canvas' own
  // antialiasing, so without this the whole scene renders jaggy. Kept low on
  // purpose: the composer allocates two RGBA16F targets and each sample multiplies
  // their footprint (at a 2x pixel ratio, 4 samples is a few hundred MB of VRAM).
  samples: 2,
};

/**
 * Non-finite guard for the composer's floating-point buffers.
 *
 * Every buffer in this chain is RGBA16F, and half-float stores NaN perfectly happily.
 * A single NaN pixel that reaches the bloom pass does not stay one pixel - it gets
 * *amplified*:
 *
 *   bright pass keeps it (smoothstep of a NaN is a NaN)
 *     -> five separable blur mips each spread it by their kernel radius, in X then in Y
 *     -> the composite sums all five mips
 *     -> the final additive blend writes `dst + NaN = NaN` back over the HDR image
 *
 * The smallest mip is 1:32 of the drawing buffer, so one bad texel there is a 32x32
 * block on screen; the separable blur makes the spread axis-aligned. Tone mapping a NaN
 * in the OutputPass and writing it to the 8-bit default framebuffer clamps to zero. The
 * end result is a large hard-edged BLACK region with coarse, stepped, axis-aligned
 * edges - which is exactly the artifact this guard exists to stop.
 *
 * No producer remains in the scene today (see the module header for how that was verified),
 * but sanitising belongs here regardless: post-processing must degrade one bad pixel into one
 * bad pixel, never into a lost frame. Removing this guard and re-injecting a NaN puts the
 * black region straight back, so it is load-bearing, not decorative.
 *
 * Implementation notes:
 *  - `isnan()` is GLSL ES 3.00 only. three compiles the bright pass' ShaderMaterial as
 *    GLSL ES 3.00 but the OutputPass' RawShaderMaterial as GLSL ES 1.00, and one snippet
 *    serves both, so the test is the portable one: every finite value satisfies at least
 *    one of `>= 0` / `<= 0`, NaN satisfies neither.
 *  - the comparison is against a *uniform* rather than a literal `0.0` so that a driver
 *    optimising under "NaN never happens" assumptions is less likely to constant-fold it.
 *  - the select is a branch, not `mix()` and not a multiply, because `NaN * 0.0` is still
 *    NaN - a weighted select would carry the NaN straight through the guard.
 *  - `clamp` folds +/-Inf onto the half-float range.
 *
 * MEASURED, and worth knowing before anyone "simplifies" this: on the Chrome/ANGLE driver
 * this machine runs, the comparison does NOT reject NaN. Feeding an RGBA16F texture of
 * `pow( -1.0, 2.5 )` through the *actual patched materials* and reading the result back:
 * the guard returns 0xFBFF (-65504), i.e. the branch was taken and `clamp` is what folded
 * the NaN, not the comparison. Both halves therefore matter, and neither is redundant:
 * whichever way a driver resolves the comparison, one of them yields a finite value.
 *
 * What comes out the far end on that driver, measured the same way: the bright pass turns
 * a NaN texel into (0,0,0,0) - it is below the luminosity threshold, so it contributes
 * nothing to the mip chain, which is the whole point. The OutputPass turns one into
 * roughly (1,1,1) with alpha -65504, i.e. a single white (and, on an alpha canvas,
 * transparent) pixel rather than the black one an earlier version of this comment
 * claimed. Either way it stays ONE pixel, which is the guarantee that matters.
 *
 * The residual gap: a driver that both folds the comparison to `true` AND propagates NaN
 * through `clamp` would defeat this. GLSL ES 1.00 has no bit-level float access, so there
 * is no portable test left to fall back on - if the artifact ever returns on another GPU,
 * this is the thing to re-measure first.
 */
const SANITIZE_GLSL = [
  "uniform float fwNanGuard;",
  "float fwFinite1( const in float x ) {",
  "\tif ( x >= fwNanGuard || x <= fwNanGuard ) return clamp( x, -65504.0, 65504.0 );",
  "\treturn 0.0;",
  "}",
  "vec3 fwFinite3( const in vec3 c ) {",
  "\treturn vec3( fwFinite1( c.x ), fwFinite1( c.y ), fwFinite1( c.z ) );",
  "}",
  "",
].join("\n");

/**
 * Every patch below is a string substitution against exact upstream text in the vendored
 * three addons. `String.replace` with a miss is a silent no-op, so a future addon update
 * that reworded one of these lines would quietly drop the guard. Route every substitution
 * through here so a miss is loud instead.
 */
function replaceOnce(material, anchor, replacement, what) {
  const patched = material.fragmentShader.replace(anchor, replacement);
  if (patched === material.fragmentShader) {
    console.warn(`[bloom] ${what}: upstream shader text has changed, patch NOT applied`);
    return false;
  }
  material.fragmentShader = patched;
  return true;
}

/**
 * Insert SANITIZE_GLSL immediately before `void main()` so it lands after any
 * `precision` statement - OutputPass uses a RawShaderMaterial, which three does NOT
 * prefix with precision qualifiers, and a `float` declared ahead of those would not
 * compile.
 */
function addSanitizer(material, what) {
  if (!material || material.fragmentShader.indexOf("fwFinite1") !== -1) return false;
  if (!replaceOnce(material, "void main()", SANITIZE_GLSL + "void main()", `${what} guard`)) return false;
  material.uniforms.fwNanGuard = { value: 0.0 };
  return true;
}

/**
 * The bright pass is the single entry point to the bloom mip chain, so sanitising the
 * texel here means nothing downstream of it can ever go non-finite.
 *
 * Under A-Frame this function also had to inline a copy of the GLSL `luminance()` helper:
 * the vendored addons were newer than the r164 three A-Frame bundled, and on r164 that
 * helper only existed inside the `common` ShaderChunk, which three does not prefix onto a
 * ShaderMaterial - so LuminosityHighPassShader failed to compile and bloom silently
 * contributed nothing but a console error. On r180 WebGLProgram emits
 * getLuminanceFunction() into the fragment prefix of every non-raw ShaderMaterial, so
 * `luminance()` is declared for us and the inlined copy is gone. If the bright pass ever
 * goes back to failing with "'luminance' : no matching overloaded function found", that
 * is where to look.
 */
function patchBrightPass(bloomPass) {
  const material = bloomPass.materialHighPassFilter;
  if (!material) {
    console.warn("[bloom] UnrealBloomPass exposes no materialHighPassFilter, bright pass left unpatched");
    return;
  }

  if (addSanitizer(material, "bright pass")) {
    replaceOnce(
      material,
      "vec4 texel = texture2D( tDiffuse, vUv );",
      "vec4 texel = texture2D( tDiffuse, vUv );\n\t\t\ttexel = vec4( fwFinite3( texel.rgb ), fwFinite1( texel.a ) );",
      "bright pass texel guard"
    );
  }

  material.needsUpdate = true;
}

/**
 * Not a second line of defence - an independent failure that this pass owns.
 *
 * The bright-pass guard stops the bloom mip chain from *spreading* a NaN, but it does
 * nothing for the NaN still sitting in the HDR buffer that the OutputPass tone maps. With
 * this guard stripped and the bloom pass lifted out of the chain entirely, an injected NaN
 * still blackens 571795 pixels - the whole region the bad shader wrote, and nothing outside
 * it (measured at 3200x1682; see the module header for the full four-frame comparison).
 * Guarding only the bright pass would trade a smeared black region for a solid black one.
 *
 * Cleaning it here means such a pixel renders as one predictable dot (measured: white,
 * alpha 0) rather than as whatever the driver happens to do with a NaN, and keeps the
 * guarantee end-to-end: nothing non-finite reaches the default framebuffer.
 *
 * OutputPass rewrites `material.defines` and sets needsUpdate whenever the renderer's tone
 * mapping or output colour space changes, but it never touches `fragmentShader`, so this
 * patch survives.
 */
function patchOutputPass(outputPass) {
  const material = outputPass.material;
  if (!addSanitizer(material, "output pass")) return;
  replaceOnce(
    material,
    "gl_FragColor = texture2D( tDiffuse, vUv );",
    "gl_FragColor = texture2D( tDiffuse, vUv );\n\t\t\tgl_FragColor = vec4( fwFinite3( gl_FragColor.rgb ), fwFinite1( gl_FragColor.a ) );",
    "output pass guard"
  );
  material.needsUpdate = true;
}

/**
 * Registered LAST, because it owns the render hook: game.start() calls every system's
 * update() and then the hook instead of renderer.render(). There is no update() here -
 * the hook is the whole of the per-frame work.
 */
export class Bloom {
  constructor(game, opts = {}) {
    this.game = game;

    // quality-tier owns the gate. `bloomSettings` is null on the low tier (mobile,
    // headset browsers, ?quality=low), and the settings object otherwise - the same
    // decision the old quality-tier PUSHED with setAttribute("bloom", …), pulled instead
    // because bloom has to register after the system it asks.
    const tier = game.systems.get("quality-tier");
    const tierSettings = tier ? tier.bloomSettings : DEFAULTS;
    this.settings = { ...DEFAULTS, enabled: tierSettings !== null, ...tierSettings, ...opts };

    this.composer = null;
    this.renderTarget = null;
    this.renderPass = null;
    this.bloomPass = null;
    this.outputPass = null;
    // The four addon classes, once resolved; buildComposer() needs them again on resize.
    this._passes = null;
    this.hooked = false;
    // Set by dispose(). _load() is async, so it can come back to a Bloom that is already
    // gone and must not build a composer or install a hook for it.
    this.disposed = false;

    /**
     * Resolves true once the composer is built and the render hook is installed, and
     * false - never rejects - if this tier gets no bloom, the addons fail to resolve, or
     * the chain fails to build. The page renders un-bloomed in all of those cases;
     * nothing else changes.
     */
    this.ready = this._load();
  }

  /**
   * The try covers the WHOLE path, not just the import. buildComposer() allocates GPU
   * targets and rewrites shader text, and main-three.js registers this system without
   * awaiting `ready`, so anything thrown out here would surface as an unhandled rejection
   * rather than the "resolves false" the field above promises. Whatever fails, the page
   * ends up where it would have been without bloom: no render hook, no half-built chain.
   */
  async _load() {
    if (!this.settings.enabled) return false;

    try {
      const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
        import(`${ADDONS}postprocessing/EffectComposer.js`),
        import(`${ADDONS}postprocessing/RenderPass.js`),
        import(`${ADDONS}postprocessing/UnrealBloomPass.js`),
        import(`${ADDONS}postprocessing/OutputPass.js`),
      ]);

      // dispose() can win the race against a slow module fetch.
      if (this.disposed) return false;

      this._passes = { EffectComposer, RenderPass, UnrealBloomPass, OutputPass };
      this.buildComposer();
      this.game.setRenderHook((dt) => this.composer.render(dt));
      this.hooked = true;
      return true;
    } catch (error) {
      console.warn("[bloom] disabled:", error);
      if (this.hooked) {
        this.game.setRenderHook(null);
        this.hooked = false;
      }
      this.disposeComposer();
      this._passes = null;
      return false;
    }
  }

  buildComposer() {
    const { EffectComposer, RenderPass, UnrealBloomPass, OutputPass } = this._passes;
    const renderer = this.game.renderer;
    this.disposeComposer();

    // create composer with multisampling to avoid aliasing
    const resolution = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.renderTarget = new THREE.WebGLRenderTarget(resolution.width, resolution.height, {
      type: THREE.HalfFloatType,
      samples: this.settings.samples,
    });

    this.composer = new EffectComposer(renderer, this.renderTarget);

    // create render pass. game.camera is built once in createGame() and never swapped,
    // so the pass can hold it. (The old component reassigned renderPass.camera every
    // frame because A-Frame's inspector switched the scene's active camera underneath it;
    // nothing does that here.)
    if (!this.renderPass) {
      this.renderPass = new RenderPass(this.game.scene, this.game.camera);
    }
    this.composer.addPass(this.renderPass);

    // create bloom pass
    this.bloomPass = new UnrealBloomPass(resolution, this.settings.strength, this.settings.radius, this.settings.threshold);
    patchBrightPass(this.bloomPass);
    this.composer.addPass(this.bloomPass);

    // create output pass - the scene is rendered into an HDR buffer, so tone mapping
    // and the sRGB transfer happen here instead of in the renderer
    this.outputPass = new OutputPass();
    patchOutputPass(this.outputPass);
    this.composer.addPass(this.outputPass);

    // Size the pass chain in *drawing buffer* pixels with the composer's own pixel-ratio
    // multiplier neutralised. EffectComposer takes its _width/_height from the render
    // target it is handed - which is already in drawing-buffer pixels - but then
    // multiplies by renderer.getPixelRatio() again when it sizes each pass. Left alone,
    // UnrealBloomPass allocates its whole mip chain at twice the resolution (4x the
    // memory) and blurs at half the intended radius until the first window resize happens
    // to correct it. Worse, on a fractionally-scaled display (1.8, not 2) that second
    // multiply produces non-integer render-target dimensions; WebGL floors those when it
    // allocates the texture, so the buffers and the viewport end up disagreeing and the
    // composited quad covers only part of the canvas - a hard-edged black region over the
    // rest of the frame. getDrawingBufferSize() is already floored to integers, so pinning
    // the ratio to 1 and sizing from it keeps every buffer in the chain exact.
    this.composer.setPixelRatio(1);
    this.composer.setSize(resolution.width, resolution.height);
  }

  /**
   * game.js calls this on every window resize, after renderer.setSize() - so
   * getDrawingBufferSize() is already the new size and the arguments are not needed.
   *
   * A plain composer.setSize() is not enough here. The HDR buffers are multisampled, and
   * resizing them in place leaves the resolve target and the bloom mip chain inconsistent
   * - which shows up as a hard-edged black rectangle over part of the frame that never
   * repairs itself. Resizes are rare and the rebuild is cheap, so tear the whole chain
   * down and build it at the new size.
   */
  resize() {
    if (!this.composer) return;
    this.buildComposer();
  }

  /**
   * Release every GPU resource the composer chain owns. EffectComposer.dispose() frees
   * its two RGBA16F targets and its internal copy pass; the bloom mip chain and the
   * output pass' material have to be released separately.
   */
  disposeComposer() {
    if (this.bloomPass) {
      // UnrealBloomPass.dispose() releases its mip targets, the blur/composite/blend
      // materials and its full-screen quad, but it never touches materialHighPassFilter
      // - so the bright pass' shader program would stay resident for the life of the
      // page after bloom is switched off. It is the one material this file patches, so
      // it is also the one this file has to let go of. Null-checked because
      // patchBrightPass() tolerates a pass that does not expose one, so dispose has to too.
      if (this.bloomPass.materialHighPassFilter) {
        this.bloomPass.materialHighPassFilter.dispose();
      }
      this.bloomPass.dispose();
      this.bloomPass = null;
    }
    if (this.outputPass) {
      this.outputPass.dispose();
      this.outputPass = null;
    }
    if (this.composer) {
      this.composer.dispose();
      this.composer = null;
    }
    if (this.renderTarget) {
      this.renderTarget.dispose();
      this.renderTarget = null;
    }
  }

  dispose() {
    // Tells an in-flight _load() not to build anything for a system that is already gone.
    this.disposed = true;
    // Hand the frame back to renderer.render(scene, camera) before the buffers go away,
    // and only if the hook in place is ours to clear.
    if (this.hooked) {
      this.game.setRenderHook(null);
      this.hooked = false;
    }
    this.disposeComposer();
    if (this.renderPass) {
      this.renderPass.dispose();
      this.renderPass = null;
    }
  }
}
