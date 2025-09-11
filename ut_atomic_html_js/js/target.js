AFRAME.registerComponent('damageable',{
  schema:{ hp:{type:'number', default:40} },
  init(){
    this.data.hp = Math.max(1, this.data.hp);
    const flash = ()=>{
      const mesh = this.el.getObject3D('mesh');
      if(!mesh) return;
      mesh.traverse(m=>{
        if(m.isMesh){
          const old = m.material.emissive?.clone?.();
          if(m.material.emissive){ m.material.emissive.setHex(0xff4444); }
          setTimeout(()=>{ if(old && m.material.emissive){ m.material.emissive.copy(old); } }, 120);
        }
      });
    };
    const die = (source)=>{
      if(source && source.components?.health){ source.emit('frag'); }
      const el = this.el;
      el.setAttribute('animation__pop', 'property: scale; to: 0 0 0; dur: 120; easing: easeInQuad');
      setTimeout(()=> el.parentNode && el.parentNode.removeChild(el), 120);
    };
    this.el.addEventListener('hit', (e)=>{
      const amt = e.detail?.amount ?? 0;
      if(amt<=0) return;
      this.data.hp -= amt;
      this.el.emit('damage', { amount: amt, source: e.detail?.source || null }, false);
      flash();
      if(this.data.hp <= 0){ die(e.detail?.source); }
    });
  }
});

AFRAME.registerComponent('target',{
  schema:{ size:{type:'number', default:0.6} },
  init(){
    const s = this.data.size;
    this.el.setAttribute('geometry', `primitive: box; depth: ${s}; height:${s}; width:${s}`);
    this.el.setAttribute('material', 'color: #1e90ff; metalness:0.1; roughness:0.4; emissive:#0a1a3a; emissiveIntensity:0.3');
    this.el.setAttribute('shadow', 'cast:true; receive:false');
    this.el.setAttribute('damageable', '');
  }
});