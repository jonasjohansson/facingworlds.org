// animation-helpers.js — Animation utilities
export function setupAnimationMixer(mesh, clips) {
  const mixer = new AFRAME.THREE.AnimationMixer(mesh);
  const actions = {};

  clips.forEach((clip, index) => {
    if (clip) {
      const action = mixer.clipAction(clip);
      action.setLoop(AFRAME.THREE.LoopRepeat, Infinity);
      action.enabled = true;
      action.setEffectiveTimeScale(1);
      action.setEffectiveWeight(index === 0 ? 1 : 0);
      action.play();
      actions[clip.name || `clip_${index}`] = action;
    }
  });

  return { mixer, actions };
}

export function blendAnimations(actions, weights, targetWeights, lerpFactor) {
  Object.keys(weights).forEach((key) => {
    if (actions[key] && targetWeights.hasOwnProperty(key)) {
      weights[key] += (targetWeights[key] - weights[key]) * lerpFactor;
      actions[key].setEffectiveWeight(weights[key]);
    }
  });
}

export function normalizeWeights(weights) {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (sum > 1e-6) {
    const inv = 1 / sum;
    Object.keys(weights).forEach((key) => {
      weights[key] *= inv;
    });
  }
}

export function updateTimeScale(actions, speed, refSpeed, minScale = 0.6, maxScale = 1.8) {
  let scale = 1.0;
  if (refSpeed > 1e-6) scale = Math.max(0.001, speed) / refSpeed;
  scale = Math.min(maxScale, Math.max(minScale, scale));

  Object.values(actions).forEach((action) => {
    if (action) action.setEffectiveTimeScale(scale);
  });
}
