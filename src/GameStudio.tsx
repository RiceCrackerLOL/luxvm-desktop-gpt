import React, { useEffect, useRef, useState } from 'react'
import { getTacticalFireRange, getTacticalMovement, selectTacticalTarget } from './confederateAI'

declare global { interface Window { THREE?: any } }

type GameConfig = { theme: string; arena: string; enemies: string; lighting: string; difficulty: number; weapon: string; mapStyle?: string; enemyBehavior?: string; enemyVariant?: string; weaponDesign?: string; specialEffects?: string; mapComplexity?: number; worldPalette?: { ground?: string; structures?: string; accent?: string; sky?: string; fog?: string; emissive?: string }; mapFeatures?: Array<{ name?: string; shape?: string; x?: number; z?: number; width?: number; height?: number; depth?: number; color?: string; material?: string }>; enemyRoster?: Array<{ name?: string; type?: string; color?: string; accent?: string; scale?: number; health?: number; speed?: number; damage?: number; count?: number }>; weaponBlueprint?: { name?: string; bodyColor?: string; accentColor?: string; optic?: string; barrel?: string; magazine?: string; fireRate?: number; damage?: number; ammo?: number }; gameplayRules?: { waveSize?: number; enemySpeed?: number; playerHealth?: number; abilityInterval?: number } }
const DEFAULT_CONFIG: GameConfig = { theme: 'Anime action adventure', arena: 'Vietnam jungle island', enemies: 'Three rival anime fighter factions', lighting: 'Cinematic anime sunset with luminous atmosphere', difficulty: 1, weapon: 'Cel-shaded energy rifle', mapStyle: 'Anime jungle forest island', enemyBehavior: 'Rival squads patrol, hunt, flank and fight each other', enemyVariant: 'Anime fighters', weaponDesign: 'Stylized energy rifle with glowing accents', specialEffects: 'Colorful energy trails, sparks, glowing impacts and drifting petals', mapComplexity: 3, worldPalette: { ground: '#385b45', structures: '#647b61', accent: '#ffcf6e', sky: '#8eb9dc', fog: '#91b9d5', emissive: '#ff8fc8' } }

let threeModulePromise: Promise<any> | null = null

function loadThree(): Promise<any> {
  if (!threeModulePromise) {
    const moduleUrl = 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js'
    threeModulePromise = import(/* @vite-ignore */ moduleUrl).catch((error) => {
      threeModulePromise = null
      throw new Error('Could not load the Three.js 3D engine. Check your internet connection or CDN access. ' + (error?.message || ''))
    })
  }
  return threeModulePromise
}

