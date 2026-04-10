import React, { useState, useRef, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { retargetMixamoClipToVRM, mixamoVRMRigMap } from './loadMixamoAnimation';
import JSZip from 'jszip';
import { EffectComposer, wrapEffect, Bloom } from '@react-three/postprocessing';
import { Effect, EffectAttribute } from 'postprocessing';
import { Uniform } from 'three';

const fragmentShader = `
  uniform float width;
  uniform float strength;
  uniform float cameraNear;
  uniform float cameraFar;

  float getLinearDepth(vec2 uv) {
    float d = texture2D(depthBuffer, uv).r;
    return (2.0 * cameraNear) / (cameraFar + cameraNear - d * (cameraFar - cameraNear));
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec2 texelSize = vec2(width) / resolution;
    
    float d = getLinearDepth(uv);
    float d1 = getLinearDepth(uv + vec2(-texelSize.x, -texelSize.y));
    float d2 = getLinearDepth(uv + vec2(0, -texelSize.y));
    float d3 = getLinearDepth(uv + vec2(texelSize.x, -texelSize.y));
    float d4 = getLinearDepth(uv + vec2(-texelSize.x, 0));
    float d6 = getLinearDepth(uv + vec2(texelSize.x, 0));
    float d7 = getLinearDepth(uv + vec2(-texelSize.x, texelSize.y));
    float d8 = getLinearDepth(uv + vec2(0, texelSize.y));
    float d9 = getLinearDepth(uv + vec2(texelSize.x, texelSize.y));

    float gx = (d3 + 2.0*d6 + d9) - (d1 + 2.0*d4 + d7);
    float gy = (d7 + 2.0*d8 + d9) - (d1 + 2.0*d2 + d3);
    float edge = sqrt(gx*gx + gy*gy);
    
    // 閾値を大幅に下げて、小さな段差（足の間など）も検知しやすくする
    float threshold = 0.0005 / (strength * 100.0 + 0.1);
    float edgeFactor = smoothstep(threshold, threshold * 1.5, edge);
    
    outputColor = vec4(mix(inputColor.rgb, vec3(0.0), edgeFactor), inputColor.a);
  }
`;

const ToonOutlineEffect = wrapEffect(class extends Effect {
  constructor() {
    super("ToonOutlineEffect", fragmentShader, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([
        ["width", new Uniform(1.0)],
        ["strength", new Uniform(1.0)],
        ["cameraNear", new Uniform(0.1)],
        ["cameraFar", new Uniform(100.0)]
      ])
    });
  }
  update(_renderer: any, _inputBuffer: any, _deltaTime: any) {
    const widthUniform = this.uniforms.get("width");
    const strengthUniform = this.uniforms.get("strength");
    const nearUniform = this.uniforms.get("cameraNear");
    const farUniform = this.uniforms.get("cameraFar");
    
    if (widthUniform) widthUniform.value = (this as any).width || 1.0;
    if (strengthUniform) strengthUniform.value = (this as any).strength || 1.0;
    if (nearUniform) nearUniform.value = (this as any).cameraNear || 0.1;
    if (farUniform) farUniform.value = (this as any).cameraFar || 1000.0;
  }
});

