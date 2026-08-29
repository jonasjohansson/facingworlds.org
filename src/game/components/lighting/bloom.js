/* global AFRAME, THREE */
/**
 * Unreal Bloom Effect
 * Implementation for A-Frame
 * Code modified from Akbartus's post-processing A-Frame integration
 * https://github.com/akbartus/A-Frame-Component-Postprocessing
 *
 * A-Frame bundles three but NOT the postprocessing addons, and this file used to
 * reference EffectComposer/RenderPass/UnrealBloomPass/OutputPass as bare globals that
 * never existed - the component could not have worked. The passes are now pulled from
 * the stock three addons already vendored in assets/three-addons/, which resolve their
 * own `import ... from "three"` through the <script type="importmap"> in index.html
 * (see lighting/three-aframe.js - it re-exports A-Frame's three instance so the passes
 * share class identity with the renderer).
 *
 * The addon import is dynamic and guarded on purpose: post-processing is a nice-to-have,
 * and a failed module resolution here must not take the rest of the game's module graph
 * down with it. `bloomReady` resolves to true only when the component is registered, so
 * callers can wait before setting the `bloom` attribute on the scene.
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
 * pitch -60..60 by 30), 16.4 million texels / 65 million half-floats: zero NaN, zero Inf. An earlier version of this comment named the atmosphere shell
 * in earth-sphere.js, whose fragment shader did `pow( dotP, 4.1 )` on a `dotP` that goes
 * negative around the silhouette; GLSL pow is exp2( y * log2( x ) ), so a negative base is
 * NaN. That shader has since been rewritten and now raises a base clamped to [0,1], so the
 * producer is gone - do not go looking for it. The guard below stays regardless: what it
 * buys is that post-processing degrades one bad pixel into one bad pixel rather than into a
 * lost frame, whichever shader in this scene next does arithmetic near a silhouette.
 */

const ADDONS = "../../../../assets/three-addons/";

/**
 * The vendored addons are newer than the three r164 A-Frame bundles, and
 * LuminosityHighPassShader (the bloom bright-pass) calls the GLSL helper `luminance()`
 * without declaring it. On r164 that helper only exists inside the `common` ShaderChunk,
 * which three does not prefix onto a ShaderMaterial - so the bright pass fails to compile
 * ("'luminance' : no matching overloaded function found") and bloom silently contributes
 * nothing but a console error.
 *
 * Inlining a uniquely named copy fixes it without an `#include <common>` that would start
 * redefining symbols if the three version ever moves.
 */
const LUMINANCE_GLSL = "float fwLuminance( const in vec3 rgb ) {\n\treturn dot( vec3( 0.2126729, 0.7151522, 0.0721750 ), rgb );\n}\n";

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
 *  - `isnan()` is GLSL ES 3.00 only and these passes compile as GLSL ES 1.00, so the test
 *    is the classic "every finite value satisfies at least one of `>= 0` / `<= 0`, NaN
 *    satisfies neither".
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
 * that reworded one of these lines would quietly drop the guard - and, for the bright
 * pass, the luminance fix with it, which puts bloom back to "compiles nothing, logs an
 * error". Route every substitution through here so a miss is loud instead.
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
 * The vendored addons are newer than the three r164 A-Frame bundles, and
 * LuminosityHighPassShader calls `luminance()` without declaring it (on r164 that helper
 * only lives inside the `common` ShaderChunk, which three does not prefix onto a
 * ShaderMaterial), so the bright pass fails to compile without the inlined copy.
 *
 * The same pass is also where the NaN guard has to go: it is the single entry point to
 * the bloom mip chain, so sanitising the texel here means nothing downstream of it can
 * ever go non-finite.
 */
