import * as THREE from 'three';
import { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

// Mixamoボーン名とVRM標準ボーン名のマッピング
export const mixamoVRMRigMap: Record<string, VRMHumanBoneName> = {
  mixamorigHips: 'hips',
  mixamorigSpine: 'spine',
  mixamorigSpine1: 'chest',
  mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck',
  mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder',
  mixamorigLeftArm: 'leftUpperArm',
  mixamorigLeftForeArm: 'leftLowerArm',
  mixamorigLeftHand: 'leftHand',
  mixamorigLeftHandThumb1: 'leftThumbMetacarpal',
  mixamorigLeftHandThumb2: 'leftThumbProximal',
  mixamorigLeftHandThumb3: 'leftThumbDistal',
  mixamorigLeftHandIndex1: 'leftIndexProximal',
  mixamorigLeftHandIndex2: 'leftIndexIntermediate',
  mixamorigLeftHandIndex3: 'leftIndexDistal',
  mixamorigLeftHandMiddle1: 'leftMiddleProximal',
  mixamorigLeftHandMiddle2: 'leftMiddleIntermediate',
  mixamorigLeftHandMiddle3: 'leftMiddleDistal',
  mixamorigLeftHandRing1: 'leftRingProximal',
  mixamorigLeftHandRing2: 'leftRingIntermediate',
  mixamorigLeftHandRing3: 'leftRingDistal',
  mixamorigLeftHandPinky1: 'leftLittleProximal',
  mixamorigLeftHandPinky2: 'leftLittleIntermediate',
  mixamorigLeftHandPinky3: 'leftLittleDistal',
  mixamorigRightShoulder: 'rightShoulder',
  mixamorigRightArm: 'rightUpperArm',
  mixamorigRightForeArm: 'rightLowerArm',
  mixamorigRightHand: 'rightHand',
  mixamorigRightHandThumb1: 'rightThumbMetacarpal',
  mixamorigRightHandThumb2: 'rightThumbProximal',
  mixamorigRightHandThumb3: 'rightThumbDistal',
  mixamorigRightHandIndex1: 'rightIndexProximal',
  mixamorigRightHandIndex2: 'rightIndexIntermediate',
  mixamorigRightHandIndex3: 'rightIndexDistal',
  mixamorigRightHandMiddle1: 'rightMiddleProximal',
  mixamorigRightHandMiddle2: 'rightMiddleIntermediate',
  mixamorigRightHandMiddle3: 'rightMiddleDistal',
  mixamorigRightHandRing1: 'rightRingProximal',
  mixamorigRightHandRing2: 'rightRingIntermediate',
  mixamorigRightHandRing3: 'rightRingDistal',
  mixamorigRightHandPinky1: 'rightLittleProximal',
  mixamorigRightHandPinky2: 'rightLittleIntermediate',
  mixamorigRightHandPinky3: 'rightLittleDistal',
  mixamorigLeftUpLeg: 'leftUpperLeg',
  mixamorigLeftLeg: 'leftLowerLeg',
  mixamorigLeftFoot: 'leftFoot',
  mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg',
  mixamorigRightLeg: 'rightLowerLeg',
  mixamorigRightFoot: 'rightFoot',
  mixamorigRightToeBase: 'rightToes',
};

/**
 * Pixiv公式の実装に基づくMixamo FBXアニメーションのリターゲティング
 * （Mixamo FBX モデルのRestPoseを逆算して、VRMのTポーズに完璧に一致させる計算を行います）
 */
export function retargetMixamoClipToVRM(clip: THREE.AnimationClip, vrm: VRM, mixamoAsset: THREE.Object3D): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = [];
  
  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const _quatA = new THREE.Quaternion();
  const _vec3 = new THREE.Vector3();

  clip.tracks.forEach((track) => {
    const trackSplitted = track.name.split('.');
    const mixamoBoneName = trackSplitted[0];
    const propertyName = trackSplitted[1];

    const vrmBoneName = mixamoVRMRigMap[mixamoBoneName];
    // 対象ボーンをVRM（正規化・Tポーズ済み）から探す
    const vrmNodeName = vrmBoneName ? vrm.humanoid?.getNormalizedBoneNode(vrmBoneName)?.name : null;
    // 対象ボーンをMixamo（FBX）側から探す
    const mixamoRigNode = mixamoAsset.getObjectByName(mixamoBoneName);

    if (vrmNodeName && mixamoRigNode) {
      // MixamoFBX側のボーンの「初期ワールド回転の逆数」と「親の初期ワールド回転」をとる
      mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
      mixamoRigNode.parent?.getWorldQuaternion(parentRestWorldRotation);

      if (track instanceof THREE.QuaternionKeyframeTrack) {
        // 回転アニメーションの補正
        const values = new Float32Array(track.values);
        for (let i = 0; i < values.length; i += 4) {
          _quatA.fromArray(values, i);
          // (親の初期ワールド回転) × (Mixamoのキーフレーム回転) × (自信の初期ワールド回転の逆)
          // これで VRM の座標系（Tポーズを(0,0,0,1)とする系）に変換される
          _quatA.premultiply(parentRestWorldRotation).multiply(restRotationInverse);
          _quatA.toArray(values, i);
        }
        
        // VRM 0.0 は座標系が少し違うため微調整
        const isVRM0 = vrm.meta?.metaVersion === '0';
        if (isVRM0) {
          for (let i = 0; i < values.length; i++) {
             if (i % 2 === 0) { // i=0(X), i=2(Z) の反転
                values[i] = -values[i];
             }
          }
        }

        tracks.push(
          new THREE.QuaternionKeyframeTrack(
            `${vrmNodeName}.${propertyName}`,
            track.times,
            values
          )
        );
      } else if (track instanceof THREE.VectorKeyframeTrack) {
        // Position（位置）アニメーションの補正はHips（腰）のみにする
        if (vrmBoneName === 'hips' && propertyName === 'position') {
          const values = new Float32Array(track.values);
          for (let i = 0; i < values.length; i += 3) {
            _vec3.fromArray(values, i);
            const isVRM0 = vrm.meta?.metaVersion === '0';
            if (isVRM0) {
              _vec3.x = -_vec3.x;
              _vec3.z = -_vec3.z;
            }
            _vec3.multiplyScalar(0.01); // Mixamoはセンチメートルのため0.01倍してメートルに変換
            _vec3.toArray(values, i);
          }
          tracks.push(
            new THREE.VectorKeyframeTrack(
              `${vrmNodeName}.${propertyName}`,
              track.times,
              values
            )
          );
        }
      }
    }
  });

  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}