export default function GameStudio({ apiKey }: { apiKey: string }) {
  const host = useRef<HTMLDivElement>(null)
  const engine = useRef<any>(null)
  const [prompt, setPrompt] = useState('Create an anime-style Vietnam jungle island battlefield inspired by the Far Cry 5 Vietnam AA Gun map. Use vivid cel-shaded colors, expressive stylized characters, dramatic skies, bold silhouettes, glowing weapon effects, and cinematic anime lighting. Keep the map landmarks: two separated Ack-Ack gun sites, an escape route, heavy-weapons cache, old fire base, and Triple-A position. Three rival anime factions must continuously patrol, hunt and fight each other. Expand the world with new jungle clearings, ruins, outposts and terrain while the battle continues.')
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
  const [showBrief, setShowBrief] = useState(false)

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
      scene.background = new THREE.Color(0x91b9d5)
      scene.fog = new THREE.FogExp2(0x91b9d5, 0.009)
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
      renderer.toneMappingExposure = 1.35
      renderer.setClearColor(0x91b9d5)
      renderer.domElement.style.width = '100%'
      renderer.domElement.style.height = '100%'
      renderer.domElement.style.display = 'block'
      canvasLayer.appendChild(renderer.domElement)
      scene.add(new THREE.HemisphereLight(0xdaf1ff, 0x51415e, 2.35))
      scene.add(new THREE.DirectionalLight(0xffe2f0,1.1))
      const sun = new THREE.DirectionalLight(0xffd3a0, 3.2)
      sun.position.set(-35, 55, 25); sun.castShadow = true
      sun.shadow.mapSize.set(2048, 2048)
      sun.shadow.camera.left = -70; sun.shadow.camera.right = 70; sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70
      scene.add(sun)
      const makeSurfaceTexture=(base:number,variation:number,repeatX:number,repeatY:number)=>{const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;const ctx=canvas.getContext('2d');if(!ctx)return null;const image=ctx.createImageData(512,512);const r=(base>>16)&255,g=(base>>8)&255,b=base&255;for(let i=0;i<image.data.length;i+=4){const n=(Math.random()-.5)*variation;image.data[i]=Math.max(0,Math.min(255,r+n));image.data[i+1]=Math.max(0,Math.min(255,g+n));image.data[i+2]=Math.max(0,Math.min(255,b+n));image.data[i+3]=255}ctx.putImageData(image,0,0);for(let i=0;i<1800;i++){const x=Math.random()*512,y=Math.random()*512,size=Math.random()*2.5;ctx.fillStyle=`rgba(12,15,15,${Math.random()*.2})`;ctx.fillRect(x,y,size,size)}for(let i=0;i<22;i++){ctx.strokeStyle=`rgba(8,10,10,${Math.random()*.22})`;ctx.lineWidth=.5+Math.random()*1.5;ctx.beginPath();let x=Math.random()*512,y=Math.random()*512;ctx.moveTo(x,y);for(let j=0;j<4;j++){x+=(Math.random()-.5)*45;y+=(Math.random()-.5)*45;ctx.lineTo(x,y)}ctx.stroke()}const texture=new THREE.CanvasTexture(canvas);texture.wrapS=THREE.RepeatWrapping;texture.wrapT=THREE.RepeatWrapping;texture.repeat.set(repeatX,repeatY);texture.colorSpace=THREE.SRGBColorSpace;return texture};
      const concreteTexture=makeSurfaceTexture(0x77766d,46,3,3),asphaltTexture=makeSurfaceTexture(0x303436,30,8,24),metalTexture=makeSurfaceTexture(0x555d5d,58,2,2),skinTexture=makeSurfaceTexture(0x63704b,48,2,2)
      weaponMetal.map=metalTexture;weaponMetal.bumpMap=metalTexture;weaponMetal.bumpScale=.025;weaponMetal.needsUpdate=true;weaponPolymer.map=metalTexture;weaponPolymer.needsUpdate=true
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.MeshToonMaterial({ color: 0x55554e, map:concreteTexture, bumpMap:concreteTexture, bumpScale:.045 }))
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
        const box=new THREE.Mesh(new THREE.BoxGeometry(2.8,1.15,1.1),new THREE.MeshToonMaterial({color:i%2?0x66645a:0x77756a}))
        box.position.set((Math.random()-.5)*72,.58,(Math.random()-.5)*72); box.castShadow=true;box.receiveShadow=true;scene.add(box)
      }
      const enemyGroup = new THREE.Group(); scene.add(enemyGroup)
      const aiMapGroup = new THREE.Group(); scene.add(aiMapGroup)
      const enemies: any[] = []
      const worldGenGroup = new THREE.Group(); scene.add(worldGenGroup)
      const worldChunks: any[] = []
      let nextWorldGen = 0
      const enemyMat = new THREE.MeshToonMaterial({color:0x526b42})
      const helmetMat = new THREE.MeshToonMaterial({color:0x252c20})
      const monsterFlesh = new THREE.MeshToonMaterial({color:0x526b42})
      const monsterArmor = new THREE.MeshToonMaterial({color:0x252d28})
      const monsterGlow = new THREE.MeshStandardMaterial({color:0xff402b,emissive:0xd51d0c,emissiveIntensity:2.2,roughness:.2})
      const buildAIArena = (cfg: GameConfig) => {
        while(aiMapGroup.children.length){const child=aiMapGroup.children.pop();if(child){child.parent=null;child.traverse((o:any)=>{o.geometry?.dispose?.();if(Array.isArray(o.material))o.material.forEach((m:any)=>m.dispose?.());else o.material?.dispose?.()})}}
        const style=(cfg.mapStyle||cfg.arena).toLowerCase(), complexity=Math.max(1,Math.min(5,Number(cfg.mapComplexity)||2))
        const industrial=style.includes('industrial')||style.includes('factory'), forest=style.includes('forest')||style.includes('woodland'), desert=style.includes('desert'), alien=style.includes('alien')||style.includes('organic')
        const concrete=new THREE.MeshToonMaterial({color:industrial?0x454b4d:forest?0x465443:desert?0x887252:alien?0x343d37:0x5b5c56,map:concreteTexture,bumpMap:concreteTexture,bumpScale:.055})
        const trim=new THREE.MeshToonMaterial({color:industrial?0x202a2d:desert?0x51432f:0x343c3b})
        const glow=new THREE.MeshToonMaterial({color:0x8c4b37,emissive:0x542014,emissiveIntensity:.65}),fx=(cfg.specialEffects||'').toLowerCase()
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
        const palette=cfg.worldPalette||{},colorOf=(v:any,fallback:number)=>{if(typeof v!=='string'||!/^#?[0-9a-f]{6}$/i.test(v))return fallback;return parseInt(v.replace('#',''),16)}
        const featureMaterial=new THREE.MeshToonMaterial({color:colorOf(palette.structures,industrial?0x454b4d:forest?0x465443:desert?0x887252:alien?0x343d37:0x5b5c56),map:concreteTexture,bumpMap:concreteTexture,bumpScale:.04})
        const accentMaterial=new THREE.MeshToonMaterial({color:colorOf(palette.accent,0x9b7650),emissive:colorOf(palette.emissive,0x24140b),emissiveIntensity:.8})
        ;(Array.isArray(cfg.mapFeatures)?cfg.mapFeatures:[]).slice(0,36).forEach((feature:any,index:number)=>{
          const w=Math.max(1,Math.min(18,Number(feature.width)||4)),h=Math.max(.5,Math.min(24,Number(feature.height)||3)),d=Math.max(1,Math.min(18,Number(feature.depth)||4)),shape=String(feature.shape||'building').toLowerCase()
          const geometry=shape.includes('cylinder')||shape.includes('tower')?new THREE.CylinderGeometry(w*.5,w*.62,h,10):shape.includes('sphere')||shape.includes('boulder')?new THREE.DodecahedronGeometry(Math.max(w,h,d)*.42,1):shape.includes('wall')?new THREE.BoxGeometry(w,h*.65,Math.max(.35,d*.2)):new THREE.BoxGeometry(w,h,d)
          const material=new THREE.MeshStandardMaterial({color:colorOf(feature.color,colorOf(palette.structures,0x555b59)),roughness:feature.material==='metal'?.42:.88,metalness:feature.material==='metal'?.62:.08,map:concreteTexture,bumpMap:concreteTexture,bumpScale:.035})
          const mesh=new THREE.Mesh(geometry,material);mesh.position.set(Math.max(-48,Math.min(48,Number(feature.x)||0)),h*.5,Math.max(-48,Math.min(48,Number(feature.z)||0)));mesh.castShadow=true;mesh.receiveShadow=true;aiMapGroup.add(mesh)
          if(index%3===0){const marker=new THREE.Mesh(new THREE.BoxGeometry(Math.min(w*.6,2.4),.09,.09),accentMaterial);marker.position.set(mesh.position.x,h*.72,mesh.position.z-d*.52);aiMapGroup.add(marker)}
        })
        const dustCount=fx.includes('heavy')||fx.includes('storm')?950:fx.includes('dust')||fx.includes('smoke')?520:180,positions=new Float32Array(dustCount*3);for(let i=0;i<dustCount;i++){positions[i*3]=(Math.random()-.5)*90;positions[i*3+1]=Math.random()*7+.2;positions[i*3+2]=(Math.random()-.5)*90}const dustGeometry=new THREE.BufferGeometry();dustGeometry.setAttribute('position',new THREE.BufferAttribute(positions,3));const dustMaterial=new THREE.PointsMaterial({color:fx.includes('ember')||fx.includes('fire')?0xffa16b:forest?0x9cb68b:0xc5b99b,size:.075,transparent:true,opacity:fx.includes('smoke')?.28:.18,depthWrite:false,sizeAttenuation:true});const dust=new THREE.Points(dustGeometry,dustMaterial);aiMapGroup.add(dust)
      }
      const spawnEnemy = () => {
        const g=new THREE.Group(), limbs:any[]=[]
        const gameCfg=engine.current?.config||DEFAULT_CONFIG,roster=Array.isArray(gameCfg.enemyRoster)?gameCfg.enemyRoster:[],chosen=roster.length?roster[Math.floor(Math.random()*roster.length)]:null
        const team=Math.floor(Math.random()*3),teamColors=[0xff5478,0x49c9ff,0xffd166],teamColor=teamColors[team]
        const toon=(color:number)=>new THREE.MeshToonMaterial({color,gradientMap:null})
        const ink=new THREE.MeshBasicMaterial({color:0x171526,side:THREE.BackSide})
        const body=toon(teamColor),dark=toon(0x25243b),skin=toon(team===0?0xffd0bd:team===1?0xffdfc2:0xf4c6a4),hair=toon([0x27213e,0x1d2638,0x6b2d55,0xe7a83e][Math.floor(Math.random()*4)]),white=toon(0xffffff),iris=toon(teamColor)
        const torso=new THREE.Mesh(new THREE.CapsuleGeometry(.34,.65,5,10),body);torso.position.y=1.15;torso.castShadow=true;g.add(torso)
        const chest=new THREE.Mesh(new THREE.BoxGeometry(.68,.42,.34),dark);chest.position.set(0,1.25,-.12);g.add(chest)
        const head=new THREE.Mesh(new THREE.SphereGeometry(.34,16,12),skin);head.position.set(0,1.91,-.03);head.scale.set(1,1.12,.9);head.castShadow=true;g.add(head)
        const headInk=new THREE.Mesh(new THREE.SphereGeometry(.35,16,12),ink);headInk.position.copy(head.position);headInk.scale.copy(head.scale).multiplyScalar(1.055);g.add(headInk);headInk.renderOrder=1
        const fringe=new THREE.Mesh(new THREE.ConeGeometry(.39,.5,7),hair);fringe.position.set(0,2.17,-.02);fringe.rotation.x=.12;g.add(fringe)
        for(let k=0;k<3;k++){const spike=new THREE.Mesh(new THREE.ConeGeometry(.13,.42,5),hair);spike.position.set((k-1)*.22,2.32,.02);spike.rotation.z=(k-1)*-.35;g.add(spike)}
        for(const side of [-1,1]){const eyeWhite=new THREE.Mesh(new THREE.SphereGeometry(.105,12,10),white);eyeWhite.position.set(side*.13,1.96,-.323);eyeWhite.scale.set(1,.72,.5);g.add(eyeWhite);const eye=new THREE.Mesh(new THREE.SphereGeometry(.067,12,10),iris);eye.position.set(side*.13,1.955,-.367);eye.scale.set(.8,1,.45);g.add(eye);const shine=new THREE.Mesh(new THREE.SphereGeometry(.022,8,8),white);shine.position.set(side*.145,1.99,-.385);g.add(shine)}
        for(const side of [-1,1]){
          const shoulder=new THREE.Mesh(new THREE.SphereGeometry(.19,10,8),dark);shoulder.position.set(side*.43,1.42,0);g.add(shoulder)
          const arm=new THREE.Group();arm.position.set(side*.43,1.34,0);const upper=new THREE.Mesh(new THREE.CapsuleGeometry(.105,.38,4,8),body);upper.position.y=-.23;arm.add(upper);const fore=new THREE.Mesh(new THREE.CapsuleGeometry(.09,.34,4,8),skin);fore.position.set(0,-.57,-.06);arm.add(fore);g.add(arm);limbs.push({mesh:arm,side,kind:'arm'})
          const leg=new THREE.Group();leg.position.set(side*.18,.68,0);const thigh=new THREE.Mesh(new THREE.CapsuleGeometry(.12,.42,4,8),dark);thigh.position.y=-.23;leg.add(thigh);const boot=new THREE.Mesh(new THREE.BoxGeometry(.22,.15,.34),body);boot.position.set(0,-.55,-.1);leg.add(boot);g.add(leg);limbs.push({mesh:leg,side,kind:'leg'})
        }
        const blade=new THREE.Mesh(new THREE.BoxGeometry(.09,.09,.66),toon(0x20283c));blade.position.set(.28,1.15,-.38);g.add(blade)
        const angle=Math.random()*Math.PI*2,dist=14+Math.random()*34
        g.position.set(camera.position.x+Math.cos(angle)*dist,0,camera.position.z+Math.sin(angle)*dist)
        enemyGroup.add(g)
        const scale=Math.max(.75,Math.min(1.3,Number(chosen?.scale)||(.92+Math.random()*.2)));g.scale.setScalar(scale)
        enemies.push({mesh:g,hp:Math.max(45,Math.min(360,Number(chosen?.health)||95)),maxHp:Math.max(45,Math.min(360,Number(chosen?.health)||95)),damage:Math.max(5,Math.min(28,Number(chosen?.damage)||9)),speed:.9+Math.random()*.85,nextShot:performance.now()+800+Math.random()*2400,alive:true,limbs,phase:Math.random()*6,strafe:Math.random()<.5?-1:1,team,teamColor,variant:'anime',role:['assault','support','flanker','guard'][enemies.length%4],target:null,targetAt:0,respawnAt:0})      }
      {for(let i=0;i<18;i++)spawnEnemy()}
      const raycaster=new THREE.Raycaster()
      const keys:Record<string,boolean>={}
      let yaw=0,pitch=0,locked=false,healthNow=100,ammoNow=30,killsNow=0,level=1,lastShot=0,active=false,frame=0,reloading=false,reloadUntil=0,slideUntil=0,muzzleUntil=0,activeAbility=''
      const bullets:any[]=[]
      const abilityNames=['Combat slide','Quick reload','Adrenaline','Armor plating','Explosive rounds','Overdrive']
      let unlocked=0
      const onKey=(e:KeyboardEvent)=>{keys[e.code]=true;if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();if(e.code==='KeyR'&&!e.repeat&&active&&!reloading&&ammoNow<Math.max(8,Math.min(60,Number(engine.current?.config?.weaponBlueprint?.ammo)||30))){reloading=true;reloadUntil=performance.now()+(activeAbility==='Quick reload'?550:1250);setStatus('Reloading magazine…')}if(e.code==='KeyC'&&!e.repeat&&active&&activeAbility==='Combat slide')slideUntil=performance.now()+520}
      const onUp=(e:KeyboardEvent)=>{keys[e.code]=false}
      const onMove=(e:MouseEvent)=>{if(!locked)return;yaw-=e.movementX*.0022;pitch-=e.movementY*.0022;pitch=Math.max(-1.25,Math.min(1.25,pitch))}
      const onLock=()=>{locked=document.pointerLockElement===renderer.domElement}
      const onClick=()=>{if(!locked){renderer.domElement.requestPointerLock?.();return}if(!active||reloading||ammoNow<=0)return;const weaponSpec=engine.current?.config?.weaponBlueprint||{},baseRate=Math.max(2,Math.min(12,Number(weaponSpec.fireRate)||7)),cooldown=activeAbility==='Overdrive'?Math.max(55,1000/(baseRate*1.45)):1000/baseRate;if(performance.now()-lastShot<cooldown)return;lastShot=performance.now();muzzleUntil=performance.now()+85;weaponModel.position.z=.12;weaponModel.rotation.x=.035;ammoNow--;setAmmo(ammoNow);camera.rotation.set(pitch,yaw,0,'YXZ');raycaster.setFromCamera(new THREE.Vector2(0,0),camera);const hit=raycaster.intersectObjects(enemies.filter(e=>e.alive).flatMap(e=>e.mesh.children),true)[0];const tracerEnd=hit?.point||camera.position.clone().add(raycaster.ray.direction.clone().multiplyScalar(55));const tracerStart=camera.localToWorld(new THREE.Vector3(.32,-.245,-1.39));const tracerGeometry=new THREE.BufferGeometry().setFromPoints([tracerStart,tracerEnd]);const tracer=new THREE.Line(tracerGeometry,new THREE.LineBasicMaterial({color:0xffd18a,transparent:true,opacity:.9}));scene.add(tracer);bullets.push({mesh:tracer,dir:new THREE.Vector3(),life:.075});if(hit){const enemy=enemies.find(e=>e.alive&&e.mesh.getObjectById(hit.object.id));if(enemy){enemy.hp-=activeAbility==='Explosive rounds'?120:Math.max(12,Math.min(100,Number(weaponSpec.damage)||55));if(enemy.hp<=0){enemy.alive=false;enemy.respawnAt=performance.now()+2200+Math.random()*2500;enemyGroup.remove(enemy.mesh);killsNow++;setKills(killsNow)}}}}
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
        if(active&&reloading&&performance.now()>=reloadUntil){ammoNow=Math.max(8,Math.min(60,Number(engine.current?.config?.weaponBlueprint?.ammo)||30));reloading=false;setAmmo(ammoNow);setStatus('Magazine reloaded.')}
        enemies.forEach(e=>{
          if(!e.alive)return
          const t=performance.now()*.001+e.phase
          if(performance.now()>e.targetAt||!e.target?.alive){e.target=selectTacticalTarget(e,enemies);e.targetAt=performance.now()+450+Math.random()*500}
          const target=e.target
          if(target?.alive){
            const dx=target.mesh.position.x-e.mesh.position.x,dz=target.mesh.position.z-e.mesh.position.z,dist=Math.max(.001,Math.hypot(dx,dz))
            e.mesh.rotation.y=Math.atan2(dx,dz)
            e.mesh.position.y=Math.abs(Math.sin(t*7))*.045
            e.limbs.forEach((l:any)=>{const swing=Math.sin(t*9)*(dist>3?.68:.2);l.mesh.rotation.x=l.kind==='leg'?swing*l.side:-swing*l.side*.7})
            const movement=getTacticalMovement(e,target,t);if(movement.x||movement.z){e.mesh.position.x+=movement.x*dt*(1.7*e.speed);e.mesh.position.z+=movement.z*dt*(1.7*e.speed)}
            if(dist<getTacticalFireRange(e.role)&&performance.now()>e.nextShot){
              e.nextShot=performance.now()+700+Math.random()*900
              const start=e.mesh.position.clone().add(new THREE.Vector3(0,1.45,0)),end=target.mesh.position.clone().add(new THREE.Vector3(0,1.3,0))
              const beam=new THREE.Line(new THREE.BufferGeometry().setFromPoints([start,end]),new THREE.LineBasicMaterial({color:e.teamColor,transparent:true,opacity:.95}))
              scene.add(beam);setTimeout(()=>{scene.remove(beam);beam.geometry.dispose();beam.material.dispose()},130)
              if(Math.random()<.78){target.hp-=e.damage;if(target.hp<=0){target.alive=false;target.respawnAt=performance.now()+1800+Math.random()*3000;enemyGroup.remove(target.mesh)}}
            }
          }else if(performance.now()>e.nextShot)e.nextShot=performance.now()+400
          if(active){const pdx=camera.position.x-e.mesh.position.x,pdz=camera.position.z-e.mesh.position.z,pdist=Math.hypot(pdx,pdz);if(pdist<18&&performance.now()>e.playerShot){e.playerShot=performance.now()+1800+Math.random()*1700;if(Math.random()<.18){const armor=activeAbility==='Armor plating'?.45:1;healthNow=Math.max(0,healthNow-e.damage*.35*armor);setHealth(Math.round(healthNow))}}}
        })
        enemies.forEach(e=>{if(!e.alive&&performance.now()>e.respawnAt){e.alive=true;e.hp=e.maxHp;e.mesh.position.set(camera.position.x+(Math.random()-.5)*70,0,camera.position.z-24-Math.random()*35);enemyGroup.add(e.mesh)}})
        if(enemies.length<24&&performance.now()>nextWorldGen-1200){for(let i=0;i<Math.min(3,24-enemies.length);i++)spawnEnemy()}
        if(performance.now()>nextWorldGen){
          nextWorldGen=performance.now()+8500
          const chunk=new THREE.Group(),palette=[0x63c6a5,0xffb86b,0x9d8cff,0x5d8fff,0xff719d],tone=palette[Math.floor(Math.random()*palette.length)]
          const cx=(Math.random()-.5)*90,cz=(Math.random()-.5)*90
          for(let i=0;i<5+Math.floor(Math.random()*5);i++){
            const x=cx+(Math.random()-.5)*18,z=cz+(Math.random()-.5)*18,h=1+Math.random()*5
            const trunk=new THREE.Mesh(new THREE.CylinderGeometry(.12,.22,h*.45,6),new THREE.MeshToonMaterial({color:0x594a52}));trunk.position.set(x,h*.225,z);chunk.add(trunk)
            const crown=new THREE.Mesh(new THREE.IcosahedronGeometry(.8+Math.random()*1.4,1),new THREE.MeshToonMaterial({color:Math.random()<.7?0x347e68:tone}));crown.position.set(x,h*.7,z);crown.scale.y=1.2;chunk.add(crown)
          }
          for(let i=0;i<2;i++){const ruin=new THREE.Mesh(new THREE.BoxGeometry(2+Math.random()*3,1+Math.random()*2,1.5),new THREE.MeshToonMaterial({color:tone}));ruin.position.set(cx+(Math.random()-.5)*14,.7,cz+(Math.random()-.5)*14);ruin.rotation.y=Math.random()*Math.PI;chunk.add(ruin)}
          worldGenGroup.add(chunk);worldChunks.push({group:chunk,born:performance.now()})
          while(worldChunks.length>7){const old=worldChunks.shift();worldGenGroup.remove(old.group)}
        }

        weaponModel.position.z+=(0-weaponModel.position.z)*Math.min(1,dt*18);weaponModel.rotation.x*=Math.max(0,1-dt*12);weaponModel.position.y=reloading?-.39+Math.sin(performance.now()*.012)*.018:-.28+Math.sin(frame*8)*.006;if(reloading)weaponModel.rotation.x=.2+Math.sin(performance.now()*.012)*.035
        bullets.forEach((b,i)=>{b.life-=dt;b.mesh.position.addScaledVector(b.dir,dt*95);if(b.mesh.material?.opacity!==undefined)b.mesh.material.opacity=Math.max(0,b.life/.075);if(b.life<=0){scene.remove(b.mesh);b.mesh.geometry?.dispose?.();b.mesh.material?.dispose?.();bullets.splice(i,1)}})
        const flashActive=performance.now()<muzzleUntil;muzzleFlash.visible=flashActive;muzzleLight.intensity=flashActive?2.4:0
        if(active&&healthNow<=0){active=false;setRunning(false);setStatus('You were eliminated. Restart the operation to try again.');document.exitPointerLock?.()}
        if(active&&frame>level*38){level++;setWave(level);activeAbility=abilityNames[(unlocked++)%abilityNames.length];setAbility(activeAbility);healthNow=Math.min(100,healthNow+12);setHealth(Math.round(healthNow));ammoNow=30;reloading=false;setAmmo(30);for(let i=0;i<Math.min(4,1+level);i++)spawnEnemy();setStatus('Combat director adapted: '+activeAbility+' unlocked. Threat pressure increased.')}
        if(active&&enemies.filter(e=>e.alive).length<4){const waveSize=Math.max(4,Math.min(14,Number(engine.current?.config?.gameplayRules?.waveSize)||6));for(let i=0;i<Math.min(waveSize,2+Math.min(level,4));i++)spawnEnemy()}
        renderer.render(scene,camera)
      }
      setEngineReady(true)
      animate()
      const fogColorSet=(hex:number)=>scene.fog.color.setHex(hex)
      const applyConfig=(next:GameConfig)=>{const mapName=(next.mapStyle||next.arena).toLowerCase(),wildMap=mapName.includes('forest')||mapName.includes('woodland')||mapName.includes('desert')||mapName.includes('alien')||mapName.includes('organic');buildings.forEach((b:any)=>b.visible=!wildMap);buildingDetails.forEach((w:any)=>w.visible=!wildMap);road.visible=!wildMap;const weaponSpec=next.weaponBlueprint||{},weaponStyle=((next.weaponDesign||next.weapon||'')+' '+(weaponSpec.optic||'')+' '+(weaponSpec.barrel||'')+' '+(weaponSpec.magazine||'')).toLowerCase(),safeHex=(value:any,fallback:number)=>typeof value==='string'&&/^#?[0-9a-f]{6}$/i.test(value)?parseInt(value.replace('#',''),16):fallback;weaponMetal.color.setHex(weaponStyle.includes('plasma')||weaponStyle.includes('energy')?0x345f70:weaponStyle.includes('gold')?0x80643a:0x252b2b);weaponPolymer.color.setHex(safeHex(weaponSpec.bodyColor,weaponStyle.includes('white')?0xc3c8c4:weaponStyle.includes('desert')?0x6d6048:0x111716));weaponMetal.color.setHex(safeHex(weaponSpec.accentColor,weaponMetal.color.getHex()));barrel.scale.z=weaponStyle.includes('sniper')||weaponStyle.includes('long-range')?1.55:weaponStyle.includes('shotgun')?1.2:1;optic.scale.setScalar(weaponStyle.includes('sniper')||weaponStyle.includes('thermal')?1.45:1);magazine.scale.y=weaponStyle.includes('extended')?1.35:1;opticGlass.material.color.setHex(weaponStyle.includes('thermal')?0x9c4032:weaponStyle.includes('holo')?0x54b9bb:0x6e9ca0);const arena=(next.arena+' '+(next.mapStyle||'')).toLowerCase(),night=next.lighting.toLowerCase().includes('night'),desert=arena.includes('desert'),forest=arena.includes('woodland')||arena.includes('forest'),snow=arena.includes('frozen')||arena.includes('snow'),future=next.theme.toLowerCase().includes('futur');const palette=next.worldPalette||{},tint= safeHex(palette.ground,desert?0x9a896b:forest?0x435c43:snow?0x9ba8ad:future?0x263c49:0x55554e);floor.material.color.setHex(tint);const sky=safeHex(palette.sky,night?0x111a27:desert?0xc4a47b:forest?0x718477:snow?0x9baab7:future?0x344e62:0x87949a);scene.background.setHex(sky);fogColorSet(safeHex(palette.fog,sky));const effects=(next.specialEffects||'').toLowerCase(),smoky=effects.includes('smoke')||effects.includes('storm'),dusty=effects.includes('dust')||effects.includes('ash');scene.fog.density=night?.019:smoky?.018:dusty?.014:.009;sun.intensity=night?1.35:3.7;sun.color.setHex(night?0x9ab5dc:0xffd3a0);enemyMat.color.setHex(safeHex(next.enemyRoster?.[0]?.color,next.enemies.toLowerCase().includes('robot')?0x536b78:next.enemies.toLowerCase().includes('infected')||next.enemies.toLowerCase().includes('mutant')?0x536d45:0x303b3a));monsterFlesh.color.setHex(safeHex(next.enemyRoster?.[0]?.color,next.enemies.toLowerCase().includes('alien')?0x477b83:next.enemies.toLowerCase().includes('demon')?0x793b36:0x526b42));buildAIArena(next);level=Math.max(1,Math.min(5,Number(next.difficulty)||1));if(engine.current)engine.current.config=next}
      engine.current={config:{...DEFAULT_CONFIG},start:()=>{enemies.forEach(e=>enemyGroup.remove(e.mesh));enemies.length=0;{const roster=engine.current?.config?.enemyRoster||[],count=roster.length?roster.reduce((sum:number,item:any)=>sum+Math.max(1,Math.min(8,Number(item.count)||2)),0):8;for(let i=0;i<Math.max(4,Math.min(16,count));i++)spawnEnemy()}frame=0;level=Math.max(1,Math.min(5,Number((engine.current.config||{}).difficulty)||1));killsNow=0;unlocked=0;activeAbility='';reloading=false;setKills(0);setWave(1);setAbility('None yet');active=true;healthNow=Math.max(75,Math.min(150,Number(engine.current?.config?.gameplayRules?.playerHealth)||100));ammoNow=Math.max(8,Math.min(60,Number(engine.current?.config?.weaponBlueprint?.ammo)||30));setHealth(healthNow);setAmmo(ammoNow);setRunning(true);setStatus('Anime battlefield live. Rival squads fight autonomously and the world expands every few seconds. Click to aim · WASD move · Shift sprint · R reload · Click fire.');renderer.domElement.requestPointerLock?.()},stop:()=>{active=false;document.exitPointerLock?.()},applyConfig,scene,camera}
      applyConfig(DEFAULT_CONFIG)
      cleanup=()=>{active=false;observer.disconnect();renderer.domElement.removeEventListener('click',onClick);window.removeEventListener('keydown',onKey);window.removeEventListener('keyup',onUp);window.removeEventListener('mousemove',onMove);document.removeEventListener('pointerlockchange',onLock);document.exitPointerLock?.();renderer.dispose();scene.clear();canvasLayer.remove()}
    }).catch(e=>{if(!dead){const message=e?.message||'Unable to start 3D renderer';setError(message);setStatus('3D engine failed to initialize: '+message)}})
    return()=>{dead=true;cleanup?.()}
  },[])

  const generate = async () => {
    setLoading(true);setError('');setShowBrief(false);setStatus('AI director is designing the world, enemies, weapons and combat rules in the background. You can keep playing.')
    try {
      let next={...config}
      if(apiKey.trim()){
        const response=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+apiKey.trim(),'Content-Type':'application/json'},body:JSON.stringify({model:'nvidia/nemotron-3-ultra-550b-a55b:free',temperature:.72,max_tokens:6000,reasoning:{effort:'high',exclude:true},messages:[{role:'system',content:'You are Nemotron, the autonomous game director and procedural game designer for RZER. You are responsible for designing the actual playable game, not merely suggesting settings. Return one valid JSON object only; never return markdown, prose, or executable code. Design every subsystem from the player brief. Required scalar keys: theme, arena, enemies, lighting, difficulty (1-5), weapon, mapStyle, mapComplexity (1-5), enemyVariant (mutant/brute/alien/robot/infected), enemyBehavior, weaponDesign, specialEffects. Also generate worldPalette with hex colors ground, structures, accent, sky, fog, emissive. Generate mapFeatures as 12-24 concrete objects with name, shape (building/wall/tower/cylinder/sphere/boulder), x and z (-45..45), width, height, depth, color hex, material (concrete/metal/organic/rock). Make a coherent traversable combat layout with cover and landmarks; leave the central spawn lane clear. Generate enemyRoster with 2-4 distinct enemy types, each with name, type (mutant/brute/alien/robot/infected), color and accent hex, scale (0.7..1.6), health (60..300), speed (0.7..2.5), damage (6..28), count (1..8). Generate weaponBlueprint with name, bodyColor and accentColor hex, optic, barrel, magazine, fireRate (2..12), damage (12..80), ammo (8..60). Generate gameplayRules with waveSize (4..14), enemySpeed (0.7..2.5), playerHealth (75..150), abilityInterval (3..8). Be imaginative and specific: the arrays and values directly control geometry, colors, enemy silhouettes/stats, weapon appearance and combat pacing in the game runtime. Keep arrays within limits and all coordinates/numbers valid. Do not omit these arrays. MAP REFERENCE DIRECTIVE: The user supplied the Wand Far Cry 5 Vietnam AA Gun checklist map as the visual/layout reference (https://wand.com/maps/far-cry-5/vietnam/checklist/missions/aa-gun). Build an original playable Vietnam jungle-island battlefield inspired by its broad geography and mission landmarks, not a copied image or claimed exact coordinate reconstruction. The reference checklist identifies Ack-Ack (two checklist entries), Escape, Heavy Weapon, Old Fire Base, and Triple-A. Represent these as distinct recognizable combat landmarks in the generated mapFeatures: two separated anti-aircraft gun emplacements, an escape route/extraction path, a heavy-weapons cache or bunker, an old fortified fire base, and a larger Triple-A anti-aircraft position. Give the island a dense forest canopy feel through clustered tree-like structures, uneven rocky ridgelines, ravines, a winding dirt road, clearings, scattered military structures, sandbag cover, watchtowers, wreckage, and a river or valley crossing. Arrange landmarks as a connected route with meaningful combat spaces and sightlines; do not put every landmark in one cluster. Keep the spawn area safe and make the route navigable in the existing game runtime.'},{role:'user',content:prompt}]})})
        if(!response.ok)throw new Error('Game design request failed ('+response.status+'). Check your RZER API key.')
        const data=await response.json();const raw=String(data.choices?.[0]?.message?.content||'');const cleaned=raw.replace(/\`\`\`json|\`\`\`/g,'').trim();const jsonStart=cleaned.indexOf('{'),jsonEnd=cleaned.lastIndexOf('}');if(jsonStart<0||jsonEnd<=jsonStart)throw new Error('The AI director returned an incomplete game blueprint. Try generating again.');const parsed=JSON.parse(cleaned.slice(jsonStart,jsonEnd+1));next={...next,...parsed};next.theme=String(next.theme||config.theme);next.arena=String(next.arena||config.arena);next.enemies=String(next.enemies||config.enemies);next.lighting=String(next.lighting||config.lighting);next.weapon=String(next.weaponBlueprint?.name||next.weapon||config.weapon);next.mapStyle=String(next.mapStyle||next.arena);next.enemyVariant=String(next.enemyVariant||next.enemies);next.enemyBehavior=String(next.enemyBehavior||'Hunt, flank and rush the player');next.weaponDesign=String(next.weaponDesign||next.weapon);next.specialEffects=String(next.specialEffects||'Muzzle flash, impact sparks and drifting dust');next.difficulty=Math.max(1,Math.min(5,Number(next.difficulty)||1));next.mapComplexity=Math.max(1,Math.min(5,Number(next.mapComplexity)||2));next.mapFeatures=Array.isArray(next.mapFeatures)?next.mapFeatures.slice(0,36):[];next.enemyRoster=Array.isArray(next.enemyRoster)?next.enemyRoster.slice(0,4):[];next.worldPalette=next.worldPalette&&typeof next.worldPalette==='object'?next.worldPalette:{};next.weaponBlueprint=next.weaponBlueprint&&typeof next.weaponBlueprint==='object'?next.weaponBlueprint:{};next.gameplayRules=next.gameplayRules&&typeof next.gameplayRules==='object'?next.gameplayRules:{};next.enemyRoster=next.enemyRoster.map((e:any)=>({...e,type:String(e.type||'mutant'),count:Math.max(1,Math.min(8,Number(e.count)||2)),health:Math.max(60,Math.min(300,Number(e.health)||100)),speed:Math.max(.7,Math.min(2.5,Number(e.speed)||1)),damage:Math.max(6,Math.min(28,Number(e.damage)||12))}))
      } else {
        throw new Error('Nemotron is not connected. Add your OpenRouter API key in RZER settings to generate the actual game.')
      }
      setConfig(next);engine.current?.applyConfig(next);setStatus('Nemotron 3 Ultra finished the background build. The new world, enemy roster, weapon and combat rules are now live.')
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
    <div className="rzer-game-head"><div><h2>Game Studio / Anime Frontline</h2><p>Living anime battlefield · Autonomous faction warfare · Endless world generation</p></div><div className="rzer-game-actions"><button onClick={()=>{engine.current?.stop();setRunning(false);setShowBrief(true)}}>Game setup</button><button className="primary" disabled={!engineReady} onClick={()=>engine.current?.start()}> {running?'Restart operation':'Deploy'} </button></div></div>
    <div className="rzer-game-stage" ref={host}>
      <div className="rzer-game-hud"><div className="rzer-game-hud-top"><div>RZER // ANIME WORLD SIMULATION</div><div>SECTOR 07 · WAVE {wave}</div></div><div className="rzer-crosshair"/><div className="rzer-game-bottom"><div className="rzer-game-stats"><div className="rzer-game-stat"><b>{health}</b><span>HEALTH</span></div><div className="rzer-game-stat"><b>{kills}</b><span>ELIMINATIONS</span></div><div className="rzer-game-stat"><b>{wave}</b><span>THREAT LEVEL</span></div></div><div className="rzer-game-weapon">{config.weapon}<b>{ammo} <small style={{fontSize:12,color:'#c4cfcc'}}>/ 30</small></b></div></div><div className="rzer-game-ability">UNLOCKED ABILITY · <strong>{ability}</strong></div></div>
      {showBrief&&<div className="rzer-game-overlay"><div className="rzer-game-card"><h3>Build your battlefield</h3><p>Describe the game you want. Nemotron 3 Ultra designs the map, enemy species and behaviors, weapon, lighting, effects and combat rules. Generation runs in the background, so you can close this panel and keep playing while the new build is prepared. Add your OpenRouter API key in RZER settings to use the free model.</p><textarea value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="Describe the game you want…"/><div className="rzer-game-actions" style={{marginTop:12}}><button className="primary" onClick={generate} disabled={loading}>{loading?'Designing in background…':'Design in background'}</button><button onClick={()=>setShowBrief(false)}>Keep current setup</button></div>{error&&<p style={{color:'#ff9b86'}}>{error}</p>}<div className="rzer-game-config"><div><small>Environment</small><strong>{config.arena}</strong></div><div><small>Faction</small><strong>{config.enemies}</strong></div><div><small>Visual direction</small><strong>{config.lighting}</strong></div><div><small>Combat style</small><strong>{config.theme} · {config.weapon}</strong></div></div><p>Controls: WASD move · Shift sprint · Mouse aim · Click fire · R reload · Esc release mouse. High-performance WebGL rendering uses your available graphics hardware; performance depends on your browser and GPU drivers.</p></div></div>}
    </div><div className="rzer-game-status" role="status">{loading?'AI DIRECTOR // DESIGNING YOUR GAME IN THE BACKGROUND':error||status} {running?' · Rival factions battle continuously while new terrain is generated.':''}</div>
  </div>
}