function patchBrightPass(bloomPass) {
  const material = bloomPass.materialHighPassFilter;
  if (!material) {
    console.warn("[bloom] UnrealBloomPass exposes no materialHighPassFilter, bright pass left unpatched");
    return;
  }
  // Order matters, and the two patches must not be chained. The luminance fix is REQUIRED -
  // without it this shader does not compile at all and bloom silently contributes nothing -
  // while the NaN guard is defence in depth. Applying the guard first and returning early on
  // a miss meant that any future reword of the `void main()` line would take the luminance
  // fix down with it, turning bloom off outright to protect against a pixel. Required first,
  // unconditionally; optional second, allowed to fail on its own.
  if (material.fragmentShader.indexOf("fwLuminance") === -1) {
    material.fragmentShader = LUMINANCE_GLSL + material.fragmentShader.replace(/\bluminance\s*\(/g, "fwLuminance(");
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

export const bloomReady = (async function loadBloom() {
  let EffectComposer;
  let RenderPass;
  let UnrealBloomPass;
  let OutputPass;

  try {
    [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
      import(`${ADDONS}postprocessing/EffectComposer.js`),
      import(`${ADDONS}postprocessing/RenderPass.js`),
      import(`${ADDONS}postprocessing/UnrealBloomPass.js`),
      import(`${ADDONS}postprocessing/OutputPass.js`),
    ]);
  } catch (error) {
    console.warn("[bloom] post-processing addons unavailable, bloom disabled:", error);
    return false;
  }

  if (typeof AFRAME === "undefined") {
    console.warn("A-Frame not loaded, bloom component will not work");
    return false;
  }

  AFRAME.registerComponent("bloom", {
    schema: {
      enabled: { type: "boolean", default: true },
      // Luminance above which a pixel starts to bloom. The composer works on linear
      // HDR values *before* tone mapping, so 1.0 means "brighter than white".
      threshold: { type: "number", default: 0.85 },
      strength: { type: "number", default: 0.45 },
      radius: { type: "number", default: 0.4 },
      // MSAA samples on the HDR buffer. The composer bypasses the canvas' own
      // antialiasing, so without this the whole scene renders jaggy. Kept low on
      // purpose: the composer allocates two RGBA16F targets and each sample multiplies
      // their footprint (at a 2x pixel ratio, 4 samples is a few hundred MB of VRAM).
      samples: { type: "number", default: 2 },
    },
    events: {
      rendererresize: function () {
        if (!this.composer || !this.data.enabled) {
          return;
        }
        // A plain composer.setSize() is not enough here. The HDR buffers are
        // multisampled, and resizing them in place leaves the resolve target and the
        // bloom mip chain inconsistent - which shows up as a hard-edged black rectangle
        // over part of the frame that never repairs itself. Resizes are rare and the
        // rebuild is cheap, so tear the whole chain down and build it at the new size.
        this.buildComposer();
      },
    },
    init: function () {
      this.size = new THREE.Vector2();
      this.scene = this.el.object3D;
      this.renderer = this.el.renderer;
      this.originalRender = this.el.renderer.render;
      if (this.data.enabled) {
        this.bind();
      }
    },
    update: function (oldData) {
      if (oldData.enabled === false && this.data.enabled === true) {
        this.bind();
      }

      if (oldData.enabled === true && this.data.enabled === false) {
        this.el.renderer.render = this.originalRender;
        // Two RGBA16F targets plus the bloom mip chain: release them rather than leaving
        // them resident while the effect is switched off.
        this.disposeComposer();
      }

      if (!this.data.enabled) {
        return;
      }

      this.buildComposer();
    },

    buildComposer: function () {
      this.disposeComposer();
      // create composer with multisampling to avoid aliasing
      var resolution = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.renderTarget = new THREE.WebGLRenderTarget(resolution.width, resolution.height, {
        type: THREE.HalfFloatType,
        samples: this.data.samples,
      });

      this.composer = new EffectComposer(this.renderer, this.renderTarget);

      // create render pass
      if (!this.renderPass) {
        this.renderPass = new RenderPass(this.scene, this.el.camera);
      }
      this.composer.addPass(this.renderPass);

      // create bloom pass
      var strength = this.data.strength;
      var radius = this.data.radius;
      var threshold = this.data.threshold;
      this.bloomPass = new UnrealBloomPass(resolution, strength, radius, threshold);
      patchBrightPass(this.bloomPass);
      this.composer.addPass(this.bloomPass);

      // create output pass - the scene is rendered into an HDR buffer, so tone mapping
      // and the sRGB transfer happen here instead of in the renderer
      this.outputPass = new OutputPass();
      patchOutputPass(this.outputPass);
      this.composer.addPass(this.outputPass);

      // EffectComposer takes its _width/_height from the render target it is handed - which
      // is in *drawing buffer* pixels - but then multiplies by the renderer's pixel ratio
      // again when it sizes each pass. Left alone, UnrealBloomPass allocates its whole mip
      // chain at twice the resolution (4x the memory) and blurs at half the intended radius
      // until the first window resize happens to correct it. Re-state the size in CSS pixels
      // so the pass chain matches the buffers from the first frame.
      // Size the pass chain in *drawing buffer* pixels with the composer's own pixel-ratio
      // multiplier neutralised. EffectComposer multiplies whatever size it is handed by
      // renderer.getPixelRatio(), and on a fractionally-scaled display (1.8, not 2) that
      // produces non-integer render-target dimensions. WebGL floors those when it allocates
      // the texture, so the buffers and the viewport end up disagreeing and the composited
      // quad covers only part of the canvas - a hard-edged black region over the rest of the
      // frame. getDrawingBufferSize() is already floored to integers, so pinning the ratio to
      // 1 and sizing from it keeps every buffer in the chain exact.
      this.composer.setPixelRatio(1);
      this.composer.setSize(resolution.width, resolution.height);
    },

    bind: function () {
      var self = this;
      var isInsideComposerRender = false;

      this.el.renderer.render = function () {
        // The composer owns the whole screen path, so it cannot honour a caller-supplied
        // render target. A-Frame's built-in `screenshot` component (bound to ctrl+alt+s on
        // every scene) does setRenderTarget(output) -> render() -> readRenderTargetPixels,
        // and would read back an empty buffer if we swallowed that call. Anything rendering
        // into an explicit target goes straight through, un-bloomed.
        if (isInsideComposerRender || this.getRenderTarget() !== null) {
          self.originalRender.apply(this, arguments);
        } else {
          isInsideComposerRender = true;
          // always set the current active camera on the RenderPass so that the
          // inspector controls are working properly with post-processing enabled
          self.renderPass.camera = self.el.camera;
          self.composer.render(self.el.sceneEl.delta / 1000);
          isInsideComposerRender = false;
        }
      };
    },

    /**
     * Release every GPU resource the composer chain owns. EffectComposer.dispose() frees
     * its two RGBA16F targets and its internal copy pass; the bloom mip chain and the
     * output pass' material have to be released separately.
     */
    disposeComposer: function () {
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
    },

    remove: function () {
      this.el.renderer.render = this.originalRender;
      this.disposeComposer();
    },
  });

  return true;
})();

export default bloomReady;
