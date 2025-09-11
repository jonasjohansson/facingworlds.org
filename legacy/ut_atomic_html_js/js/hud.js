export function initHUD(){
  const hud = {
    health: document.getElementById('hud-health'),
    ammo: document.getElementById('hud-ammo'),
    score: document.getElementById('hud-score')
  };
  // Listen for global events
  window.addEventListener('hud:update', (e)=>{
    const { health, ammo, score } = e.detail;
    if (health != null) hud.health.textContent = `Health: ${Math.max(0, Math.round(health))}`;
    if (ammo != null) hud.ammo.textContent = `Ammo: ${ammo === Infinity ? '∞' : ammo}`;
    if (score != null) hud.score.textContent = `Score: ${score|0}`;
  });
}
