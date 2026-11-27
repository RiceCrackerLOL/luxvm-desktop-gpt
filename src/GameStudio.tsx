import React, { useEffect, useRef, useState } from 'react'

declare global { interface Window { THREE?: any } }

type GameConfig = { theme: string; arena: string; enemies: string; lighting: string; difficulty: number; weapon: string }
const DEFAULT_CONFIG: GameConfig = { theme: 'Modern military', arena: 'Abandoned urban district', enemies: 'Hostile tactical soldiers', lighting: 'Cinematic golden-hour light', difficulty: 1, weapon: 'Assault rifle' }

function loadThree(): Promise<any> {
  if (window.THREE) return Promise.resolve(window.THREE)
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-rzer-three]')
    if (existing) { existing.addEventListener('load', () => resolve(window.THREE)); existing.addEventListener('error', reject); return }
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.min.js'
    script.async = true
    script.dataset.rzerThree = 'true'
    script.onload = () => window.THREE ? resolve(window.THREE) : reject(new Error('3D engine did not initialize'))
    script.onerror = () => reject(new Error('Could not load the 3D engine. Check your internet connection.'))
    document.head.appendChild(script)
  })
}

export default function GameStudio({ apiKey }: { apiKey: string }) {
  const host = useRef<HTMLDivElement>(null)
  const engine = useRef<any>(null)
  const [prompt, setPrompt] = useState('A realistic modern military firefight in a ruined city, with dusty sunlight, smoke, concrete buildings and tactical enemy squads.')
  const [config, setConfig] = useState<GameConfig>(DEFAULT_CONFIG)
  const [status, setStatus] = useState('Preparing the battlefield…')
  const [running, setRunning] = useState(false)
  const [health, setHealth] = useState(100)
  const [ammo, setAmmo] = useState(30)
  const [kills, setKills] = useState(0)
  const [wave, setWave] = useState(1)
  const [ability, setAbility] = useState('None yet')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showBrief, setShowBrief] = useState(true)

  useEffect(() => {
    let dead = false
    let cleanup: (() => void) | undefined
    loadThree().then((THREE) => {
      if (dead || !host.current) return
      const root = host.current
      const canvasLayer = document.createElement('div')
      canvasLayer.className = 'rzer-game-canvas'
      root.appendChild(canvasLayer)
      const scene = new THREE.Scene()
      scene.background = new THREE.Color(0x87949a)
      scene.fog = new THREE.FogExp2(0x87949a, 0.012)
      const camera = new THREE.PerspectiveCamera(76, root.clientWidth / Math.max(1, root.clientHeight), 0.1, 450)
      camera.position.set(0, 1.7, 12)
      scene.add(camera)
      const weaponModel = new THREE.Group()
      const weaponMetal = new THREE.MeshStandardMaterial({color:0x252b2b,metalness:.78,roughness:.32})
      const weaponPolymer = new THREE.MeshStandardMaterial({color:0x111716,metalness:.12,roughness:.72})
      const receiver = new THREE.Mesh(new THREE.BoxGeometry(.2,.16,.52),weaponMetal);receiver.position.set(.32,-.28,-.72);weaponModel.add(receiver)
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(.027,.027,.48,10),weaponMetal);barrel.rotation.x=Math.PI/2;barrel.position.set(.32,-.245,-1.13);weaponModel.add(barrel)
      const handguard = new THREE.Mesh(new THREE.BoxGeometry(.14,.13,.34),weaponPolymer);handguard.position.set(.32,-.27,-.99);weaponModel.add(handguard)
      const stock = new THREE.Mesh(new THREE.BoxGeometry(.15,.13,.28),weaponPolymer);stock.position.set(.32,-.29,-.38);weaponModel.add(stock)
      const sight = new THREE.Mesh(new THREE.BoxGeometry(.075,.09,.12),weaponMetal);sight.position.set(.32,-.165,-.78);weaponModel.add(sight)
      const muzzleFlash = new THREE.Mesh(new THREE.SphereGeometry(.085,8,8),new THREE.MeshBasicMaterial({color:0xffc46b}));muzzleFlash.position.set(.32,-.245,-1.39);muzzleFlash.visible=false;weaponModel.add(muzzleFlash)
      const muzzleLight = new THREE.PointLight(0xffa44d,0,5);muzzleLight.position.copy(muzzleFlash.position);weaponModel.add(muzzleLight)
      camera.add(weaponModel)
      const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75))
      renderer.setSize(canvasLayer.clientWidth || root.clientWidth, canvasLayer.clientHeight || root.clientHeight)
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = THREE.PCFSoftShadowMap
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.15
      renderer.domElement.style.width = '100%'
      renderer.domElement.style.height = '100%'
      canvasLayer.appendChild(renderer.domElement)
      scene.add(new THREE.HemisphereLight(0xc8d9e4, 0x454039, 2.0))
      const sun = new THREE.DirectionalLight(0xffd3a0, 3.2)
      sun.position.set(-35, 55, 25); sun.castShadow = true
      sun.shadow.mapSize.set(2048, 2048)
      sun.shadow.camera.left = -70; sun.shadow.camera.right = 70; sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70
      scene.add(sun)
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.MeshStandardMaterial({ color: 0x55554e, roughness: 0.96 }))
      floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor)
      const road = new THREE.Mesh(new THREE.PlaneGeometry(11,180),new THREE.MeshStandardMaterial({color:0x292f30,roughness:1}));road.rotation.x=-Math.PI/2;road.position.y=.025;road.receiveShadow=true;scene.add(road)
      const curbMat=new THREE.MeshStandardMaterial({color:0x77766e,roughness:.95})
      for(const side of [-1,1]){const curb=new THREE.Mesh(new THREE.BoxGeometry(.28,.22,180),curbMat);curb.position.set(side*5.65,.11,0);curb.castShadow=true;curb.receiveShadow=true;scene.add(curb)}
      const laneMat=new THREE.MeshStandardMaterial({color:0xb7a77e,roughness:.8})
      for(let z=-84;z<=84;z+=9){const dash=new THREE.Mesh(new THREE.BoxGeometry(.12,.025,3.2),laneMat);dash.position.set(0,.05,z);scene.add(dash)}
      const buildings: any[] = []
      const blockMat = [0x77766d,0x5c625f,0x8b8171,0x4c5356].map((c:number)=>new THREE.MeshStandardMaterial({color:c,roughness:.94}))
      const windowMat=new THREE.MeshStandardMaterial({color:0x20282b,roughness:.38,metalness:.2})
      for (let i=0;i<54;i++) {
        const x = (Math.random()-.5)*105, z = (Math.random()-.5)*105
        if (Math.abs(x)<13 && Math.abs(z)<18) continue
        const w=4+Math.random()*8, h=4+Math.random()*19, d=4+Math.random()*9
        const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),blockMat[i%blockMat.length])
        b.position.set(x,h/2,z); b.castShadow=true; b.receiveShadow=true; scene.add(b); buildings.push(b)
        for(let row=0;row<Math.min(3,Math.floor(h/3));row++)for(let col=0;col<3;col++){const windowPane=new THREE.Mesh(new THREE.BoxGeometry(w*.13,.72,.07),windowMat);windowPane.position.set(x+(col-1)*w*.25,1.7+row*2.05,z+d/2+.045);scene.add(windowPane)}
      }
      // Street cover, barriers and wreckage give the arena readable combat lanes.
      for(let i=0;i<22;i++){
        const box=new THREE.Mesh(new THREE.BoxGeometry(2.8,1.15,1.1),new THREE.MeshStandardMaterial({color:i%2?0x66645a:0x77756a,roughness:1}))
        box.position.set((Math.random()-.5)*72,.58,(Math.random()-.5)*72); box.castShadow=true;box.receiveShadow=true;scene.add(box)
      }
      const enemyGroup = new THREE.Group(); scene.add(enemyGroup)
      const enemies: any[] = []
      const enemyMat = new THREE.MeshStandardMaterial({color:0x303b3a,roughness:.8})
      const helmetMat = new THREE.MeshStandardMaterial({color:0x202927,roughness:.7})
      const spawnEnemy = () => {
        const g=new THREE.Group()
        const body=new THREE.Mesh(new THREE.CapsuleGeometry(.34,.78,4,8),enemyMat)
        body.position.y=1.05;body.castShadow=true;g.add(body)
        const head=new THREE.Mesh(new THREE.SphereGeometry(.23,12,10),helmetMat)
        head.position.y=1.72;head.castShadow=true;g.add(head)
        const gun=new THREE.Mesh(new THREE.BoxGeometry(.12,.12,.9),new THREE.MeshStandardMaterial({color:0x171a19,metalness:.65,roughness:.4}))
        gun.position.set(.28,1.28,-.42);g.add(gun)
        const angle=Math.random()*Math.PI*2, dist=19+Math.random()*23
        g.position.set(camera.position.x+Math.cos(angle)*dist,0,camera.position.z+Math.sin(angle)*dist)
        enemyGroup.add(g); enemies.push({mesh:g,hp:100,nextShot:performance.now()+1500+Math.random()*2500,alive:true})
      }
      for(let i=0;i<8;i++) spawnEnemy()
      const raycaster=new THREE.Raycaster()
      const keys:Record<string,boolean>={}
      let yaw=0,pitch=0,locked=false,healthNow=100,ammoNow=30,killsNow=0,level=1,lastShot=0,active=false,frame=0,reloading=false,reloadUntil=0,slideUntil=0,activeAbility=''
      const bullets:any[]=[]
      const abilityNames=['Combat slide','Quick reload','Adrenaline','Armor plating','Explosive rounds','Overdrive']
      let unlocked=0
      const onKey=(e:KeyboardEvent)=>{keys[e.code]=true;if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();if(e.code==='KeyR'&&!e.repeat&&active&&!reloading&&ammoNow<30){reloading=true;reloadUntil=performance.now()+(activeAbility==='Quick reload'?550:1250);setStatus('Reloading magazine…')}if(e.code==='KeyC'&&!e.repeat&&active&&activeAbility==='Combat slide')slideUntil=performance.now()+520}
      const onUp=(e:KeyboardEvent)=>{keys[e.code]=false}
      const onMove=(e:MouseEvent)=>{if(!locked)return;yaw-=e.movementX*.0022;pitch-=e.movementY*.0022;pitch=Math.max(-1.25,Math.min(1.25,pitch))}
      const onLock=()=>{locked=document.pointerLockElement===renderer.domElement}
      const onClick=()=>{if(!locked){renderer.domElement.requestPointerLock?.();return}if(!active||reloading||ammoNow<=0)return;const cooldown=activeAbility==='Overdrive'?75:135;if(performance.now()-lastShot<cooldown)return;lastShot=performance.now();muzzleUntil=performance.now()+65;ammoNow--;setAmmo(ammoNow);camera.rotation.set(pitch,yaw,0,'YXZ');raycaster.setFromCamera(new THREE.Vector2(0,0),camera);const hit=raycaster.intersectObjects(enemies.filter(e=>e.alive).flatMap(e=>e.mesh.children),true)[0];const tracerEnd=hit?.point||camera.position.clone().add(raycaster.ray.direction.clone().multiplyScalar(55));const tracerStart=camera.localToWorld(new THREE.Vector3(.32,-.245,-1.39));const tracerGeometry=new THREE.BufferGeometry().setFromPoints([tracerStart,tracerEnd]);const tracer=new THREE.Line(tracerGeometry,new THREE.LineBasicMaterial({color:0xffd18a,transparent:true,opacity:.9}));scene.add(tracer);bullets.push({mesh:tracer,dir:new THREE.Vector3(),life:.075});if(hit){const enemy=enemies.find(e=>e.alive&&e.mesh===hit.object.parent);if(enemy){enemy.hp-=activeAbility==='Explosive rounds'?100:50;if(enemy.hp<=0){enemy.alive=false;enemyGroup.remove(enemy.mesh);killsNow++;setKills(killsNow)}}}}
      renderer.domElement.addEventListener('click',onClick)
      window.addEventListener('keydown',onKey);window.addEventListener('keyup',onUp);window.addEventListener('mousemove',onMove);document.addEventListener('pointerlockchange',onLock)
      const resize=()=>{const width=canvasLayer.clientWidth,height=canvasLayer.clientHeight;if(!width||!height)return;camera.aspect=width/height;camera.updateProjectionMatrix();renderer.setSize(width,height)}
      const observer=new ResizeObserver(resize);observer.observe(root)
      const clock=new THREE.Clock()
      const animate=()=>{if(dead)return;requestAnimationFrame(animate);const dt=Math.min(clock.getDelta(),.05);frame+=dt
        if(locked){
          const speed=(keys.ShiftLeft?10:6.2)*(activeAbility==='Adrenaline'?1.25:1), forward=new THREE.Vector3(-Math.sin(yaw),0,-Math.cos(yaw)),right=new THREE.Vector3(Math.cos(yaw),0,-Math.sin(yaw))
          if(keys.KeyW)camera.position.addScaledVector(forward,speed*dt);if(keys.KeyS)camera.position.addScaledVector(forward,-speed*dt);if(keys.KeyA)camera.position.addScaledVector(right,-speed*dt);if(keys.KeyD)camera.position.addScaledVector(right,speed*dt)
          camera.position.y=keys.Space?2.35:1.7;camera.rotation.set(pitch,yaw,0,'YXZ')
        }
        if(active&&reloading&&performance.now()>=reloadUntil){ammoNow=30;reloading=false;setAmmo(ammoNow);setStatus('Magazine reloaded.')}
        enemies.forEach(e=>{if(!active||!e.alive)return;const dx=camera.position.x-e.mesh.position.x,dz=camera.position.z-e.mesh.position.z,dist=Math.max(.001,Math.hypot(dx,dz));e.mesh.rotation.y=Math.atan2(dx,dz);if(dist>8){const boost=performance.now()<slideUntil?2.1:1;e.mesh.position.x+=(dx/dist)*dt*(.48+level*.13)*boost;e.mesh.position.z+=(dz/dist)*dt*(.48+level*.13)*boost}if(dist<27&&performance.now()>e.nextShot){e.nextShot=performance.now()+Math.max(650,2500-level*170);if(Math.random()<Math.min(.82,.28+level*.035)){const armor=activeAbility==='Armor plating'?.45:1;healthNow=Math.max(0,healthNow-(level>5?5:3)*armor);setHealth(Math.round(healthNow))}}})
        bullets.forEach((b,i)=>{b.life-=dt;b.mesh.position.addScaledVector(b.dir,dt*95);if(b.mesh.material?.opacity!==undefined)b.mesh.material.opacity=Math.max(0,b.life/.075);if(b.life<=0){scene.remove(b.mesh);b.mesh.geometry?.dispose?.();b.mesh.material?.dispose?.();bullets.splice(i,1)}})
        const flashActive=performance.now()<muzzleUntil;muzzleFlash.visible=flashActive;muzzleLight.intensity=flashActive?2.4:0
        if(active&&healthNow<=0){active=false;setRunning(false);setStatus('You were eliminated. Restart the operation to try again.');document.exitPointerLock?.()}
        if(active&&frame>level*38){level++;setWave(level);activeAbility=abilityNames[(unlocked++)%abilityNames.length];setAbility(activeAbility);healthNow=Math.min(100,healthNow+12);setHealth(Math.round(healthNow));ammoNow=30;reloading=false;setAmmo(30);for(let i=0;i<Math.min(4,1+level);i++)spawnEnemy();setStatus('Combat director adapted: '+activeAbility+' unlocked. Threat pressure increased.')}
        if(active&&enemies.filter(e=>e.alive).length<4){for(let i=0;i<2+Math.min(level,4);i++)spawnEnemy()}
        renderer.render(scene,camera)
      }
      animate()
      const applyConfig=(next:GameConfig)=>{const arena=next.arena.toLowerCase(),night=next.lighting.toLowerCase().includes('night'),desert=arena.includes('desert'),forest=arena.includes('woodland')||arena.includes('forest'),snow=arena.includes('frozen')||arena.includes('snow'),future=next.theme.toLowerCase().includes('futur');const tint=desert?0x9a896b:forest?0x435c43:snow?0x9ba8ad:future?0x263c49:0x55554e;floor.material.color.setHex(tint);const sky=night?0x111a27:desert?0xc4a47b:forest?0x718477:snow?0x9baab7:future?0x344e62:0x87949a;scene.background.setHex(sky);scene.fog.color.setHex(sky);scene.fog.density=night?.019:.012;sun.intensity=night?1.05:3.2;sun.color.setHex(night?0x9ab5dc:0xffd3a0);enemyMat.color.setHex(next.enemies.toLowerCase().includes('robot')?0x536b78:next.enemies.toLowerCase().includes('infected')?0x536d45:0x303b3a);level=Math.max(1,Math.min(5,Number(next.difficulty)||1))}
      engine.current={start:()=>{enemies.forEach(e=>enemyGroup.remove(e.mesh));enemies.length=0;for(let i=0;i<8;i++)spawnEnemy();frame=0;level=Math.max(1,Math.min(5,Number((engine.current.config||{}).difficulty)||1));killsNow=0;unlocked=0;activeAbility='';reloading=false;setKills(0);setWave(1);setAbility('None yet');active=true;healthNow=100;ammoNow=30;setHealth(100);setAmmo(30);setRunning(true);setStatus('Operation live. Capture the mouse by clicking the battlefield. WASD move · Shift sprint · R reload · Click fire.');renderer.domElement.requestPointerLock?.()},stop:()=>{active=false;document.exitPointerLock?.()},applyConfig,scene,camera,config:{difficulty:1}}
      cleanup=()=>{active=false;observer.disconnect();renderer.domElement.removeEventListener('click',onClick);window.removeEventListener('keydown',onKey);window.removeEventListener('keyup',onUp);window.removeEventListener('mousemove',onMove);document.removeEventListener('pointerlockchange',onLock);document.exitPointerLock?.();renderer.dispose();scene.clear();canvasLayer.remove()}
    }).catch(e=>{if(!dead)setError(e.message||'Unable to start 3D renderer')})
    return()=>{dead=true;cleanup?.()}
  },[])

  const generate = async () => {
    setLoading(true);setError('')
    try {
      let next={...config}
      if(apiKey.trim()){
        const response=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+apiKey.trim(),'Content-Type':'application/json'},body:JSON.stringify({model:'nvidia/nemotron-3.5-lightning:free',temperature:.55,max_tokens:350,messages:[{role:'system',content:'Convert the player\'s game description into JSON only with keys theme, arena, enemies, lighting, difficulty (1-5), weapon. Keep it grounded in a playable modern first-person shooter. No markdown.'},{role:'user',content:prompt}]})})
        if(!response.ok)throw new Error('Game design request failed ('+response.status+'). Check your RZER API key.')
        const data=await response.json();const raw=data.choices?.[0]?.message?.content||'{}';const parsed=JSON.parse(raw.replace(/\`\`\`json|\`\`\`/g,'').trim());next={...next,...parsed}
      } else {
        const p=prompt.toLowerCase()
        next={...next,theme:p.includes('sci-fi')||p.includes('futur')?'Futuristic combat':p.includes('desert')?'Desert warfare':p.includes('zombie')?'Survival horror':'Modern military',arena:p.includes('forest')?'Dense woodland combat zone':p.includes('desert')?'Desert military outpost':p.includes('snow')?'Frozen research facility':p.includes('space')?'Orbital industrial station':'Ruined urban district',enemies:p.includes('robot')?'Armored combat robots':p.includes('zombie')?'Infected hostile swarms':'Hostile tactical soldiers',lighting:p.includes('night')?'Night operations · volumetric searchlights':p.includes('sunset')?'Warm cinematic sunset':'Cinematic daylight · atmospheric haze'}
      }
      setConfig(next);setShowBrief(false);setStatus('Battlefield reconfigured. Start the operation when ready.')
    }catch(e:any){setError(e.message||'Could not generate game settings.');}finally{setLoading(false)}
  }

  return <div className="rzer-game-studio">
    <style>{`
      .rzer-game-studio{height:100%;min-height:0;display:flex;flex-direction:column;background:#101619;color:#e8eceb;font-family:Inter,system-ui,sans-serif;overflow:hidden}
      .rzer-game-head{display:flex;align-items:center;justify-content:space-between;padding:17px 24px;border-bottom:1px solid #344044;background:linear-gradient(115deg,#151d21,#202b2e 70%,#172126);gap:12px;flex-wrap:wrap;box-shadow:0 8px 28px #0003;z-index:2}
      .rzer-game-head h2{margin:0;font-size:17px;letter-spacing:.12em;text-transform:uppercase}.rzer-game-head p{margin:4px 0 0;color:#9ba9aa;font-size:12px}
      .rzer-game-actions{display:flex;gap:8px;flex-wrap:wrap}.rzer-game-studio button{background:linear-gradient(180deg,#2b3a3e,#202d31);border:1px solid #53666a;color:#eaf0ef;border-radius:4px;padding:10px 15px;cursor:pointer;font-weight:650;letter-spacing:.025em;transition:transform .16s,border-color .16s,filter .16s}.rzer-game-studio button:hover:not(:disabled){border-color:#b9a477;filter:brightness(1.12);transform:translateY(-1px)}.rzer-game-studio button:focus-visible{outline:2px solid #d6bb83;outline-offset:3px}.rzer-game-studio button.primary{background:linear-gradient(180deg,#d7bd8b,#b79a65);color:#111a1c;border-color:#e2c995}.rzer-game-studio button:disabled{opacity:.55;cursor:wait;transform:none}
      .rzer-game-stage{position:relative;flex:1;min-height:260px;background:#69777c;overflow:hidden;isolation:isolate}.rzer-game-canvas{position:absolute;inset:0;z-index:0}.rzer-game-canvas canvas{display:block;width:100%;height:100%;outline:none}.rzer-game-hud{z-index:1}
      .rzer-game-hud{position:absolute;inset:0;pointer-events:none;display:flex;flex-direction:column;justify-content:space-between;padding:18px 22px;text-shadow:0 2px 5px #000}
      .rzer-game-hud-top{display:flex;justify-content:space-between;gap:12px;font-size:12px;letter-spacing:.12em;text-transform:uppercase}.rzer-game-stats{display:flex;gap:18px;flex-wrap:wrap}.rzer-game-stat b{display:block;font-size:22px;letter-spacing:0}.rzer-game-stat span{color:#d0d8d7;font-size:10px}
      .rzer-crosshair{position:absolute;left:50%;top:50%;width:20px;height:20px;transform:translate(-50%,-50%)}.rzer-crosshair:before,.rzer-crosshair:after{content:'';position:absolute;background:#fff;box-shadow:0 0 4px #000}.rzer-crosshair:before{width:2px;height:18px;left:9px}.rzer-crosshair:after{height:2px;width:18px;top:8px}
      .rzer-game-bottom{display:flex;justify-content:space-between;align-items:end;gap:12px}.rzer-game-weapon{font-size:11px;letter-spacing:.14em;text-transform:uppercase}.rzer-game-weapon b{display:block;font-size:25px;letter-spacing:0}.rzer-game-ability{background:#17252bd9;border:1px solid #8c9a91;padding:9px 12px;border-radius:4px;font-size:11px}
      .rzer-game-overlay{position:absolute;inset:0;z-index:3;display:grid;place-items:center;background:#0b1114c9;backdrop-filter:blur(7px);padding:18px}.rzer-game-card{width:min(580px,100%);max-height:100%;overflow:auto;background:linear-gradient(145deg,#1d292d,#111a1e);border:1px solid #697a79;border-radius:7px;padding:25px;box-shadow:0 24px 90px #000b}.rzer-game-card h3{margin:0 0 8px;font-size:22px}.rzer-game-card p{color:#aebbbc;font-size:13px;line-height:1.55}.rzer-game-card textarea{width:100%;box-sizing:border-box;min-height:95px;background:#0e171a;color:#edf1ee;border:1px solid #46575b;border-radius:4px;padding:12px;font:13px/1.5 inherit;resize:vertical}.rzer-game-config{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:15px}.rzer-game-config div{background:#202e32;padding:10px;border-radius:4px;min-width:0}.rzer-game-config small{display:block;color:#91a2a2;text-transform:uppercase;font-size:9px;letter-spacing:.1em}.rzer-game-config strong{font-size:12px;display:block;margin-top:5px;overflow-wrap:anywhere}
      .rzer-game-status{padding:10px 18px;background:#121a1d;color:#b8c3c1;border-top:1px solid #344044;font-size:11px;letter-spacing:.025em;min-height:18px}
      @media(max-width:650px){.rzer-game-head{padding:12px}.rzer-game-hud{padding:12px}.rzer-game-config{grid-template-columns:1fr}.rzer-game-card{padding:16px}}
    `}</style>
    <div className="rzer-game-head"><div><h2>Game Studio / Frontline</h2><p>Adaptive first-person combat · Procedural battlefield</p></div><div className="rzer-game-actions"><button onClick={()=>setShowBrief(true)}>Game setup</button><button className="primary" onClick={()=>engine.current?.start()}> {running?'Restart operation':'Deploy'} </button></div></div>
    <div className="rzer-game-stage" ref={host}>
      <div className="rzer-game-hud"><div className="rzer-game-hud-top"><div>RZER // LIVE COMBAT SIMULATION</div><div>SECTOR 07 · WAVE {wave}</div></div><div className="rzer-crosshair"/><div className="rzer-game-bottom"><div className="rzer-game-stats"><div className="rzer-game-stat"><b>{health}</b><span>HEALTH</span></div><div className="rzer-game-stat"><b>{kills}</b><span>ELIMINATIONS</span></div><div className="rzer-game-stat"><b>{wave}</b><span>THREAT LEVEL</span></div></div><div className="rzer-game-weapon">{config.weapon}<b>{ammo} <small style={{fontSize:12,color:'#c4cfcc'}}>/ 30</small></b></div></div><div className="rzer-game-ability">UNLOCKED ABILITY · <strong>{ability}</strong></div></div>
      {showBrief&&<div className="rzer-game-overlay"><div className="rzer-game-card"><h3>Build your battlefield</h3><p>Describe the combat experience. RZER will shape the setting, enemy faction, atmosphere and weapon setup. The combat director adapts as you play.</p><textarea value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="Describe the game you want…"/><div className="rzer-game-actions" style={{marginTop:12}}><button className="primary" onClick={generate} disabled={loading}>{loading?'Building your game…':'Generate battlefield'}</button><button onClick={()=>setShowBrief(false)}>Keep current setup</button></div>{error&&<p style={{color:'#ff9b86'}}>{error}</p>}<div className="rzer-game-config"><div><small>Environment</small><strong>{config.arena}</strong></div><div><small>Faction</small><strong>{config.enemies}</strong></div><div><small>Visual direction</small><strong>{config.lighting}</strong></div><div><small>Combat style</small><strong>{config.theme} · {config.weapon}</strong></div></div><p>Controls: WASD move · Shift sprint · Mouse aim · Click fire · R reload · Esc release mouse.</p></div></div>}
    </div><div className="rzer-game-status" role="status">{error||status} {running?' · The combat director unlocks abilities and raises pressure as you survive.':''}</div>
  </div>
}
