import React, { useState, useRef, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { retargetMixamoClipToVRM, mixamoVRMRigMap } from './loadMixamoAnimation';
import JSZip from 'jszip';

type BaseModel = 
  | { type: 'vrm', object: VRM }
  | { type: 'fbx', object: THREE.Group };

const getMixamoNodeName = (vrmBone: string): string | undefined => {
  return Object.keys(mixamoVRMRigMap).find(k => mixamoVRMRigMap[k] === vrmBone);
};

const CharacterModel = ({ 
  baseModel, animationClip, mixerRef, actionRef, isGenerating, isPaused, togglePause 
}: { 
  baseModel: BaseModel | null; 
  animationClip: THREE.AnimationClip | null; 
  mixerRef: React.MutableRefObject<THREE.AnimationMixer | null>;
  actionRef: React.MutableRefObject<THREE.AnimationAction | null>;
  isGenerating: boolean; 
  isPaused: boolean; 
  togglePause: () => void;
}) => {

  const scene = baseModel?.type === 'vrm' ? baseModel.object.scene : baseModel?.object;

  useEffect(() => {
    if (!scene) return;
    mixerRef.current = new THREE.AnimationMixer(scene);
  }, [scene, mixerRef]);

  useEffect(() => {
    if (!scene || !mixerRef.current || !animationClip) return;
    if (actionRef.current) actionRef.current.stop();

    actionRef.current = mixerRef.current.clipAction(animationClip);
    actionRef.current.play();

    return () => {
      if (actionRef.current) actionRef.current.stop();
    };
  }, [scene, animationClip, mixerRef, actionRef]);

  useEffect(() => {
    if (actionRef.current) {
      actionRef.current.paused = isPaused;
    }
  }, [isPaused, actionRef]);

  useFrame((state, delta) => {
    if (isGenerating) return; 
    if (mixerRef.current) mixerRef.current.update(delta);
    if (baseModel?.type === 'vrm') baseModel.object.update(delta);
  });

  if (!scene) return null;
  return <primitive object={scene} dispose={null} onClick={(e: any) => {
    e.stopPropagation(); 
    togglePause();
  }} />;
};

// 安全機能：3Dの生Canvasに不可逆な変更を与えず、2Dキャンバス上でのみ正方形クロップと解像度リサイズ＆ピクセル化を適用する処理
const resizeAndCropToDataUrl = async (originalDataUrl: string, targetSize: number): Promise<string> => {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = targetSize;
      canvas.height = targetSize;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        // ドット絵感を保つため縮小時の補間を一切無効にする
        ctx.imageSmoothingEnabled = false; 
        
        // 画面が横長/縦長でも中央の正方形領域だけを切り抜く
        const size = Math.min(img.width, img.height);
        const sx = (img.width - size) / 2;
        const sy = (img.height - size) / 2;
        
        ctx.drawImage(img, sx, sy, size, size, 0, 0, targetSize, targetSize);
      }
      resolve(canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, ""));
    };
    img.src = originalDataUrl;
  });
};

