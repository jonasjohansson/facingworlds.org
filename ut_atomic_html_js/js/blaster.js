AFRAME.registerComponent('blaster',{
  schema:{
    fireRate:{type:'number', default:10}, // shots/sec
    damage:{type:'number', default:20},
    spread:{type:'number', default:0.5},  // degrees
    range:{type:'number', default:60},
    ammo:{type:'number', default:Infinity}
  },
  init(){
    this._lastShot = 0;
    this._firing = false;

    this._onDown = () => this._firing = true;
    this._onUp = () => this._firing = false;
    this.el.sceneEl.canvas?.addEventListener('mousedown', this._onDown);
    window.addEventListener('mouseup', this._onUp);
    this.el.sceneEl.addEventListener('exit-vr', this._onUp);
    window.dispatchEvent(new CustomEvent('hud:update', { detail:{ ammo: this.data.ammo } }));
  },
  remove(){
    this.el.sceneEl.canvas?.removeEventListener('mousedown', this._onDown);
    window.removeEventListener('mouseup', this._onUp);
  },
  tick(t, dt){
    if(!this._firing) return;
    const minInterval = 1000/Math.max(1,this.data.fireRate);
    if (t - this._lastShot < minInterval) return;
    if(this.data.ammo !== Infinity && this.data.ammo <= 0) return;
    this._lastShot = t;
    if(this.data.ammo !== Infinity){
      this.data.ammo--;
      window.dispatchEvent(new CustomEvent('hud:update',{detail:{ammo:this.data.ammo}}));
    }
    this.shoot();
  },
  shoot(){
    const cam = this.el.querySelector('[camera]') || this.el.sceneEl.camera?.el;
    if(!cam) return;
    const dir = new THREE.Vector3();
    cam.object3D.getWorldDirection(dir);
    const spreadRad = (this.data.spread * Math.PI)/180;
    dir.x += (Math.random()-0.5)*spreadRad;
    dir.y += (Math.random()-0.5)*spreadRad;
    dir.z += (Math.random()-0.5)*spreadRad;
    dir.normalize();
    const origin = new THREE.Vector3();
    cam.object3D.getWorldPosition(origin);
    const end = origin.clone().addScaledVector(dir, this.data.range);
    const raycaster = new THREE.Raycaster(origin, dir, 0.01, this.data.range);
    const objs = this.el.sceneEl.object3D.children;
    const hits = raycaster.intersectObjects(objs, true);
    if(hits.length){
      const hit = hits[0];
      let targetEl = hit.object.el;
      while(targetEl && !targetEl.components['damageable']) targetEl = targetEl.parentEl;
      if(targetEl){
        targetEl.emit('hit', { point: hit.point, normal: hit.face?.normal, amount: this.data.damage, source: this.el }, false);
      }
    }
    this.debugBeam(origin, end);
  },
  debugBeam(a, b){
    const scene = this.el.sceneEl.object3D;
    const g = new THREE.BufferGeometry().setFromPoints([a,b]);
    const m = new THREE.LineBasicMaterial({ transparent:true, opacity:0.75 });
    const line = new THREE.Line(g,m);
    scene.add(line);
    setTimeout(()=>{ scene.remove(line); g.dispose(); m.dispose(); }, 60);
  }
});