function SceneEffects({ globalOutlineWidth, composerRef }: { globalOutlineWidth: number, composerRef: any }) {
  const { camera } = useThree();
  return (
    <EffectComposer ref={composerRef} multisampling={0}>
      {globalOutlineWidth > 0 ? (
        <ToonOutlineEffect 
          width={1.0} 
          strength={globalOutlineWidth}
          cameraNear={camera.near}
          cameraFar={camera.far}
        />
      ) : <Bloom intensity={0} />}
    </EffectComposer>
  );
}

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

  useFrame((_, delta) => {
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
  baseModel, animationClip, mixerRef, actionRef, isGenerating, outputResolution, captureFps, onComplete, setStatus, composerRef
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
  composerRef: React.MutableRefObject<any>;
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
      const stepDelta = duration > 0 ? 1 / captureFps : 0;

      // ── 物理ウォームアップパス ──
      // 揺れものの物理シミュレーションが「0秒から連続的に積み上げ」られるよう、
      // 撮影前にアニメーション1周分をサイレントで流しておく。
      if (mixerRef.current && actionRef.current && duration > 0) {
        setStatus("Warming up physics simulation...");
        actionRef.current.time = 0;
        mixerRef.current.update(0);
        for (let f = 0; f <= totalFrames; f++) {
          mixerRef.current.update(stepDelta);
          if (baseModel.type === 'vrm') baseModel.object.update(stepDelta);
          await new Promise(r => setTimeout(r, 5));
        }
        // ウォームアップ完了後、時間を0に戻して本番キャプチャへ
        actionRef.current.time = 0;
        mixerRef.current.update(0);
        if (baseModel.type === 'vrm') baseModel.object.update(0);
      }

      // ── 本番キャプチャ：8方向 × 全フレーム ──
      for(let i = 0; i < 8; i++) {
        const angleDeg = i * 45;
        targetScene.rotation.y = originalRotationY + (angleDeg * Math.PI) / 180;

        // 各方向の最初のフレームへ時間をリセットしてから1フレームずつ積み上げる
        if (mixerRef.current && actionRef.current && duration > 0) {
          actionRef.current.time = 0;
          mixerRef.current.update(0);
          if (baseModel.type === 'vrm') baseModel.object.update(0);
        }
        
        for(let frame = 0; frame <= totalFrames; frame++) {
            // 物理シミュレーションを「差分（1フレーム分）」で正確にコマ送りする
            if (mixerRef.current && duration > 0) {
               mixerRef.current.update(frame === 0 ? 0 : stepDelta);
               if (baseModel.type === 'vrm') baseModel.object.update(frame === 0 ? 0 : stepDelta);
            }

            // ポストエフェクトが有効な場合は Composer でレンダリングし、そうでなければ直接 gl でレンダリング
            if (composerRef.current) {
              composerRef.current.render();
            } else {
              gl.render(scene, camera);
            }
            
            const rawDataUrl = gl.domElement.toDataURL("image/png");
            const base64Data = await resizeAndCropToDataUrl(rawDataUrl, outputResolution);
            
            const frameStr = frame.toString().padStart(3, '0');
            zip.file(`dir_${angleDeg}/frame_${frameStr}.png`, base64Data, {base64: true});

            setStatus(`Capturing Dir: ${angleDeg}°, Frame: ${frame}/${totalFrames}`);
            await new Promise(r => setTimeout(r, 15));
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
  const composerRef = useRef<any>(null);

  const [vrmOutlineWidth, setVrmOutlineWidth] = useState<number>(0.0); // 0.05
  const [globalOutlineWidth, setGlobalOutlineWidth] = useState<number>(0.0); // 1.0

  // VRM Outline Width Control
  useEffect(() => {
    if (baseModel?.type === 'vrm') {
      baseModel.object.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.material) {
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          materials.forEach((m: any) => {
            if (m.isMToonMaterial) {
              m.outlineWidthFactor = vrmOutlineWidth;
            }
          });
        }
      });
    }
  }, [baseModel, vrmOutlineWidth]);

  // Auto-Save to LocalStorage (Multi-Character Support)
  useEffect(() => {
    const currentChar = targetFileNames.character || 'default';
    Object.keys(transforms).forEach(target => {
      const fName = targetFileNames[target];
      if (fName && target !== 'character') { // 武器・盾のみを対象
        const key = `vrm-asset-gen-v2-${fName}`;
        const existingRaw = localStorage.getItem(key);
        let multiConfig: Record<string, any> = {};
        
        try {
          if (existingRaw) {
            const parsed = JSON.parse(existingRaw);
            // 旧形式データの互換性：直接 px 等がある場合はラップする
            multiConfig = (parsed.px !== undefined) ? { "legacy": parsed } : parsed;
          }
        } catch(e) {}
        
        multiConfig[currentChar] = transforms[target];
        multiConfig["_lastChar"] = currentChar;
        localStorage.setItem(key, JSON.stringify(multiConfig));
      } else if (fName && target === 'character') {
         // キャラクター自身のベース位置設定
         const key = `vrm-asset-gen-char-${fName}`;
         localStorage.setItem(key, JSON.stringify(transforms[target]));
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
    const currentChar = targetFileNames.character || 'default';
    
    // 既存のデータを取得（LocalStorageなどからマージ情報を得る）
    const key = adjustTarget === 'character' ? `vrm-asset-gen-char-${fName}` : `vrm-asset-gen-v2-${fName}`;
    const existingRaw = localStorage.getItem(key);
    let multiConfig: Record<string, any> = {};
    
    try {
      if (existingRaw) {
        const parsed = JSON.parse(existingRaw);
        multiConfig = (parsed.px !== undefined && adjustTarget !== 'character') ? { "legacy": parsed } : parsed;
      }
    } catch(e) {}

    if (adjustTarget === 'character') {
      multiConfig = transforms[adjustTarget];
    } else {
      multiConfig[currentChar] = transforms[adjustTarget];
      multiConfig["_lastChar"] = currentChar;
    }

    const blob = new Blob([JSON.stringify(multiConfig, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fName}.json`;
    a.click();
    setStatus(`Config saved as ${fName}.json (includes ${Object.keys(multiConfig).filter(k=>!k.startsWith('_')).length} characters)`);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;

    const tryLoadTransform = (fName: string, targetType: string, customConfig?: any) => {
      const defaultT = { px:0, py:0, pz:0, rx:0, ry:0, rz:0, s:1 };
      const currentChar = targetFileNames.character || 'default';
      
      let data = customConfig;
      if (!data) {
        // LocalStorage から検索 (V2キー優先)
        const key = targetType === 'character' ? `vrm-asset-gen-char-${fName}` : `vrm-asset-gen-v2-${fName}`;
        const saved = localStorage.getItem(key) || localStorage.getItem(`vrm-asset-gen-${fName}`); // 旧キーも一応探す
        if (saved) {
          try { data = JSON.parse(saved); } catch(e) {}
        }
      }

      if (!data) return defaultT;

      // キャラクター自身の位置設定（単一形式）の場合
      if (targetType === 'character' || data.px !== undefined) {
        return data;
      }

      // マルチキャラ形式の場合
      if (data[currentChar]) {
         return data[currentChar];
      }

      // 見つからない場合は「他の誰か」の設定をコピーしてプレゼントする
      const otherChars = Object.keys(data).filter(k => !k.startsWith('_'));
      if (otherChars.length > 0) {
         setStatus(`No config for ${currentChar}. Copying from ${otherChars[0]}...`);
         return data[otherChars[0]];
      }

      return defaultT;
    };

    const droppedConfigs: Record<string, any> = {};
    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.json')) {
        try {
          const text = await file.text();
          const config = JSON.parse(text);
          droppedConfigs[file.name] = config;
          
          // 単体ドロップ対応：いま選択中のターゲットに即座に設定を適用する
          if (adjustTarget !== 'character') {
             const t = tryLoadTransform(file.name, adjustTarget, config);
             setTransforms(p => ({ ...p, [adjustTarget]: t }));
             const modelName = file.name.replace('.json', '');
             setTargetFileNames(p => ({ ...p, [adjustTarget]: modelName }));
             setStatus(`Imported Multi-Config to [${adjustTarget}] from: ${file.name}`);
          }
        } catch (err) { }
      }
    }

    for (const file of files) {
      const ext = file.name.toLowerCase();
      const url = URL.createObjectURL(file);

      if (ext.endsWith('.vrm')) {
        setStatus(`Loading VRM: ${file.name}...`);
        try {
          const loader = new GLTFLoader();
          loader.register((parser) => new VRMLoaderPlugin(parser));
          loader.load(url, (gltf) => {
            const vrmData = gltf.userData.vrm as VRM;
            if (vrmData) {
              VRMUtils.removeUnnecessaryVertices(gltf.scene);
              // Use combineSkeletons as per deprecation warning
              if ((VRMUtils as any).combineSkeletons) {
                (VRMUtils as any).combineSkeletons(gltf.scene);
              } else {
                VRMUtils.removeUnnecessaryJoints(gltf.scene);
              }
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
              setTransforms(p => ({ ...p, character: tryLoadTransform(file.name, 'character') }));
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
              setTransforms(p => ({ ...p, character: tryLoadTransform(file.name, 'character') }));
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
        if (!baseModel) { setStatus("Error: Load character first!"); return; }
        setStatus(`Loading equipment: ${file.name}...`);
        try {
          new GLTFLoader().load(url, (gltf) => {
            let targetBone: THREE.Object3D | null | undefined = null;
            if (adjustTarget === 'character') { setStatus("Error: Select Hand."); return; }

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
              setTransforms(p => ({ ...p, [adjustTarget]: tryLoadTransform(file.name, adjustTarget, droppedConfigs[`${file.name}.json`] || droppedConfigs[`${file.name.replace(/\.[^/.]+$/, "")}.json`]) }));
              setStatus(`Equipped Multi-Config for ${file.name}`);
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
        <h3 style={{marginTop: 0, fontSize: 16, borderBottom: '1px solid #444', paddingBottom: 8}}>Setting for: {adjustTarget} <span style={{fontSize: 10, color: '#777', fontWeight: 'normal'}}>(v1.4.5)</span></h3>
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
             <input type="range" min="0.01" max="5.0" step="0.01" value={t.s} onChange={e => updateTransform('s', parseFloat(e.target.value))} style={{flex: 1, margin: '0 10px'}}/>
             <span style={{width: 45, textAlign: 'right'}}>{t.s.toFixed(2)}</span>
        </div>

        <div style={{marginTop: 15, borderTop: '1px solid #444', paddingTop: 10}}>
           <h4 style={{margin: '0 0 10px 0', fontSize: 13}}>Outline Style</h4>
           <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', fontSize: 12, margin: '5px 0'}}>
             <span style={{width: 80}}>VRM Internal</span>
             <input type="range" min="0" max="0.1" step="0.001" value={vrmOutlineWidth} onChange={e => setVrmOutlineWidth(parseFloat(e.target.value))} style={{flex: 1, margin: '0 10px'}} />
             <span style={{width: 40, textAlign: 'right'}}>{(vrmOutlineWidth * 100).toFixed(1)}</span>
           </div>
           <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', fontSize: 12, margin: '5px 0'}}>
             <span style={{width: 80}}>Global Post</span>
             <input type="range" min="0" max="2.0" step="0.001" value={globalOutlineWidth} onChange={e => setGlobalOutlineWidth(parseFloat(e.target.value))} style={{flex: 1, margin: '0 10px'}} />
             <span style={{width: 40, textAlign: 'right'}}>{globalOutlineWidth.toFixed(3)}</span>
           </div>
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

      <div style={{ flex: 1, position: 'relative', background: '#222' }}>
        <Canvas gl={{ preserveDrawingBuffer: true, alpha: true, antialias: false, stencil: true }} camera={{ position: [0, 1.2, 3], fov: 45 }}>
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
             composerRef={composerRef}
          />

          <SceneEffects globalOutlineWidth={globalOutlineWidth} composerRef={composerRef} />

          <OrbitControls target={[0, 1, 0]} enablePan={true} enableDamping={true} />
        </Canvas>
      </div>
    </div>
  );
}

export default App;
