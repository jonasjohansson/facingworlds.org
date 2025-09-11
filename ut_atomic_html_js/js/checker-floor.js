AFRAME.registerComponent('checker-floor',{
  schema:{ size:{type:'number', default:4} },
  init(){
    const sz = this.data.size;
    const w = 64, h = 64;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    for(let y=0;y<8;y++){
      for(let x=0;x<8;x++){
        g.fillStyle = (x+y)%2? '#0c1322':'#0a0f1c';
        g.fillRect(x*8,y*8,8,8);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(200/sz, 200/sz);
    this.el.getObject3D('mesh')?.traverse(m=>{
      if(m.isMesh){ m.material.map = tex; m.material.needsUpdate = true; }
    });
  }
});