const SpriteGenerator = ({ 
  baseModel, animationClip, mixerRef, actionRef, isGenerating, outputResolution, captureFps, onComplete, setStatus 
}: { 
  baseModel: BaseModel | null; 
  animationClip: THREE.AnimationClip | null;
  mixerRef: React.MutableRefObject<THREE.AnimationMixer | null>;
  actionRef: React.MutableRefObject<THREE.AnimationAction | null>;
  isGenerating: boolean; 
  outputResolution: number;
  captureFps: number;
  onComplete: () => void; 
  setStatus: (s:string) => void;
}) => {
  const { gl, scene, camera } = useThree();

  useEffect(() => {
    if (!isGenerating) return; // 【重要】依存配列を最小限にし、無限ループ再発火を阻止
    if (!baseModel) { onComplete(); return; }

    const generate = async () => {
      setStatus(`Preparing to capture ${outputResolution}x${outputResolution} sprites...`);
      const zip = new JSZip();

      const oldClearColor = gl.getClearColor(new THREE.Color());
      const oldClearAlpha = gl.getClearAlpha();
      gl.setClearColor(0x000000, 0);

      const targetScene = baseModel.type === 'vrm' ? baseModel.object.scene : baseModel.object;
      const originalRotationY = targetScene.rotation.y;

      const duration = animationClip ? animationClip.duration : 0;
      const totalFrames = duration > 0 ? Math.floor(duration * captureFps) : 0; 

      for(let i = 0; i < 8; i++) {
        const angleDeg = i * 45;
        targetScene.rotation.y = originalRotationY + (angleDeg * Math.PI) / 180;
        
        for(let frame = 0; frame <= totalFrames; frame++) {
            const time = frame * (1 / captureFps);
            
            if (mixerRef.current && actionRef.current && duration > 0) {
               actionRef.current.time = time;
               mixerRef.current.update(0);
               if (baseModel.type === 'vrm') baseModel.object.update(0);
            }

            gl.render(scene, camera);
            
            const rawDataUrl = gl.domElement.toDataURL("image/png");
            
            // 安全なJSレイヤーでのリサイズ・クロップ処理を噛ませる
            const base64Data = await resizeAndCropToDataUrl(rawDataUrl, outputResolution);
            
            const frameStr = frame.toString().padStart(3, '0');
            zip.file(`dir_${angleDeg}/frame_${frameStr}.png`, base64Data, {base64: true});

            setStatus(`Capturing Dir: ${angleDeg}°, Frame: ${frame}/${totalFrames}`);
            // フリーズを回避するための確実なウェイト
            await new Promise(r => setTimeout(r, 20));
        }
      }

      targetScene.rotation.y = originalRotationY;
      gl.setClearColor(oldClearColor, oldClearAlpha);

      setStatus("Zipping all hundreds of frames...");
      const content = await zip.generateAsync({type:"blob"});
      const a = document.createElement("a");
      a.href = URL.createObjectURL(content);
      a.download = `sprites_${outputResolution}px_${captureFps}fps.zip`;
      a.click();

      setStatus("Sprite Sheet Generation Complete!");
      onComplete();
    };

    generate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGenerating]); 

  return null;
};


