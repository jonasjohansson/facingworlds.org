AFRAME.registerComponent('health',{
  schema:{ max:{type:'number', default:100}, value:{type:'number', default:100}, respawnY:{type:'number', default:1.6} },
  init(){
    this.data.value = this.data.max;
    this.score = 0;

    const emitHUD = ()=>{
      window.dispatchEvent(new CustomEvent('hud:update', { detail:{ health: this.data.value, score: this.score }}));
    };

    const onDeath = ()=>{
      const el = this.el;
      el.setAttribute('visible', false);
      setTimeout(()=> this.respawn(), 1200);
    };

    this.el.addEventListener('damage', (e)=>{
      const amount = e.detail?.amount ?? 0;
      if(amount<=0) return;
      this.data.value = Math.max(0, this.data.value - amount);
      emitHUD();
      if(this.data.value<=0){
        this.el.emit('died', { killer: e.detail?.source || null }, false);
        onDeath();
      }
    });

    this.el.addEventListener('heal', (e)=>{
      const amount = e.detail?.amount ?? 0;
      if(amount<=0) return;
      this.data.value = Math.min(this.data.max, this.data.value + amount);
      emitHUD();
    });

    this.el.addEventListener('frag', ()=>{ this.score++; emitHUD(); });
    emitHUD();
  },
  respawn(){
    this.data.value = this.data.max;
    this.el.setAttribute('visible', true);
    const r = 12, a = Math.random()*Math.PI*2;
    this.el.setAttribute('position', { x: Math.cos(a)*r, y: this.data.respawnY, z: Math.sin(a)*r });
    window.dispatchEvent(new CustomEvent('hud:update', { detail:{ health: this.data.value, score: this.score }}));
  }
});