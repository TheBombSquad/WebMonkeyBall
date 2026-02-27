import { DEG_TO_S16 } from './shared/constants/index.js';
import {
  MatrixStack,
  atan2S16,
  quatFromDirs,
  sumSq2,
  sqrt,
  toS16,
  vecNormalizeLen,
} from './math.js';

const stack = new MatrixStack();
const unitUpVec = { x: 0, y: 1, z: 0 };
const transformedUpVec = { x: 0, y: 1, z: 0 };
const downVec = { x: 0, y: -1, z: 0 };
const quatTmp = { x: 0, y: 0, z: 0, w: 1 };

export class World {
  constructor({ maxTilt = 23.0 } = {}) {
    this.maxTilt = maxTilt;
    this.xrot = 0;
    this.zrot = 0;
    this.xrotPrev = 0;
    this.zrotPrev = 0;
    this.gravity = { x: 0, y: -1, z: 0 };
    this.smb2SmoothedUp = { x: 0, y: 1, z: 0 };
  }

  reset() {
    this.xrot = 0;
    this.zrot = 0;
    this.xrotPrev = 0;
    this.zrotPrev = 0;
    this.gravity.x = 0;
    this.gravity.y = -1;
    this.gravity.z = 0;
    this.smb2SmoothedUp.x = 0;
    this.smb2SmoothedUp.y = 1;
    this.smb2SmoothedUp.z = 0;
  }

  updateInput(stick, cameraRotY, stageFormat = 'smb1') {
    this.xrotPrev = this.xrot;
    this.zrotPrev = this.zrot;

    let stickX = stick.x;
    let stickY = stick.y;
    if (stickX < -1) stickX = -1;
    else if (stickX > 1) stickX = 1;
    if (stickY < -1) stickY = -1;
    else if (stickY > 1) stickY = 1;

    if (stageFormat === 'smb2') {
      this.updateInputSmb2(stickX, stickY, cameraRotY);
      return;
    }
    this.updateInputDefault(stickX, stickY, cameraRotY);
  }

  updateInputDefault(stickX, stickY, cameraRotY) {
    const maxTiltS16 = this.maxTilt * DEG_TO_S16;
    let inpXRot = stickY * maxTiltS16;
    let inpZRot = -stickX * maxTiltS16;
    inpXRot = toS16(inpXRot);
    inpZRot = toS16(inpZRot);

    stack.fromIdentity();
    stack.rotateY(cameraRotY);
    stack.rotateX(inpXRot);
    stack.rotateZ(inpZRot);

    transformedUpVec.x = 0;
    transformedUpVec.y = 1;
    transformedUpVec.z = 0;
    stack.tfVec(transformedUpVec, transformedUpVec);

    inpXRot = atan2S16(transformedUpVec.z, transformedUpVec.y);
    inpZRot = -atan2S16(transformedUpVec.x, sqrt(sumSq2(transformedUpVec.z, transformedUpVec.y)));

    const dx = toS16(inpXRot - this.xrot);
    const dz = toS16(inpZRot - this.zrot);
    this.xrot = toS16(this.xrot + dx * 0.2);
    this.zrot = toS16(this.zrot + dz * 0.2);

    this.gravity.x = 0;
    this.gravity.y = -1;
    this.gravity.z = 0;
    stack.fromIdentity();
    stack.rotateX(this.xrot);
    stack.rotateZ(this.zrot);
    stack.rigidInvTfVec(this.gravity, this.gravity);
  }

  updateInputSmb2(stickX, stickY, cameraRotY) {
    const maxTiltS16 = this.maxTilt * DEG_TO_S16;
    const targetXRot = toS16(stickY * maxTiltS16);
    const targetZRot = toS16(-stickX * maxTiltS16);

    stack.fromIdentity();
    stack.rotateY(cameraRotY);
    stack.rotateX(targetXRot);
    stack.rotateZ(targetZRot);

    transformedUpVec.x = 0;
    transformedUpVec.y = 1;
    transformedUpVec.z = 0;
    stack.tfVec(transformedUpVec, transformedUpVec);

    const smoothUp = this.smb2SmoothedUp;
    smoothUp.x += (transformedUpVec.x - smoothUp.x) * 0.2;
    smoothUp.y += (transformedUpVec.y - smoothUp.y) * 0.2;
    smoothUp.z += (transformedUpVec.z - smoothUp.z) * 0.2;

    this.xrot = atan2S16(smoothUp.z, smoothUp.y);
    this.zrot = -atan2S16(smoothUp.x, sqrt(sumSq2(smoothUp.z, smoothUp.y)));
    vecNormalizeLen(smoothUp);

    quatFromDirs(quatTmp, unitUpVec, smoothUp);
    stack.fromQuat(quatTmp);
    downVec.x = 0;
    downVec.y = -1;
    downVec.z = 0;
    stack.rigidInvTfVec(downVec, this.gravity);
  }
}
