/* global THREE */
/**
 * Bare "three" specifier shim.
 *
 * The vendored three.js addons in assets/three-addons/ are stock upstream files and
 * import their symbols from the bare specifier "three". A-Frame 1.6.0 already bundles
 * three r164 and publishes it as `window.THREE`, and class identity matters: if the
 * addons resolved "three" to a *second* copy (assets/libraries/three/three.module.js)
 * they would build passes out of classes the A-Frame renderer has never seen, and
 * `instanceof` checks inside three would fail.
 *
 * So we re-export A-Frame's instance and point the <script type="importmap"> in
 * index.html at this file. ES modules need static export names, so the list below is
 * the exact union of what the postprocessing chain we use imports:
 *   postprocessing/{EffectComposer,RenderPass,UnrealBloomPass,OutputPass,Pass,ShaderPass,MaskPass}
 *   shaders/{CopyShader,LuminosityHighPassShader,OutputShader}
 * Add a name here if you vendor another pass that needs it.
 */

const T = window.THREE;

if (!T) {
  throw new Error('three-aframe shim: window.THREE is missing. A-Frame must load before any module that imports "three".');
}

export const ACESFilmicToneMapping = T.ACESFilmicToneMapping;
export const AdditiveBlending = T.AdditiveBlending;
export const AgXToneMapping = T.AgXToneMapping;
export const BufferGeometry = T.BufferGeometry;
export const CineonToneMapping = T.CineonToneMapping;
export const Clock = T.Clock;
export const Color = T.Color;
export const ColorManagement = T.ColorManagement;
export const CustomToneMapping = T.CustomToneMapping;
export const Float32BufferAttribute = T.Float32BufferAttribute;
export const HalfFloatType = T.HalfFloatType;
export const LinearToneMapping = T.LinearToneMapping;
export const Mesh = T.Mesh;
export const MeshBasicMaterial = T.MeshBasicMaterial;
export const NeutralToneMapping = T.NeutralToneMapping;
export const NoBlending = T.NoBlending;
export const OrthographicCamera = T.OrthographicCamera;
export const RawShaderMaterial = T.RawShaderMaterial;
export const ReinhardToneMapping = T.ReinhardToneMapping;
export const SRGBTransfer = T.SRGBTransfer;
export const ShaderMaterial = T.ShaderMaterial;
export const UniformsUtils = T.UniformsUtils;
export const Vector2 = T.Vector2;
export const Vector3 = T.Vector3;
export const WebGLRenderTarget = T.WebGLRenderTarget;

export default T;
