import React, { useEffect, useRef, useState } from 'react'

declare global { interface Window { THREE?: any } }

type GameConfig = { theme: string; arena: string; enemies: string; lighting: string; difficulty: number; weapon: string; mapStyle?: string; enemyBehavior?: string; enemyVariant?: string; weaponDesign?: string; specialEffects?: string; mapComplexity?: number }
const DEFAULT_CONFIG: GameConfig = { theme: 'Modern military', arena: 'Abandoned urban district', enemies: 'Mutated infected hunters', lighting: 'Cinematic golden-hour light', difficulty: 1, weapon: 'Modular assault rifle', mapStyle: 'Ruined urban combat zone', enemyBehavior: 'Hunt, flank and rush the player', enemyVariant: 'Bio-mutant', weaponDesign: 'Modular tactical rifle with optic and attachments', specialEffects: 'Dust, sparks, muzzle flash and impact effects', mapComplexity: 2 }

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
  const [engineReady, setEngineReady] = useState(false)
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
      const magazine = new THREE.Mesh(new THREE.BoxGeometry(.115,.28,.16),weaponPolymer);magazine.position.set(.32,-.49,-.72);magazine.rotation.x=-.12;weaponModel.add(magazine)
      const pistolGrip = new THREE.Mesh(new THREE.BoxGeometry(.105,.22,.14),weaponPolymer);pistolGrip.position.set(.32,-.45,-.57);pistolGrip.rotation.x=-.18;weaponModel.add(pistolGrip)
      const foregrip = new THREE.Mesh(new THREE.CylinderGeometry(.045,.055,.16,10),weaponPolymer);foregrip.position.set(.32,-.38,-1.0);weaponModel.add(foregrip)
      const topRail = new THREE.Mesh(new THREE.BoxGeometry(.055,.035,.42),weaponMetal);topRail.position.set(.32,-.17,-.93);weaponModel.add(topRail)
      const optic = new THREE.Mesh(new THREE.CylinderGeometry(.055,.055,.12,16),weaponMetal);optic.rotation.x=Math.PI/2;optic.position.set(.32,-.105,-.82);weaponModel.add(optic)
      const opticGlass = new THREE.Mesh(new THREE.CircleGeometry(.037,16),new THREE.MeshBasicMaterial({color:0x6e9ca0,transparent:true,opacity:.8}));opticGlass.position.set(.32,-.105,-.755);weaponModel.add(opticGlass)
      const barrelCollar = new THREE.Mesh(new THREE.CylinderGeometry(.043,.043,.08,12),weaponMetal);barrelCollar.rotation.x=Math.PI/2;barrelCollar.position.set(.32,-.245,-1.28);weaponModel.add(barrelCollar)
      const muzzleFlash = new THREE.Mesh(new THREE.SphereGeometry(.085,8,8),new THREE.MeshBasicMaterial({color:0xffc46b}));muzzleFlash.position.set(.32,-.245,-1.39);muzzleFlash.visible=false;weaponModel.add(muzzleFlash)
      const muzzleLight = new THREE.PointLight(0xffa44d,0,5);muzzleLight.position.copy(muzzleFlash.position);weaponModel.add(muzzleLight)
      camera.add(weaponModel)
      const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.25))
      renderer.setClearColor(0x87949a)
      renderer.shadowMap.autoUpdate = true
      renderer.setSize(canvasLayer.clientWidth || root.clientWidth, canvasLayer.clientHeight || root.clientHeight)
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = THREE.PCFSoftShadowMap
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.22
      renderer.domElement.style.width = '100%'
      renderer.domElement.style.height = '100%'
      renderer.domElement.style.display = 'block'
      canvasLayer.appendChild(renderer.domElement)
      scene.add(new THREE.HemisphereLight(0xc8d9e4, 0x454039, 2.0))
      const sun = new THREE.DirectionalLight(0xffd3a0, 3.2)
      sun.position.set(-35, 55, 25); sun.castShadow = true
      sun.shadow.mapSize.set(2048, 2048)
      sun.shadow.camera.left = -70; sun.shadow.camera.right = 70; sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70
      scene.add(sun)
      const makeSurfaceTexture=(base:number,variation:number,repeatX:number,repeatY:number)=>{const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;const ctx=canvas.getContext('2d');if(!ctx)return null;const image=ctx.createImageData(512,512);const r=(base>>16)&255,g=(base>>8)&255,b=base&255;for(let i=0;i<image.data.length;i+=4){const n=(Math.random()-.5)*variation;image.data[i]=Math.max(0,Math.min(255,r+n));image.data[i+1]=Math.max(0,Math.min(255,g+n));image.data[i+2]=Math.max(0,Math.min(255,b+n));image.data[i+3]=255}ctx.putImageData(image,0,0);for(let i=0;i<1800;i++){const x=Math.random()*512,y=Math.random()*512,size=Math.random()*2.5;ctx.fillStyle=`rgba(12,15,15,${Math.random()*.2})`;ctx.fillRect(x,y,size,size)}for(let i=0;i<22;i++){ctx.strokeStyle=`rgba(8,10,10,${Math.random()*.22})`;ctx.lineWidth=.5+Math.random()*1.5;ctx.beginPath();let x=Math.random()*512,y=Math.random()*512;ctx.moveTo(x,y);for(let j=0;j<4;j++){x+=(Math.random()-.5)*45;y+=(Math.random()-.5)*45;ctx.lineTo(x,y)}ctx.stroke()}const texture=new THREE.CanvasTexture(canvas);texture.wrapS=THREE.RepeatWrapping;texture.wrapT=THREE.RepeatWrapping;texture.repeat.set(repeatX,repeatY);texture.colorSpace=THREE.SRGBColorSpace;return texture}
      const concreteTexture=makeSurfaceTexture(0x77766d,46,3,3),asphaltTexture=makeSurfaceTexture(0x303436,30,8,24),metalTexture=makeSurfaceTexture(0x555d5d,58,2,2),skinTexture=makeSurfaceTexture(0x63704b,48,2,2)
      weaponMetal.map=metalTexture;weaponMetal.bumpMap=metalTexture;weaponMetal.bumpScale=.025;weaponMetal.needsUpdate=true;weaponPolymer.map=metalTexture;weaponPolymer.needsUpdate=true
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.MeshStandardMaterial({ color: 0x55554e, roughness: 0.96, map:concreteTexture, bumpMap:concreteTexture, bumpScale:.045 }))
      floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor)
      const road = new THREE.Mesh(new THREE.PlaneGeometry(11,180),new THREE.MeshStandardMaterial({color:0x292f30,roughness:1,map:asphaltTexture,bumpMap:asphaltTexture,bumpScale:.025}));road.rotation.x=-Math.PI/2;road.position.y=.025;road.receiveShadow=true;scene.add(road)
      const curbMat=new THREE.MeshStandardMaterial({color:0x77766e,roughness:.95})
      for(const side of [-1,1]){const curb=new THREE.Mesh(new THREE.BoxGeometry(.28,.22,180),curbMat);curb.position.set(side*5.65,.11,0);curb.castShadow=true;curb.receiveShadow=true;scene.add(curb)}
      const laneMat=new THREE.MeshStandardMaterial({color:0xb7a77e,roughness:.8})
      for(let z=-84;z<=84;z+=9){const dash=new THREE.Mesh(new THREE.BoxGeometry(.12,.025,3.2),laneMat);dash.position.set(0,.05,z);scene.add(dash)}
      const buildings: any[] = [], buildingDetails: any[] = []
      const blockMat = [0x77766d,0x5c625f,0x8b8171,0x4c5356].map((c:number)=>new THREE.MeshStandardMaterial({color:c,roughness:.94,map:concreteTexture,bumpMap:concreteTexture,bumpScale:.055}))
      const windowMat=new THREE.MeshStandardMaterial({color:0x20282b,roughness:.38,metalness:.2})
      for (let i=0;i<54;i++) {
        const x = (Math.random()-.5)*105, z = (Math.random()-.5)*105
        if (Math.abs(x)<13 && Math.abs(z)<18) continue
        const w=4+Math.random()*8, h=4+Math.random()*19, d=4+Math.random()*9
        const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),blockMat[i%blockMat.length])
        b.position.set(x,h/2,z); b.castShadow=true; b.receiveShadow=true; scene.add(b); buildings.push(b)
        for(let row=0;row<Math.min(3,Math.floor(h/3));row++)for(let col=0;col<3;col++){const windowPane=new THREE.Mesh(new THREE.BoxGeometry(w*.13,.72,.07),windowMat);windowPane.position.set(x+(col-1)*w*.25,1.7+row*2.05,z+d/2+.045);scene.add(windowPane);buildingDetails.push(windowPane)}
      }
      // Street cover, barriers and wreckage give the arena readable combat lanes.
      for(let i=0;i<22;i++){
        const box=new THREE.Mesh(new THREE.BoxGeometry(2.8,1.15,1.1),new THREE.MeshStandardMaterial({color:i%2?0x66645a:0x77756a,roughness:1}))
        box.position.set((Math.random()-.5)*72,.58,(Math.random()-.5)*72); box.castShadow=true;box.receiveShadow=true;scene.add(box)
      }
      const enemyGroup = new THREE.Group(); scene.add(enemyGroup)
      const aiMapGroup = new THREE.Group(); scene.add(aiMapGroup)
      const enemies: any[] = []
      const enemyMat = new THREE.MeshStandardMaterial({color:0x526b42,roughness:.88})
      const helmetMat = new THREE.MeshStandardMaterial({color:0x252c20,roughness:.72})
      const monsterFlesh = new THREE.MeshStandardMaterial({color:0x526b42,roughness:.82,map:skinTexture,bumpMap:skinTexture,bumpScale:.07})
      const monsterArmor = new THREE.MeshStandardMaterial({color:0x252d28,metalness:.32,roughness:.58,map:metalTexture,bumpMap:metalTexture,bumpScale:.035})
      const monsterGlow = new THREE.MeshStandardMaterial({color:0xff402b,emissive:0xd51d0c,emissiveIntensity:2.2,roughness:.2})
      const buildAIArena = (cfg: GameConfig) => {
        while(aiMapGroup.children.length){const child=aiMapGroup.children.pop();if(child){child.parent=null;child.traverse((o:any)=>{o.geometry?.dispose?.();if(Array.isArray(o.material))o.material.forEach((m:any)=>m.dispose?.());else o.material?.dispose?.()})}}
        const style=(cfg.mapStyle||cfg.arena).toLowerCase(), complexity=Math.max(1,Math.min(5,Number(cfg.mapComplexity)||2))
        const industrial=style.includes('industrial')||style.includes('factory'), forest=style.includes('forest')||style.includes('woodland'), desert=style.includes('desert'), alien=style.includes('alien')||style.includes('organic')
        const concrete=new THREE.MeshStandardMaterial({color:industrial?0x454b4d:forest?0x465443:desert?0x887252:alien?0x343d37:0x5b5c56,roughness:.94,map:concreteTexture,bumpMap:concreteTexture,bumpScale:.055})
        const trim=new THREE.MeshStandardMaterial({color:industrial?0x202a2d:desert?0x51432f:0x343c3b,metalness:.45,roughness:.58})
        const glow=new THREE.MeshStandardMaterial({color:0x8c4b37,emissive:0x542014,emissiveIntensity:.45}),fx=(cfg.specialEffects||'').toLowerCase()
        for(let i=0;i<8+complexity*4;i++){
          const side=i%2?1:-1, z=-34+Math.random()*68, x=side*(8+Math.random()*18), h=2.5+Math.random()*(industrial?10:6), w=2.5+Math.random()*5
          const block=new THREE.Mesh(new THREE.BoxGeometry(w,h,2.5+Math.random()*4),concrete);block.position.set(x,h/2,z);block.castShadow=true;block.receiveShadow=true;aiMapGroup.add(block)
          const stripe=new THREE.Mesh(new THREE.BoxGeometry(w*.82,.12,.035),trim);stripe.position.set(x,h*.68,z-1.27);aiMapGroup.add(stripe)
          if(i%3===0){const lamp=new THREE.PointLight(industrial?0xffa45c:0x9fb8a1,1.1,9);lamp.position.set(x,h*.72,z);aiMapGroup.add(lamp)}
        }
        for(let i=0;i<10+complexity*5;i++){
          const x=(Math.random()-.5)*58,z=(Math.random()-.5)*70
          if(Math.abs(x)<7&&Math.abs(z)<10)continue
          if(forest){const trunk=new THREE.Mesh(new THREE.CylinderGeometry(.16,.28,2.8,7),trim);trunk.position.set(x,1.4,z);trunk.castShadow=true;aiMapGroup.add(trunk);const crown=new THREE.Mesh(new THREE.ConeGeometry(1.45,4.2,7),new THREE.MeshStandardMaterial({color:0x263f30,roughness:1}));crown.position.set(x,4.3,z);crown.castShadow=true;aiMapGroup.add(crown)}
          else if(alien){const spire=new THREE.Mesh(new THREE.ConeGeometry(.55,3+Math.random()*5,7),monsterFlesh);spire.position.set(x,1.8,z);spire.rotation.z=(Math.random()-.5)*.3;spire.castShadow=true;aiMapGroup.add(spire)}
          else {const debris=new THREE.Mesh(new THREE.BoxGeometry(.8+Math.random()*2,.35+Math.random()*.8,.8+Math.random()*2),trim);debris.position.set(x,.25,z);debris.rotation.y=Math.random()*Math.PI;debris.castShadow=true;debris.receiveShadow=true;aiMapGroup.add(debris)}
        }
        const landmark=new THREE.Mesh(new THREE.BoxGeometry(3.8,5.8,2.2),trim);landmark.position.set(0,2.9,-30);landmark.castShadow=true;landmark.receiveShadow=true;aiMapGroup.add(landmark)
        const sign=new THREE.Mesh(new THREE.BoxGeometry(2.2,.55,.08),glow);sign.position.set(0,4.5,-28.82);aiMapGroup.add(sign)
        const dustCount=fx.includes('heavy')||fx.includes('storm')?950:fx.includes('dust')||fx.includes('smoke')?520:180,positions=new Float32Array(dustCount*3);for(let i=0;i<dustCount;i++){positions[i*3]=(Math.random()-.5)*90;positions[i*3+1]=Math.random()*7+.2;positions[i*3+2]=(Math.random()-.5)*90}const dustGeometry=new THREE.BufferGeometry();dustGeometry.setAttribute('position',new THREE.BufferAttribute(positions,3));const dustMaterial=new THREE.PointsMaterial({color:fx.includes('ember')||fx.includes('fire')?0xffa16b:forest?0x9cb68b:0xc5b99b,size:.075,transparent:true,opacity:fx.includes('smoke')?.28:.18,depthWrite:false,sizeAttenuation:true});const dust=new THREE.Points(dustGeometry,dustMaterial);aiMapGroup.add(dust)
      }
      const spawnEnemy = () => {
        const g=new THREE.Group(), limbs:any[]=[]
        const variant=(engine.current?.config?.enemyVariant||engine.current?.config?.enemies||'mutant').toLowerCase()
        const robot=variant.includes('robot')||variant.includes('mech')||variant.includes('cyber'), alien=variant.includes('alien')||variant.includes('xeno'), brute=variant.includes('brute')||variant.includes('demon')||variant.includes('monster')
        const skin=robot?monsterArmor:monsterFlesh, armor=robot?helmetMat:monsterArmor
        const torso=new THREE.Mesh(new THREE.CapsuleGeometry(brute?.48:.37,brute?1.0:.8,6,12),skin);torso.position.y=1.18;torso.castShadow=true;torso.receiveShadow=true;g.add(torso)
        const chest=new THREE.Mesh(new THREE.BoxGeometry(brute?1.02:.72,.48,.38),armor);chest.position.set(0,1.34,-.12);chest.castShadow=true;g.add(chest)
        const head=new THREE.Mesh(robot?new THREE.BoxGeometry(.48,.46,.42):new THREE.SphereGeometry(alien?.29:.25,16,12),skin);head.position.set(0,1.92,-.02);head.castShadow=true;g.add(head)
        const jaw=new THREE.Mesh(new THREE.BoxGeometry(.3,.13,.28),armor);jaw.position.set(0,1.73,-.16);g.add(jaw)
        for(const side of [-1,1]){const eye=new THREE.Mesh(new THREE.SphereGeometry(robot?.075:.065,10,8),monsterGlow);eye.position.set(side*.115,1.96,-.235);g.add(eye);const shoulder=new THREE.Mesh(new THREE.SphereGeometry(.23,10,8),armor);shoulder.position.set(side*.47,1.48,0);shoulder.castShadow=true;g.add(shoulder)
          const arm=new THREE.Group();arm.position.set(side*.48,1.38,0);const upper=new THREE.Mesh(new THREE.CapsuleGeometry(.13,.48,4,8),skin);upper.position.y=-.29;upper.castShadow=true;arm.add(upper);const fore=new THREE.Mesh(new THREE.CapsuleGeometry(.105,.42,4,8),armor);fore.position.set(0,-.68,-.06);fore.castShadow=true;arm.add(fore);const claw=new THREE.Mesh(new THREE.ConeGeometry(.09,.34,7),skin);claw.position.set(0,-.98,-.16);claw.rotation.x=-.7;arm.add(claw);g.add(arm);limbs.push({mesh:arm,side,kind:'arm'})
          const leg=new THREE.Group();leg.position.set(side*.2,.68,0);const thigh=new THREE.Mesh(new THREE.CapsuleGeometry(.15,.52,4,8),armor);thigh.position.y=-.28;thigh.castShadow=true;leg.add(thigh);const shin=new THREE.Mesh(new THREE.CapsuleGeometry(.12,.46,4,8),skin);shin.position.set(0,-.67,-.04);shin.castShadow=true;leg.add(shin);const foot=new THREE.Mesh(new THREE.BoxGeometry(.24,.14,.42),armor);foot.position.set(0,-.94,-.13);leg.add(foot);g.add(leg);limbs.push({mesh:leg,side,kind:'leg'})
        }
        for(let i=0;i<(brute?5:3);i++){const spike=new THREE.Mesh(new THREE.ConeGeometry(.09,.42,6),armor);spike.position.set((i-2)*.17,1.66, .2);spike.rotation.x=-.35;g.add(spike)}
        const weapon=new THREE.Mesh(new THREE.BoxGeometry(.13,.13,.72),robot?armor:new THREE.MeshStandardMaterial({color:0x242b27,metalness:.55,roughness:.4}));weapon.position.set(.31,1.18,-.4);g.add(weapon);if(alien){for(const side of [-1,1]){const tendril=new THREE.Mesh(new THREE.CylinderGeometry(.025,.07,.62,7),skin);tendril.position.set(side*.2,1.55,-.28);tendril.rotation.z=side*.55;tendril.rotation.x=-.45;g.add(tendril)}}
        const angle=Math.random()*Math.PI*2,dist=19+Math.random()*23
        g.position.set(camera.position.x+Math.cos(angle)*dist,0,camera.position.z+Math.sin(angle)*dist)
        enemyGroup.add(g);enemies.push({mesh:g,hp:brute?160:100,nextShot:performance.now()+1500+Math.random()*2500,alive:true,limbs,phase:Math.random()*6,strafe:Math.random()<.5?-1:1,variant:robot?'robot':alien?'alien':'mutant'})
      }
      for(let i=0;i<8;i++) spawnEnemy()
      const raycaster=new THREE.Raycaster()
      const keys:Record<string,boolean>={}
      let yaw=0,pitch=0,locked=false,healthNow=100,ammoNow=30,killsNow=0,level=1,lastShot=0,active=false,frame=0,reloading=false,reloadUntil=0,slideUntil=0,muzzleUntil=0,activeAbility=''
      const bullets:any[]=[]
      const abilityNames=['Combat slide','Quick reload','Adrenaline','Armor plating','Explosive rounds','Overdrive']
      let unlocked=0
      const onKey=(e:KeyboardEvent)=>{keys[e.code]=true;if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();if(e.code==='KeyR'&&!e.repeat&&active&&!reloading&&ammoNow<30){reloading=true;reloadUntil=performance.now()+(activeAbility==='Quick reload'?550:1250);setStatus('Reloading magazine…')}if(e.code==='KeyC'&&!e.repeat&&active&&activeAbility==='Combat slide')slideUntil=performance.now()+520}
      const onUp=(e:KeyboardEvent)=>{keys[e.code]=false}
      const onMove=(e:MouseEvent)=>{if(!locked)return;yaw-=e.movementX*.0022;pitch-=e.movementY*.0022;pitch=Math.max(-1.25,Math.min(1.25,pitch))}
      const onLock=()=>{locked=document.pointerLockElement===renderer.domElement}
      const onClick=()=>{if(!locked){renderer.domElement.requestPointerLock?.();return}if(!active||reloading||ammoNow<=0)return;const cooldown=activeAbility==='Overdrive'?75:135;if(performance.now()-lastShot<cooldown)return;lastShot=performance.now();muzzleUntil=performance.now()+85;weaponModel.position.z=.12;weaponModel.rotation.x=.035;ammoNow--;setAmmo(ammoNow);camera.rotation.set(pitch,yaw,0,'YXZ');raycaster.setFromCamera(new THREE.Vector2(0,0),camera);const hit=raycaster.intersectObjects(enemies.filter(e=>e.alive).flatMap(e=>e.mesh.children),true)[0];const tracerEnd=hit?.point||camera.position.clone().add(raycaster.ray.direction.clone().multiplyScalar(55));const tracerStart=camera.localToWorld(new THREE.Vector3(.32,-.245,-1.39));const tracerGeometry=new THREE.BufferGeometry().setFromPoints([tracerStart,tracerEnd]);const tracer=new THREE.Line(tracerGeometry,new THREE.LineBasicMaterial({color:0xffd18a,transparent:true,opacity:.9}));scene.add(tracer);bullets.push({mesh:tracer,dir:new THREE.Vector3(),life:.075});if(hit){const enemy=enemies.find(e=>e.alive&&e.mesh.getObjectById(hit.object.id));if(enemy){enemy.hp-=activeAbility==='Explosive rounds'?120:55;if(enemy.hp<=0){enemy.alive=false;enemyGroup.remove(enemy.mesh);killsNow++;setKills(killsNow)}}}}
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
        enemies.forEach(e=>{if(!active||!e.alive)return;const dx=camera.position.x-e.mesh.position.x,dz=camera.position.z-e.mesh.position.z,dist=Math.max(.001,Math.hypot(dx,dz)),t=performance.now()*.001+e.phase;e.mesh.rotation.y=Math.atan2(dx,dz);e.mesh.position.y=Math.abs(Math.sin(t*5))*.055;e.limbs.forEach((l:any)=>{const swing=Math.sin(t*7)*(dist>3?.62:.18);l.mesh.rotation.x=l.kind==='leg'?swing*l.side:-swing*l.side*.72});if(dist>8){const behavior=(engine.current?.config?.enemyBehavior||'').toLowerCase(),aggressive=behavior.includes('rush')||behavior.includes('aggressive'),flanking=behavior.includes('flank')||behavior.includes('ambush'),boost=(performance.now()<slideUntil?2.1:1)*(aggressive?1.35:1),flank=flanking?e.strafe*Math.sin(t*.7)*.42:0;e.mesh.position.x+=(dx/dist+flank)*dt*(.58+level*.15)*boost;e.mesh.position.z+=(dz/dist)*dt*(.58+level*.15)*boost}else if(dist<3){e.mesh.position.x-=(dx/dist)*dt*.55;e.mesh.position.z-=(dz/dist)*dt*.55}if(dist<27&&performance.now()>e.nextShot){e.nextShot=performance.now()+Math.max(600,2200-level*150);if(Math.random()<Math.min(.88,.32+level*.04)){const armor=activeAbility==='Armor plating'?.45:1,behavior=(engine.current?.config?.enemyBehavior||'').toLowerCase(),damage=behavior.includes('heavy')||behavior.includes('brutal')?6:behavior.includes('swarm')?2:e.variant==='robot'?4:e.variant==='alien'?5:level>5?5:3;healthNow=Math.max(0,healthNow-damage*armor);setHealth(Math.round(healthNow))}}})
        weaponModel.position.z+=(0-weaponModel.position.z)*Math.min(1,dt*18);weaponModel.rotation.x*=Math.max(0,1-dt*12);weaponModel.position.y=reloading?-.39+Math.sin(performance.now()*.012)*.018:-.28+Math.sin(frame*8)*.006;if(reloading)weaponModel.rotation.x=.2+Math.sin(performance.now()*.012)*.035
        bullets.forEach((b,i)=>{b.life-=dt;b.mesh.position.addScaledVector(b.dir,dt*95);if(b.mesh.material?.opacity!==undefined)b.mesh.material.opacity=Math.max(0,b.life/.075);if(b.life<=0){scene.remove(b.mesh);b.mesh.geometry?.dispose?.();b.mesh.material?.dispose?.();bullets.splice(i,1)}})
        const flashActive=performance.now()<muzzleUntil;muzzleFlash.visible=flashActive;muzzleLight.intensity=flashActive?2.4:0
        if(active&&healthNow<=0){active=false;setRunning(false);setStatus('You were eliminated. Restart the operation to try again.');document.exitPointerLock?.()}
        if(active&&frame>level*38){level++;setWave(level);activeAbility=abilityNames[(unlocked++)%abilityNames.length];setAbility(activeAbility);healthNow=Math.min(100,healthNow+12);setHealth(Math.round(healthNow));ammoNow=30;reloading=false;setAmmo(30);for(let i=0;i<Math.min(4,1+level);i++)spawnEnemy();setStatus('Combat director adapted: '+activeAbility+' unlocked. Threat pressure increased.')}
        if(active&&enemies.filter(e=>e.alive).length<4){for(let i=0;i<2+Math.min(level,4);i++)spawnEnemy()}
        renderer.render(scene,camera)
      }
      setEngineReady(true)
      animate()
      const fogColorSet=(hex:number)=>scene.fog.color.setHex(hex)
      const applyConfig=(next:GameConfig)=>{const mapName=(next.mapStyle||next.arena).toLowerCase(),wildMap=mapName.includes('forest')||mapName.includes('woodland')||mapName.includes('desert')||mapName.includes('alien')||mapName.includes('organic');buildings.forEach((b:any)=>b.visible=!wildMap);buildingDetails.forEach((w:any)=>w.visible=!wildMap);road.visible=!wildMap;const weaponStyle=(next.weaponDesign||next.weapon||'').toLowerCase();weaponMetal.color.setHex(weaponStyle.includes('plasma')||weaponStyle.includes('energy')?0x345f70:weaponStyle.includes('gold')?0x80643a:0x252b2b);weaponPolymer.color.setHex(weaponStyle.includes('white')?0xc3c8c4:weaponStyle.includes('desert')?0x6d6048:0x111716);barrel.scale.z=weaponStyle.includes('sniper')||weaponStyle.includes('long-range')?1.55:weaponStyle.includes('shotgun')?1.2:1;optic.scale.setScalar(weaponStyle.includes('sniper')||weaponStyle.includes('thermal')?1.45:1);magazine.scale.y=weaponStyle.includes('extended')?1.35:1;opticGlass.material.color.setHex(weaponStyle.includes('thermal')?0x9c4032:weaponStyle.includes('holo')?0x54b9bb:0x6e9ca0);const arena=(next.arena+' '+(next.mapStyle||'')).toLowerCase(),night=next.lighting.toLowerCase().includes('night'),desert=arena.includes('desert'),forest=arena.includes('woodland')||arena.includes('forest'),snow=arena.includes('frozen')||arena.includes('snow'),future=next.theme.toLowerCase().includes('futur');const tint=desert?0x9a896b:forest?0x435c43:snow?0x9ba8ad:future?0x263c49:0x55554e;floor.material.color.setHex(tint);const sky=night?0x111a27:desert?0xc4a47b:forest?0x718477:snow?0x9baab7:future?0x344e62:0x87949a;scene.background.setHex(sky);fogColorSet(sky);const effects=(next.specialEffects||'').toLowerCase(),smoky=effects.includes('smoke')||effects.includes('storm'),dusty=effects.includes('dust')||effects.includes('ash');scene.fog.density=night?.019:smoky?.018:dusty?.014:.009;sun.intensity=night?1.35:3.7;sun.color.setHex(night?0x9ab5dc:0xffd3a0);enemyMat.color.setHex(next.enemies.toLowerCase().includes('robot')?0x536b78:next.enemies.toLowerCase().includes('infected')||next.enemies.toLowerCase().includes('mutant')?0x536d45:0x303b3a);monsterFlesh.color.setHex(next.enemies.toLowerCase().includes('alien')?0x477b83:next.enemies.toLowerCase().includes('demon')?0x793b36:0x526b42);buildAIArena(next);level=Math.max(1,Math.min(5,Number(next.difficulty)||1));if(engine.current)engine.current.config=next}
      buildAIArena(DEFAULT_CONFIG)
      engine.current={config:{...DEFAULT_CONFIG},start:()=>{enemies.forEach(e=>enemyGroup.remove(e.mesh));enemies.length=0;for(let i=0;i<8;i++)spawnEnemy();frame=0;level=Math.max(1,Math.min(5,Number((engine.current.config||{}).difficulty)||1));killsNow=0;unlocked=0;activeAbility='';reloading=false;setKills(0);setWave(1);setAbility('None yet');active=true;healthNow=100;ammoNow=30;setHealth(100);setAmmo(30);setRunning(true);setStatus('Operation live. Capture the mouse by clicking the battlefield. WASD move · Shift sprint · R reload · Click fire.');renderer.domElement.requestPointerLock?.()},stop:()=>{active=false;document.exitPointerLock?.()},applyConfig,scene,camera}
      cleanup=()=>{active=false;observer.disconnect();renderer.domElement.removeEventListener('click',onClick);window.removeEventListener('keydown',onKey);window.removeEventListener('keyup',onUp);window.removeEventListener('mousemove',onMove);document.removeEventListener('pointerlockchange',onLock);document.exitPointerLock?.();renderer.dispose();scene.clear();canvasLayer.remove()}
    }).catch(e=>{if(!dead)setError(e.message||'Unable to start 3D renderer')})
    return()=>{dead=true;cleanup?.()}
  },[])

  const generate = async () => {
    setLoading(true);setError('')
    try {
      let next={...config}
      if(apiKey.trim()){
        const response=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+apiKey.trim(),'Content-Type':'application/json'},body:JSON.stringify({model:'nvidia/nemotron-3.5-lightning:free',temperature:.72,max_tokens:900,messages:[{role:'system',content:'You are the game director and procedural level designer for an ambitious AA-quality first-person action game. Return JSON only, no markdown or executable code. Fill these keys: theme, arena, enemies, lighting, difficulty (integer 1-5), weapon, mapStyle (specific level layout/material theme), mapComplexity (integer 1-5), enemyVariant (mutant, brute, alien, robot or infected), enemyBehavior (specific tactical behavior), weaponDesign (detailed weapon appearance and attachments), specialEffects (visual effects direction). Make bold, coherent choices from the player brief. The game runtime safely interprets this structured blueprint to rebuild the level and configure enemy visuals and behavior.'},{role:'user',content:prompt}]})})
        if(!response.ok)throw new Error('Game design request failed ('+response.status+'). Check your RZER API key.')
        const data=await response.json();const raw=data.choices?.[0]?.message?.content||'{}';const parsed=JSON.parse(raw.replace(/\`\`\`json|\`\`\`/g,'').trim());next={...next,...parsed};next.theme=String(next.theme||config.theme);next.arena=String(next.arena||config.arena);next.enemies=String(next.enemies||config.enemies);next.lighting=String(next.lighting||config.lighting);next.weapon=String(next.weapon||config.weapon);next.mapStyle=String(next.mapStyle||next.arena);next.enemyVariant=String(next.enemyVariant||next.enemies);next.enemyBehavior=String(next.enemyBehavior||'Hunt, flank and rush the player');next.weaponDesign=String(next.weaponDesign||next.weapon);next.specialEffects=String(next.specialEffects||'Muzzle flash, impact sparks and drifting dust');next.difficulty=Math.max(1,Math.min(5,Number(next.difficulty)||1));next.mapComplexity=Math.max(1,Math.min(5,Number(next.mapComplexity)||2))
      } else {
        const p=prompt.toLowerCase()
        next={...next,theme:p.includes('sci-fi')||p.includes('futur')?'Futuristic combat':p.includes('desert')?'Desert warfare':p.includes('zombie')||p.includes('infect')?'Survival horror':'Modern military',arena:p.includes('forest')?'Dense woodland combat zone':p.includes('desert')?'Desert military outpost':p.includes('snow')?'Frozen research facility':p.includes('space')?'Orbital industrial station':p.includes('factory')||p.includes('industrial')?'Abandoned industrial complex':'Ruined urban district',enemies:p.includes('robot')?'Armored combat robots':p.includes('alien')?'Hostile alien predators':p.includes('demon')||p.includes('monster')?'Armored mutant brutes':'Mutated infected hunters',lighting:p.includes('night')?'Night operations · volumetric searchlights':p.includes('sunset')?'Warm cinematic sunset':'Cinematic daylight · atmospheric haze',mapStyle:p.includes('forest')?'Dense forest ruins':p.includes('desert')?'Desert fortress and canyon':p.includes('factory')||p.includes('industrial')?'Industrial factory yard':p.includes('alien')||p.includes('space')?'Alien organic megastructure':'Ruined urban combat zone',enemyVariant:p.includes('robot')?'robot':p.includes('alien')?'alien':p.includes('demon')||p.includes('monster')?'brute':'mutant',enemyBehavior:p.includes('flank')?'Aggressive flanking and coordinated rushes':'Hunt, flank and rush the player',weaponDesign:p.includes('sniper')?'Precision long-range rifle with variable optic':'Modular tactical rifle with optic, foregrip and extended magazine',specialEffects:'Cinematic muzzle flash, impact sparks, drifting dust and combat smoke',mapComplexity:3}
      }
      setConfig(next);engine.current?.applyConfig(next);setShowBrief(false);setStatus('AI director rebuilt the battlefield blueprint, enemy faction and combat profile. Deploy when ready.')
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
    <div className="rzer-game-head"><div><h2>Game Studio / Frontline</h2><p>Adaptive first-person combat · Procedural battlefield</p></div><div className="rzer-game-actions"><button onClick={()=>{engine.current?.stop();setRunning(false);setShowBrief(true)}}>Game setup</button><button className="primary" disabled={!engineReady} onClick={()=>engine.current?.start()}> {running?'Restart operation':'Deploy'} </button></div></div>
    <div className="rzer-game-stage" ref={host}>
      <div className="rzer-game-hud"><div className="rzer-game-hud-top"><div>RZER // LIVE COMBAT SIMULATION</div><div>SECTOR 07 · WAVE {wave}</div></div><div className="rzer-crosshair"/><div className="rzer-game-bottom"><div className="rzer-game-stats"><div className="rzer-game-stat"><b>{health}</b><span>HEALTH</span></div><div className="rzer-game-stat"><b>{kills}</b><span>ELIMINATIONS</span></div><div className="rzer-game-stat"><b>{wave}</b><span>THREAT LEVEL</span></div></div><div className="rzer-game-weapon">{config.weapon}<b>{ammo} <small style={{fontSize:12,color:'#c4cfcc'}}>/ 30</small></b></div></div><div className="rzer-game-ability">UNLOCKED ABILITY · <strong>{ability}</strong></div></div>
      {showBrief&&<div className="rzer-game-overlay"><div className="rzer-game-card"><h3>Build your battlefield</h3><p>Describe anything: the AI director rebuilds the arena layout, enemy species and behavior, weapon profile, lighting and effects. For full AI design, add your OpenRouter key in RZER settings; without a key, the local procedural director still works.</p><textarea value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="Describe the game you want…"/><div className="rzer-game-actions" style={{marginTop:12}}><button className="primary" onClick={generate} disabled={loading}>{loading?'Building your game…':'Generate battlefield'}</button><button onClick={()=>setShowBrief(false)}>Keep current setup</button></div>{error&&<p style={{color:'#ff9b86'}}>{error}</p>}<div className="rzer-game-config"><div><small>Environment</small><strong>{config.arena}</strong></div><div><small>Faction</small><strong>{config.enemies}</strong></div><div><small>Visual direction</small><strong>{config.lighting}</strong></div><div><small>Combat style</small><strong>{config.theme} · {config.weapon}</strong></div></div><p>Controls: WASD move · Shift sprint · Mouse aim · Click fire · R reload · Esc release mouse. High-performance WebGL rendering uses your available graphics hardware; performance depends on your browser and GPU drivers.</p></div></div>}
    </div><div className="rzer-game-status" role="status">{error||status} {running?' · The combat director unlocks abilities and raises pressure as you survive.':''}</div>
  </div>
}
