AFRAME.registerSystem('target-spawner',{
  schema:{ count:{type:'int', default:24}, radiusMin:{type:'number', default:6}, radiusMax:{type:'number', default:18} },
  init(){ /* no-op */ },
  spawn(count=this.data.count, opts={}){
    const rmin = opts.radiusMin ?? this.data.radiusMin;
    const rmax = opts.radiusMax ?? this.data.radiusMax;
    for(let i=0;i<count;i++){
      const a = Math.random()*Math.PI*2;
      const r = rmin + Math.random()*(rmax-rmin);
      const x = Math.cos(a)*r, z = Math.sin(a)*r, y = 0.3 + Math.random()*1.2;
      const e = document.createElement('a-entity');
      e.setAttribute('position', `${x} ${y} ${z}`);
      e.setAttribute('target', '');
      this.el.appendChild(e);
    }
  }
});

AFRAME.registerComponent('target-spawner',{
  schema:{ count:{type:'int', default:24}, radiusMin:{type:'number', default:6}, radiusMax:{type:'number', default:18} },
  init(){
    const scene = this.el.sceneEl;
    if(scene.hasLoaded) this.run(); else scene.addEventListener('loaded', ()=> this.run());
  },
  run(){
    const sys = this.el.sceneEl.systems['target-spawner'];
    sys.spawn(this.data.count, { radiusMin:this.data.radiusMin, radiusMax:this.data.radiusMax });
  }
});