function App() {
  const [baseModel, setBaseModel] = useState<BaseModel | null>(null);
  const [animationClip, setAnimationClip] = useState<THREE.AnimationClip | null>(null);
  const [status, setStatus] = useState<string>("Wait for files drop...");
  
  const [adjustTarget, setAdjustTarget] = useState<string>('character');
  const [equipments, setEquipments] = useState<Partial<Record<VRMHumanBoneName, THREE.Object3D>>>({});
  const [targetFileNames, setTargetFileNames] = useState<Record<string, string>>({
    character: '', rightHand: '', leftHand: ''
  });

  const [transforms, setTransforms] = useState<Record<string, {px:number,py:number,pz:number, rx:number,ry:number,rz:number, s:number}>>({
    character: { px:0, py:0, pz:0, rx:0, ry:0, rz:0, s:1 },
    rightHand: { px:0, py:0, pz:0, rx:0, ry:0, rz:0, s:1 },
    leftHand:  { px:0, py:0, pz:0, rx:0, ry:0, rz:0, s:1 }
  });

  const [outputResolution, setOutputResolution] = useState<number>(256);
  const [captureFps, setCaptureFps] = useState<number>(15);

  const [isGenerating, setIsGenerating] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const actionRef = useRef<THREE.AnimationAction | null>(null);

  useEffect(() => {
    Object.keys(transforms).forEach(target => {
      const fName = targetFileNames[target];
      if (fName) {
        localStorage.setItem(`vrm-asset-gen-${fName}`, JSON.stringify(transforms[target]));
      }
    });
  }, [transforms, targetFileNames]);

  useEffect(() => {
    Object.keys(equipments).forEach((boneName) => {
      const obj = equipments[boneName as VRMHumanBoneName];
      const t = transforms[boneName];
      if (obj && t) {
        const parentScaleCorrection = baseModel?.type === 'fbx' ? 100.0 : 1.0;
        obj.position.set( t.px * parentScaleCorrection, t.py * parentScaleCorrection, t.pz * parentScaleCorrection );
        obj.rotation.set(THREE.MathUtils.degToRad(t.rx), THREE.MathUtils.degToRad(t.ry), THREE.MathUtils.degToRad(t.rz));
        obj.scale.setScalar(parentScaleCorrection * t.s);
      }
    });

    const baseObj = baseModel?.type === 'vrm' ? baseModel.object.scene : baseModel?.object;
    const tBase = transforms['character'];
    if (baseObj && tBase) {
      baseObj.position.set(tBase.px, tBase.py, tBase.pz);
      baseObj.rotation.set(THREE.MathUtils.degToRad(tBase.rx), Math.PI + THREE.MathUtils.degToRad(tBase.ry), THREE.MathUtils.degToRad(tBase.rz));
      const autoScale = baseModel?.type === 'fbx' ? 0.01 : 1.0;
      baseObj.scale.setScalar(autoScale * tBase.s);
    }
  }, [equipments, transforms, baseModel]);

  const updateTransform = (axis: string, value: number) => {
    setTransforms(prev => ({ ...prev, [adjustTarget]: { ...prev[adjustTarget], [axis]: value } }));
  };

  const handleSaveConfig = () => {
    const fName = targetFileNames[adjustTarget] || `${adjustTarget}_config`;
    const t = transforms[adjustTarget];
    const blob = new Blob([JSON.stringify(t, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fName}.json`;
    a.click();
    setStatus(`Config saved as ${fName}.json`);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;

    const droppedConfigs: Record<string, any> = {};
    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.json')) {
        try {
          const text = await file.text();
          droppedConfigs[file.name] = JSON.parse(text);
          setStatus(`Parsed JSON config: ${file.name}`);
        } catch (err) { }
      }
    }

    for (const file of files) {
      const ext = file.name.toLowerCase();
      const url = URL.createObjectURL(file);

      const tryLoadTransform = (fName: string) => {
        const defaultT = { px:0, py:0, pz:0, rx:0, ry:0, rz:0, s:1 };
        if (droppedConfigs[`${fName}.json`]) return droppedConfigs[`${fName}.json`];
        const nameWithoutExt = fName.replace(/\.[^/.]+$/, "");
        if (droppedConfigs[`${nameWithoutExt}.json`]) return droppedConfigs[`${nameWithoutExt}.json`];
        const saved = localStorage.getItem(`vrm-asset-gen-${fName}`);
        if (saved) { try { return JSON.parse(saved); } catch(e) {} }
        return defaultT;
      };

      if (ext.endsWith('.vrm')) {
        setStatus(`Loading VRM: ${file.name}...`);
        try {
          const loader = new GLTFLoader();
          loader.register((parser) => new VRMLoaderPlugin(parser));
          loader.load(url, (gltf) => {
            const vrmData = gltf.userData.vrm as VRM;
            if (vrmData) {
              VRMUtils.removeUnnecessaryVertices(gltf.scene);
              VRMUtils.removeUnnecessaryJoints(gltf.scene);
              vrmData.scene.traverse((obj) => { obj.frustumCulled = false; });
              
              const humBones = Object.keys(equipments) as VRMHumanBoneName[];
              humBones.forEach(bn => {
                 const b = vrmData.humanoid?.getNormalizedBoneNode(bn);
                 if (b && equipments[bn]) b.remove(equipments[bn]!);
              });
              setEquipments({});
              setBaseModel({ type: 'vrm', object: vrmData });
              setAnimationClip(null);
              
              setTargetFileNames(p => ({ ...p, character: file.name }));
              setTransforms(p => ({ ...p, character: tryLoadTransform(file.name) }));
              setStatus(`Loaded VRM: ${file.name}`);
            }
          }, undefined, (e) => setStatus(`Error: ${e}`));
        } catch (err: any) { setStatus(`Error: ${err.message}`); }
        
      } else if (ext.endsWith('.fbx')) {
        setStatus(`Loading FBX: ${file.name}...`);
        try {
          new FBXLoader().load(url, (fbx) => {
            if (!baseModel) {
              fbx.traverse((obj) => { obj.frustumCulled = false; });
              setEquipments({});
              setBaseModel({ type: 'fbx', object: fbx });
              setAnimationClip(null);
              
              setTargetFileNames(p => ({ ...p, character: file.name }));
              setTransforms(p => ({ ...p, character: tryLoadTransform(file.name) }));
              setStatus(`Loaded FBX Character: ${file.name}`);
            } else {
              if (fbx.animations.length > 0) {
                let clip = fbx.animations[0];
                if (baseModel.type === 'vrm') {
                  clip = retargetMixamoClipToVRM(clip, baseModel.object, fbx);
                }
                setAnimationClip(clip);
                setStatus(`Applied animation: ${file.name}`);
              } else {
                setStatus("Error: No animation in FBX.");
              }
            }
          }, undefined, (e) => setStatus(`Error: ${e}`));
        } catch (err) { setStatus(`Error: ${err}`); }
        
      } else if (ext.endsWith('.glb') || ext.endsWith('.gltf')) {
        if (!baseModel) { setStatus("Error: Load .vrm or character .fbx first!"); return; }
        setStatus(`Loading equipment: ${file.name}...`);
        try {
          new GLTFLoader().load(url, (gltf) => {
            let targetBone: THREE.Object3D | null | undefined = null;
            if (adjustTarget === 'character') { setStatus("Error: Select 'Right Hand' or 'Left Hand' target."); return; }

            if (baseModel.type === 'vrm') {
              targetBone = baseModel.object.humanoid?.getNormalizedBoneNode(adjustTarget as VRMHumanBoneName);
            } else {
              const mixamoName = getMixamoNodeName(adjustTarget);
              if (mixamoName) targetBone = baseModel.object.getObjectByName(mixamoName);
            }
            
            if (targetBone) {
              if (equipments[adjustTarget as VRMHumanBoneName]) targetBone.remove(equipments[adjustTarget as VRMHumanBoneName]!);
              targetBone.add(gltf.scene);
              setEquipments(prev => ({ ...prev, [adjustTarget as VRMHumanBoneName]: gltf.scene }));
              
              setTargetFileNames(p => ({ ...p, [adjustTarget]: file.name }));
              setTransforms(p => ({ ...p, [adjustTarget]: tryLoadTransform(file.name) }));
              setStatus(`Equipped and loaded config for ${file.name}`);
            } else { setStatus(`Error: Bone not found in target rig.`); }
          }, undefined, (e) => setStatus(`Error: ${e}`));
        } catch (err) { setStatus(`Error: ${err}`); }
      }
    }
  };

  const t = transforms[adjustTarget];

  return (
    <div 
      style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: '#222', color: '#fff' }}
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      <div style={{ padding: '10px', background: '#333', textAlign: 'center', zIndex: 10 }}>
        <h2>Asset Generator (VRM & FBX)</h2>
        <div style={{ marginBottom: '10px', fontSize: '0.9em' }}>
          <span style={{ marginRight: '15px', color:'#aed581' }}>1. Drop .vrm (or .fbx char)</span>
          <span style={{ marginRight: '15px', color:'#ffb74d' }}>2. Drop .fbx (animation)</span>
          <span style={{ color:'#81d4fa' }}>3. Drop .glb (weapon/shield)</span>
        </div>
        
        <div style={{ padding: '8px', background: '#444', display: 'inline-block', borderRadius: '5px' }}>
          <strong>Target: </strong>
          <label style={{ marginLeft: 15, cursor: 'pointer' }}>
            <input type="radio" checked={adjustTarget === 'character'} onChange={() => setAdjustTarget('character')} /> Character(Base)
          </label>
          <label style={{ marginLeft: 15, cursor: 'pointer' }}>
            <input type="radio" checked={adjustTarget === 'rightHand'} onChange={() => setAdjustTarget('rightHand')} /> Right Hand
          </label>
          <label style={{ marginLeft: 15, cursor: 'pointer' }}>
            <input type="radio" checked={adjustTarget === 'leftHand'} onChange={() => setAdjustTarget('leftHand')} /> Left Hand
          </label>
        </div>
        
        <p style={{fontSize: '0.9em', marginTop: '10px', marginBottom: 0}}>Status: <strong style={{color: '#4fc3f7'}}>{status}</strong></p>
      </div>

      <div style={{ position: 'absolute', top: 160, right: 20, background: 'rgba(0,0,0,0.8)', padding: '15px 20px', borderRadius: 8, width: 350, zIndex: 10, border: '1px solid #555' }}>
        <h3 style={{marginTop: 0, fontSize: 16, borderBottom: '1px solid #444', paddingBottom: 8}}>Setting for: {adjustTarget}</h3>
        <p style={{margin: '0 0 10px 0', fontSize: 12, color:'gray'}}>File: {targetFileNames[adjustTarget] || 'None'}</p>

        <div style={{display:'flex', gap: 10, marginBottom: 15}}>
           <button onClick={handleSaveConfig} style={{flex: 1, padding: '5px', cursor: 'pointer', background:'#4fc3f7', color:'#000', border:'none', borderRadius:3}}>💾 Save .json</button>
        </div>

        {['px', 'py', 'pz'].map(axis => (
           <div key={axis} style={{display:'flex', alignItems:'center', justifyContent:'space-between', fontSize: 14, margin: '8px 0'}}>
             <span style={{width: 30}}>P{axis.toUpperCase()[1]}</span>
             <input type="range" min="-1" max="1" step="0.001" value={t[axis as keyof typeof t]} onChange={e => updateTransform(axis, parseFloat(e.target.value))} style={{flex: 1, margin: '0 10px'}} />
             <span style={{width: 40, textAlign: 'right'}}>{t[axis as keyof typeof t].toFixed(3)}</span>
           </div>
        ))}
        {['rx', 'ry', 'rz'].map(axis => (
           <div key={axis} style={{display:'flex', alignItems:'center', justifyContent:'space-between', fontSize: 14, margin: '8px 0'}}>
             <span style={{width: 30}}>R{axis.toUpperCase()[1]}</span>
             <input type="range" min="-180" max="180" step="0.1" value={t[axis as keyof typeof t]} onChange={e => updateTransform(axis, parseFloat(e.target.value))} style={{flex: 1, margin: '0 10px'}} />
             <span style={{width: 40, textAlign: 'right'}}>{t[axis as keyof typeof t].toFixed(1)}°</span>
           </div>
        ))}
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', fontSize: 14, margin: '8px 0'}}>
             <span style={{width: 30}}>S</span>
             <input type="range" min="-3" max="1.5" step="0.01" value={Math.log10(t.s)} onChange={e => updateTransform('s', Math.pow(10, parseFloat(e.target.value)))} style={{flex: 1, margin: '0 10px'}}/>
             <span style={{width: 45, textAlign: 'right'}}>{t.s < 0.1 ? t.s.toFixed(3) : t.s.toFixed(2)}</span>
        </div>
      </div>

      <div style={{ position: 'absolute', bottom: 30, left: 30, zIndex: 10, display: 'flex', flexDirection: 'column', gap: '15px' }}>
         <div style={{ background: 'rgba(0,0,0,0.8)', padding: '15px 20px', borderRadius: '8px', border: '1px solid #555' }}>
            <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
               <span style={{ width: 100, fontWeight: 'bold' }}>Resolution:</span>
               <select value={outputResolution} onChange={e => setOutputResolution(Number(e.target.value))} style={{ padding: '6px', width: 150, background: '#444', color: '#fff', border: 'none', borderRadius: 4 }}>
                  <option value={64}>64 x 64</option>
                  <option value={128}>128 x 128</option>
                  <option value={256}>256 x 256</option>
                  <option value={512}>512 x 512</option>
               </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
               <span style={{ width: 100, fontWeight: 'bold' }}>Capture FPS:</span>
               <select value={captureFps} onChange={e => setCaptureFps(Number(e.target.value))} style={{ padding: '6px', width: 150, background: '#444', color: '#fff', border: 'none', borderRadius: 4 }}>
                  <option value={10}>10 FPS (Rough)</option>
                  <option value={15}>15 FPS (Half)</option>
                  <option value={30}>30 FPS (Full)</option>
                  <option value={60}>60 FPS (Ultra)</option>
               </select>
            </div>
         </div>

         <div style={{ display: 'flex', gap: '15px' }}>
           <button 
             disabled={!baseModel}
             onClick={() => setIsPaused(!isPaused)} 
             style={{ padding: '15px 25px', fontSize: '18px', background: isPaused ? '#4CAF50' : '#f44336', color: 'white', border: 'none', borderRadius: '30px', cursor: 'pointer', boxShadow: '0 4px 10px rgba(0,0,0,0.5)', fontWeight: 'bold' }}
           >
             {isPaused ? "▶ Play" : "⏸ Pause"}
           </button>
           
           <button 
             disabled={!baseModel || isGenerating}
             onClick={() => setIsGenerating(true)} 
             style={{ padding: '15px 30px', fontSize: '18px', background: '#ff4081', color: 'white', border: 'none', borderRadius: '30px', cursor: 'pointer', boxShadow: '0 4px 10px rgba(0,0,0,0.5)', fontWeight: 'bold' }}
           >
             {isGenerating ? "Capturing..." : "Generate 8-Dir FPS (ZIP)"}
           </button>
         </div>
      </div>

      <div style={{ flex: 1, position: 'relative' }}>
        <Canvas gl={{ preserveDrawingBuffer: true, alpha: true, antialias: false }} camera={{ position: [0, 1.2, 3], fov: 45 }}>
          <ambientLight intensity={1.5} />
          <directionalLight position={[1, 1, 1]} intensity={2.0} />
          <Environment preset="city" />
          
          <CharacterModel 
            baseModel={baseModel} 
            animationClip={animationClip} 
            mixerRef={mixerRef}
            actionRef={actionRef}
            isGenerating={isGenerating} 
            isPaused={isPaused} 
            togglePause={() => setIsPaused(p => !p)} 
          />

          {!isGenerating && <gridHelper args={[10, 10]} />}
          
          <SpriteGenerator 
             baseModel={baseModel} 
             animationClip={animationClip}
             mixerRef={mixerRef}
             actionRef={actionRef}
             isGenerating={isGenerating} 
             outputResolution={outputResolution}
             captureFps={captureFps}
             onComplete={() => setIsGenerating(false)}
             setStatus={setStatus} 
          />

          <OrbitControls target={[0, 1, 0]} enablePan={true} enableDamping={true} />
        </Canvas>
      </div>
    </div>
  );
}

export default App;
