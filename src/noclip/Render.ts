import { Camera, CameraController } from './Camera.js';
import { mat4, vec3 } from 'gl-matrix';
import { transformVec3Mat4w0, transformVec3Mat4w1 } from './MathHelpers.js';
import {
  makeAttachmentClearDescriptor,
  makeBackbufferDescSimple,
  opaqueBlackFullClearRenderPassDescriptor,
} from './gfx/helpers/RenderGraphHelpers.js';
import {
  GfxDevice,
  GfxFormat,
} from './gfx/platform/GfxPlatform.js';
import { GfxrAttachmentSlot, GfxrRenderTargetDescription } from './gfx/render/GfxRenderGraph.js';
import {
  GfxRenderInstList,
  GfxRenderInstManager,
} from './gfx/render/GfxRenderInstManager.js';
import {
  GXRenderHelperGfx,
  fillSceneParamsDataOnTemplate,
} from './gx/gx_render.js';
import { MirrorMode, StageData, World, type WorldRenderPerfStats } from './SuperMonkeyBall/World.js';
import { StageId } from './SuperMonkeyBall/StageInfo.js';
import type { ModRenderPrimitive } from '../mods/render_primitives.js';

// TODO(complexplane): Put somewhere else
export type RenderContext = {
  device: GfxDevice;
  renderInstManager: GfxRenderInstManager;
  viewerInput: {
    camera: any;
    time: number;
    deltaTime: number;
    backbufferWidth: number;
    backbufferHeight: number;
    onscreenTexture: any;
    antialiasingMode: number;
    mouseLocation: { mouseX: number; mouseY: number };
    debugConsole: { addInfoLine: (line: string) => void };
  };
  opaqueInstList: GfxRenderInstList;
  translucentInstList: GfxRenderInstList;
  viewFromWorld?: mat4;
  bgOpaqueInstList?: GfxRenderInstList;
  bgTranslucentInstList?: GfxRenderInstList;
  skipMirrorModels?: boolean;
  skipStageTilt?: boolean;
  mirrorCapture?: boolean;
  mirrorPlanePoint?: vec3;
  mirrorPlaneNormal?: vec3;
  clipPlanePoint?: vec3;
  clipPlaneNormal?: vec3;
  forceAlphaWrite?: boolean;
  skipWormholeSurfaces?: boolean;
  skipWormholeIds?: Set<number>;
  wormholeCapture?: boolean;
};

export type BallRenderState = {
  pos: { x: number; y: number; z: number };
  orientation: { x: number; y: number; z: number; w: number };
  radius: number;
  visible: boolean;
};

export type BananaRenderState = {
  animGroupId: number;
  pos: { x: number; y: number; z: number };
  rotX: number;
  rotY: number;
  rotZ: number;
  scale: number;
  tiltFactor: number;
  type: number;
  visible: boolean;
};

export type JamabarRenderState = {
  animGroupId: number;
  pos: { x: number; y: number; z: number };
  rot: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
};

export type GoalBagRenderState = {
  animGroupId: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  openness: number;
  uSomePos: { x: number; y: number; z: number };
};

export type GoalTapePointRenderState = {
  pos: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  t: number;
  flags: number;
};

export type GoalTapeRenderState = {
  animGroupId: number;
  pos: { x: number; y: number; z: number };
  rot: { x: number; y: number; z: number };
  points: GoalTapePointRenderState[];
  index?: number;
};

export type ConfettiRenderState = {
  modelIndex: number;
  pos: { x: number; y: number; z: number };
  rotX: number;
  rotY: number;
  rotZ: number;
  scale: number;
};

export type EffectRenderState = {
  kind: 'streak' | 'star' | 'flash' | 'sparkle';
  id: number;
  pos: { x: number; y: number; z: number };
  prevPos?: { x: number; y: number; z: number };
  glowPos?: { x: number; y: number; z: number };
  glowRotX?: number;
  glowRotY?: number;
  glowDist?: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  normal?: { x: number; y: number; z: number };
  scale: number;
  alpha: number;
  lifeRatio?: number;
  colorR?: number;
  colorG?: number;
  colorB?: number;
  textureName?: string;
  ignoreStageTilt?: boolean;
  modelVariant?: 'bonusshot' | 'bonusshot_tail';
};

export type ModRenderPrimitiveState = ModRenderPrimitive;

export type SwitchRenderState = {
  animGroupId: number;
  pos: { x: number; y: number; z: number };
  rotX: number;
  rotY: number;
  rotZ: number;
  type: number;
};

export type StageTiltRenderState = {
  xrot: number;
  zrot: number;
};

export type GameplaySyncState = {
  timeFrames?: number | null;
  bananaCollectedByAnimGroup?: boolean[][] | null;
  bananas?: BananaRenderState[] | null;
  jamabars?: JamabarRenderState[] | null;
  animGroupTransforms?: Float32Array[] | null;
  ball?: BallRenderState | null;
  balls?: BallRenderState[] | null;
  goalBags?: GoalBagRenderState[] | null;
  goalTapes?: GoalTapeRenderState[] | null;
  confetti?: ConfettiRenderState[] | null;
  effects?: EffectRenderState[] | null;
  modPrimitives?: ModRenderPrimitiveState[] | null;
  switches?: SwitchRenderState[] | null;
  stageTilt?: StageTiltRenderState | null;
};

export type RenderPerfStats = {
  enabled: boolean;
  frameCount: number;
  lastPrepareTotalMs: number;
  lastRenderGraphMs: number;
  lastTotalMs: number;
  lastWorldUpdateMs: number;
  lastMainWorldMs: number;
  lastMirrorCaptureMs: number;
  lastMirrorOverlayMs: number;
  lastMirrorDistortMs: number;
  lastWormholeCaptureMs: number;
  lastWormholeOverlayMs: number;
  worldMainAnimGroupsMs: number;
  worldMainAnimModelsMs: number;
  worldMainAnimStageModelsMs: number;
  worldMainAnimBananasMs: number;
  worldMainAnimGoalsMs: number;
  worldMainAnimGoalTapesMs: number;
  worldMainAnimBumpersMs: number;
  worldMainAnimJamabarsMs: number;
  worldMainAnimWormholesMs: number;
  worldMainAnimGoalBagsMs: number;
  worldMainAnimSwitchesMs: number;
  worldMainAnimBlurBridgeMs: number;
  worldMainEffectsMs: number;
  worldMainFgMs: number;
  worldMainBgMs: number;
  worldMainBallsMs: number;
  worldMainAnimRenderedGroups: number;
  worldMainAnimModelsCount: number;
  worldMainAnimStageModelsCount: number;
  worldMainAnimBananasRendered: number;
  worldMainAnimGoalsRendered: number;
  worldMainAnimGoalTapesRendered: number;
  worldMainAnimBumpersRendered: number;
  worldMainAnimJamabarsRendered: number;
  worldMainAnimWormholesRendered: number;
  worldMainAnimGoalBagsRendered: number;
  worldMainAnimSwitchesRendered: number;
  worldMainAnimGroupCount: number;
  worldMainFgCount: number;
  worldMainBallCount: number;
  worldMainBananaCount: number;
  worldMainJamabarCount: number;
  worldMainGoalBagCount: number;
  worldMainGoalTapeCount: number;
  worldMainSwitchCount: number;
};

const scratchMirrorPlaneNormal = vec3.create();
const scratchMirrorPlanePoint = vec3.create();
const scratchMirrorReflection = mat4.create();
const scratchMirrorViewFromWorld = mat4.create();
const scratchMirrorViewFromWorldTilted = mat4.create();
const scratchMirrorWorldFromView = mat4.create();
const scratchMirrorClipFromWorld = mat4.create();
const scratchViewFromWorldTilted = mat4.create();
const scratchDistortClipFromWorld = mat4.create();
const scratchWormholeViewFromWorld = mat4.create();
const scratchWormholeClipFromWorld = mat4.create();
const scratchWormholeWorldFromView = mat4.create();
const scratchWormholeClipPlanePoint = vec3.create();
const scratchWormholeClipPlaneNormal = vec3.create();
const mirrorFlipX = mat4.fromScaling(mat4.create(), [-1, 1, 1]);
const WAVY_MIRROR_ALPHA = 0x60 / 0xff;
const perfNowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function computeReflectionMatrix(out: mat4, planePoint: vec3, planeNormal: vec3): void {
  vec3.normalize(scratchMirrorPlaneNormal, planeNormal);
  const nx = scratchMirrorPlaneNormal[0];
  const ny = scratchMirrorPlaneNormal[1];
  const nz = scratchMirrorPlaneNormal[2];
  const d = -(nx * planePoint[0] + ny * planePoint[1] + nz * planePoint[2]);

  out[0] = 1 - 2 * nx * nx;
  out[1] = -2 * nx * ny;
  out[2] = -2 * nx * nz;
  out[3] = 0;

  out[4] = -2 * ny * nx;
  out[5] = 1 - 2 * ny * ny;
  out[6] = -2 * ny * nz;
  out[7] = 0;

  out[8] = -2 * nz * nx;
  out[9] = -2 * nz * ny;
  out[10] = 1 - 2 * nz * nz;
  out[11] = 0;

  out[12] = -2 * nx * d;
  out[13] = -2 * ny * d;
  out[14] = -2 * nz * d;
  out[15] = 1;
}

function getMirrorCaptureDimensions(stageData: StageData, mirrorMode: MirrorMode): { width: number; height: number } {
  if (mirrorMode === 'wavy') {
    return { width: 640, height: 224 };
  }
  const bgName = stageData.stageInfo.bgInfo.fileName;
  if (bgName === 'bg_snd') {
    return { width: 160, height: 112 };
  }
  if (bgName === 'bg_ice') {
    return { width: 320, height: 224 };
  }
  if (bgName === 'bg_mst') {
    return stageData.stageInfo.id === StageId.St122_Fan_Master
      ? { width: 320, height: 224 }
      : { width: 640, height: 448 };
  }
  if (bgName === 'bg_stm') {
    return stageData.stageInfo.id === StageId.St089_Coffee_Cup
      ? { width: 320, height: 224 }
      : { width: 640, height: 448 };
  }
  if (bgName === 'bg_spa') {
    switch (stageData.stageInfo.id) {
      case StageId.St101_Blur_Bridge:
      case StageId.St109_Factory:
      case StageId.St110_Curl_Pipe:
      case StageId.St113_Daa_Loo_Maa:
      case StageId.St145_Fight_Space:
        return { width: 320, height: 224 };
      default:
        return { width: 640, height: 448 };
    }
  }
  return { width: 640, height: 448 };
}

export class Renderer {
  private renderHelper: GXRenderHelperGfx;
  private world: World;
  private opaqueInstList = new GfxRenderInstList();
  private translucentInstList = new GfxRenderInstList();
  private mirrorCaptureOpaqueInstList = new GfxRenderInstList();
  private mirrorCaptureTranslucentInstList = new GfxRenderInstList();
  private mirrorOverlayInstList = new GfxRenderInstList();
  private mirrorDistortInstList = new GfxRenderInstList();
  private wormholeCaptureOpaqueInstList = new GfxRenderInstList();
  private wormholeCaptureTranslucentInstList = new GfxRenderInstList();
  private wormholeOverlayInstList = new GfxRenderInstList();
  private mirrorCamera = new Camera();
  private wormholeCamera = new Camera();
  private mirrorMode: MirrorMode = 'none';
  private mirrorCaptureWidth = 0;
  private mirrorCaptureHeight = 0;
  private mirrorNeedsDistort = false;
  private wormholeCaptureWidth = 0;
  private wormholeCaptureHeight = 0;
  private activeWormholeSourceId: number | null = null;
  private activeWormholeDestId: number | null = null;
  private lastExternalTimeFrames: number | null = null;
  public readonly perfStats: RenderPerfStats = {
    enabled: false,
    frameCount: 0,
    lastPrepareTotalMs: 0,
    lastRenderGraphMs: 0,
    lastTotalMs: 0,
    lastWorldUpdateMs: 0,
    lastMainWorldMs: 0,
    lastMirrorCaptureMs: 0,
    lastMirrorOverlayMs: 0,
    lastMirrorDistortMs: 0,
    lastWormholeCaptureMs: 0,
    lastWormholeOverlayMs: 0,
    worldMainAnimGroupsMs: 0,
    worldMainAnimModelsMs: 0,
    worldMainAnimStageModelsMs: 0,
    worldMainAnimBananasMs: 0,
    worldMainAnimGoalsMs: 0,
    worldMainAnimGoalTapesMs: 0,
    worldMainAnimBumpersMs: 0,
    worldMainAnimJamabarsMs: 0,
    worldMainAnimWormholesMs: 0,
    worldMainAnimGoalBagsMs: 0,
    worldMainAnimSwitchesMs: 0,
    worldMainAnimBlurBridgeMs: 0,
    worldMainEffectsMs: 0,
    worldMainFgMs: 0,
    worldMainBgMs: 0,
    worldMainBallsMs: 0,
    worldMainAnimRenderedGroups: 0,
    worldMainAnimModelsCount: 0,
    worldMainAnimStageModelsCount: 0,
    worldMainAnimBananasRendered: 0,
    worldMainAnimGoalsRendered: 0,
    worldMainAnimGoalTapesRendered: 0,
    worldMainAnimBumpersRendered: 0,
    worldMainAnimJamabarsRendered: 0,
    worldMainAnimWormholesRendered: 0,
    worldMainAnimGoalBagsRendered: 0,
    worldMainAnimSwitchesRendered: 0,
    worldMainAnimGroupCount: 0,
    worldMainFgCount: 0,
    worldMainBallCount: 0,
    worldMainBananaCount: 0,
    worldMainJamabarCount: 0,
    worldMainGoalBagCount: 0,
    worldMainGoalTapeCount: 0,
    worldMainSwitchCount: 0,
  };

  constructor(device: GfxDevice, private stageData: StageData) {
    this.renderHelper = new GXRenderHelperGfx(device);
    this.world = new World(device, this.renderHelper.renderCache, stageData);
  }

  public setPerfEnabled(enabled: boolean): void {
    if (this.perfStats.enabled === enabled) {
      return;
    }
    this.perfStats.enabled = enabled;
    this.world.setRenderPerfEnabled(enabled);
  }

  private prepareToRender(
    device: GfxDevice,
    viewerInput: RenderContext['viewerInput'],
    opaqueInstList: GfxRenderInstList,
    translucentInstList: GfxRenderInstList
  ): void {
    const perf = this.perfStats;
    const perfEnabled = perf.enabled;
    this.world.setRenderPerfEnabled(perfEnabled);
    const prepareStartMs = perfEnabled ? perfNowMs() : 0;
    if (perfEnabled) {
      perf.lastPrepareTotalMs = 0;
      perf.lastWorldUpdateMs = 0;
      perf.lastMainWorldMs = 0;
      perf.lastMirrorCaptureMs = 0;
      perf.lastMirrorOverlayMs = 0;
      perf.lastMirrorDistortMs = 0;
      perf.lastWormholeCaptureMs = 0;
      perf.lastWormholeOverlayMs = 0;
      perf.worldMainAnimGroupsMs = 0;
      perf.worldMainAnimModelsMs = 0;
      perf.worldMainAnimStageModelsMs = 0;
      perf.worldMainAnimBananasMs = 0;
      perf.worldMainAnimGoalsMs = 0;
      perf.worldMainAnimGoalTapesMs = 0;
      perf.worldMainAnimBumpersMs = 0;
      perf.worldMainAnimJamabarsMs = 0;
      perf.worldMainAnimWormholesMs = 0;
      perf.worldMainAnimGoalBagsMs = 0;
      perf.worldMainAnimSwitchesMs = 0;
      perf.worldMainAnimBlurBridgeMs = 0;
      perf.worldMainEffectsMs = 0;
      perf.worldMainFgMs = 0;
      perf.worldMainBgMs = 0;
      perf.worldMainBallsMs = 0;
      perf.worldMainAnimRenderedGroups = 0;
      perf.worldMainAnimModelsCount = 0;
      perf.worldMainAnimStageModelsCount = 0;
      perf.worldMainAnimBananasRendered = 0;
      perf.worldMainAnimGoalsRendered = 0;
      perf.worldMainAnimGoalTapesRendered = 0;
      perf.worldMainAnimBumpersRendered = 0;
      perf.worldMainAnimJamabarsRendered = 0;
      perf.worldMainAnimWormholesRendered = 0;
      perf.worldMainAnimGoalBagsRendered = 0;
      perf.worldMainAnimSwitchesRendered = 0;
      perf.worldMainAnimGroupCount = 0;
      perf.worldMainFgCount = 0;
      perf.worldMainBallCount = 0;
      perf.worldMainBananaCount = 0;
      perf.worldMainJamabarCount = 0;
      perf.worldMainGoalBagCount = 0;
      perf.worldMainGoalTapeCount = 0;
      perf.worldMainSwitchCount = 0;
    }

    this.renderHelper.renderInstManager.reset();
    this.mirrorCaptureOpaqueInstList.reset();
    this.mirrorCaptureTranslucentInstList.reset();
    this.mirrorOverlayInstList.reset();
    this.mirrorDistortInstList.reset();
    this.wormholeCaptureOpaqueInstList.reset();
    this.wormholeCaptureTranslucentInstList.reset();
    this.wormholeOverlayInstList.reset();
    const worldUpdateStartMs = perfEnabled ? perfNowMs() : 0;
    this.world.update(viewerInput);
    if (perfEnabled) {
      perf.lastWorldUpdateMs = perfNowMs() - worldUpdateStartMs;
    }

    viewerInput.camera.setClipPlanes(0.1);

    this.mirrorMode = this.world.getMirrorMode();
    this.mirrorNeedsDistort = this.mirrorMode === 'wavy';
    this.mirrorCaptureWidth = 0;
    this.mirrorCaptureHeight = 0;
    this.wormholeCaptureWidth = 0;
    this.wormholeCaptureHeight = 0;
    this.activeWormholeSourceId = null;
    this.activeWormholeDestId = null;

    const mirrorPlaneMatrix = scratchMirrorReflection;
    if (this.mirrorMode !== 'none') {
      if (!this.world.getMirrorPlaneMatrix(mirrorPlaneMatrix, viewerInput.camera.worldMatrix)) {
        this.mirrorMode = 'none';
        this.mirrorNeedsDistort = false;
      }
    }

    if (this.mirrorMode !== 'none') {
      const dims = getMirrorCaptureDimensions(this.stageData, this.mirrorMode);
      const mirrorAspect = viewerInput.camera.aspect;
      this.mirrorCaptureHeight = dims.height;
      if (this.mirrorMode === 'wavy') {
        // Bonus Wave uses a fixed 640x224 mirror capture in SMB1.
        this.mirrorCaptureWidth = dims.width;
      } else {
        this.mirrorCaptureWidth = Math.max(1, Math.round(dims.height * mirrorAspect));
      }

      const viewFromWorldTilted = this.world.getTiltedViewMatrix(
        viewerInput.camera.viewMatrix,
        scratchViewFromWorldTilted
      );
      transformVec3Mat4w0(scratchMirrorPlaneNormal, mirrorPlaneMatrix, [0, 1, 0]);
      transformVec3Mat4w1(scratchMirrorPlanePoint, mirrorPlaneMatrix, [0, 0, 0]);
      computeReflectionMatrix(scratchMirrorReflection, scratchMirrorPlanePoint, scratchMirrorPlaneNormal);

      mat4.mul(scratchMirrorViewFromWorld, viewFromWorldTilted, scratchMirrorReflection);
      mat4.mul(scratchMirrorViewFromWorld, mirrorFlipX, scratchMirrorViewFromWorld);
      mat4.invert(scratchMirrorWorldFromView, scratchMirrorViewFromWorld);

      this.mirrorCamera.clipSpaceNearZ = viewerInput.camera.clipSpaceNearZ;
      if (viewerInput.camera.isOrthographic) {
        this.mirrorCamera.setOrthographic(
          viewerInput.camera.top,
          mirrorAspect,
          viewerInput.camera.near,
          viewerInput.camera.far
        );
      } else {
        this.mirrorCamera.setPerspective(
          viewerInput.camera.fovY,
          mirrorAspect,
          viewerInput.camera.near,
          viewerInput.camera.far
        );
      }
      mat4.copy(this.mirrorCamera.worldMatrix, scratchMirrorWorldFromView);
      this.mirrorCamera.worldMatrixUpdated();

      const mirrorViewerInput: RenderContext['viewerInput'] = {
        ...viewerInput,
        camera: this.mirrorCamera,
        backbufferWidth: this.mirrorCaptureWidth,
        backbufferHeight: this.mirrorCaptureHeight,
      };

      const mirrorTemplate = this.renderHelper.pushTemplateRenderInst();
      fillSceneParamsDataOnTemplate(mirrorTemplate, mirrorViewerInput, 0, this.world.getAnimTimeFrames());
      const mirrorCtx: RenderContext = {
        device,
        renderInstManager: this.renderHelper.renderInstManager,
        viewerInput: mirrorViewerInput,
        opaqueInstList: this.mirrorCaptureOpaqueInstList,
        translucentInstList: this.mirrorCaptureTranslucentInstList,
        skipMirrorModels: true,
        skipStageTilt: true,
        mirrorCapture: true,
        mirrorPlanePoint: scratchMirrorPlanePoint,
        mirrorPlaneNormal: scratchMirrorPlaneNormal,
      };
      const mirrorCaptureStartMs = perfEnabled ? perfNowMs() : 0;
      this.world.prepareToRender(mirrorCtx);
      if (perfEnabled) {
        perf.lastMirrorCaptureMs = perfNowMs() - mirrorCaptureStartMs;
      }
      this.renderHelper.renderInstManager.popTemplate();

      mat4.copy(scratchMirrorViewFromWorldTilted, scratchMirrorViewFromWorld);
      const mirrorViewFromWorldTilted = scratchMirrorViewFromWorldTilted;
      mat4.mul(scratchMirrorClipFromWorld, this.mirrorCamera.projectionMatrix, mirrorViewFromWorldTilted);
      mat4.mul(scratchDistortClipFromWorld, viewerInput.camera.projectionMatrix, viewFromWorldTilted);

      let indTexMtx0: vec3 | null = null;
      let indTexMtx1: vec3 | null = null;
      if (this.mirrorNeedsDistort) {
        const ind0 = scratchMirrorPlaneNormal;
        const ind1 = scratchMirrorPlanePoint;
        vec3.set(ind0, 0.0, 1.6, 0.0);
        vec3.set(ind1, 1.2, 0.0, 0.0);
        const abs0 = Math.abs(ind0[1]);
        const abs1 = Math.abs(ind1[0]);
        if (abs0 > abs1) {
          while (Math.abs(ind0[1]) >= 1.0) {
            vec3.scale(ind0, ind0, 0.5);
            vec3.scale(ind1, ind1, 0.5);
          }
        } else {
          while (Math.abs(ind1[0]) >= 1.0) {
            vec3.scale(ind0, ind0, 0.5);
            vec3.scale(ind1, ind1, 0.5);
          }
        }
        indTexMtx0 = ind0;
        indTexMtx1 = ind1;
      }

      const mirrorOverlayTemplate = this.renderHelper.pushTemplateRenderInst();
      fillSceneParamsDataOnTemplate(mirrorOverlayTemplate, viewerInput, 0, this.world.getAnimTimeFrames());
      const mirrorOverlayCtx: RenderContext = {
        device,
        renderInstManager: this.renderHelper.renderInstManager,
        viewerInput,
        opaqueInstList: this.mirrorOverlayInstList,
        translucentInstList: this.mirrorOverlayInstList,
      };
      const mirrorAlpha = this.mirrorMode === 'wavy' ? WAVY_MIRROR_ALPHA : 1.0;
      const mirrorOverlayStartMs = perfEnabled ? perfNowMs() : 0;
      this.world.prepareToRenderMirrors(
        mirrorOverlayCtx,
        viewerInput.camera.viewMatrix,
        scratchMirrorClipFromWorld,
        mirrorAlpha,
        this.mirrorNeedsDistort ? scratchDistortClipFromWorld : null,
        indTexMtx0,
        indTexMtx1
      );
      if (perfEnabled) {
        perf.lastMirrorOverlayMs = perfNowMs() - mirrorOverlayStartMs;
      }
      if (this.mirrorNeedsDistort) {
        const mirrorDistortCtx: RenderContext = {
          device,
          renderInstManager: this.renderHelper.renderInstManager,
          viewerInput,
          opaqueInstList: this.mirrorDistortInstList,
          translucentInstList: this.mirrorDistortInstList,
        };
        const mirrorDistortStartMs = perfEnabled ? perfNowMs() : 0;
        this.world.prepareToRenderWavyDistort(mirrorDistortCtx, viewerInput.camera.viewMatrix);
        if (perfEnabled) {
          perf.lastMirrorDistortMs = perfNowMs() - mirrorDistortStartMs;
        }
      }
      this.renderHelper.renderInstManager.popTemplate();
    }

    if (this.world.hasRenderableWormholes()) {
      const activeCapture = this.world.getActiveWormholeCapture(
        viewerInput.camera.viewMatrix,
        viewerInput.camera.projectionMatrix,
        scratchWormholeViewFromWorld,
        scratchWormholeClipFromWorld
      );
      if (activeCapture) {
        this.activeWormholeSourceId = activeCapture.sourceId;
        this.activeWormholeDestId = activeCapture.destId;
        const skipWormholeIds = new Set<number>([activeCapture.destId]);
        const hasWormholeClipPlane = this.world.getWormholeCaptureClipPlane(
          activeCapture.destId,
          scratchWormholeClipPlanePoint,
          scratchWormholeClipPlaneNormal
        );
        this.wormholeCaptureWidth = Math.max(1, viewerInput.backbufferWidth);
        this.wormholeCaptureHeight = Math.max(1, viewerInput.backbufferHeight);

        if (mat4.invert(scratchWormholeWorldFromView, scratchWormholeViewFromWorld)) {
          this.wormholeCamera.clipSpaceNearZ = viewerInput.camera.clipSpaceNearZ;
          if (viewerInput.camera.isOrthographic) {
            this.wormholeCamera.setOrthographic(
              viewerInput.camera.top,
              viewerInput.camera.aspect,
              viewerInput.camera.near,
              viewerInput.camera.far
            );
          } else {
            this.wormholeCamera.setPerspective(
              viewerInput.camera.fovY,
              viewerInput.camera.aspect,
              viewerInput.camera.near,
              viewerInput.camera.far
            );
          }
          mat4.copy(this.wormholeCamera.worldMatrix, scratchWormholeWorldFromView);
          this.wormholeCamera.worldMatrixUpdated();

          const wormholeViewerInput: RenderContext['viewerInput'] = {
            ...viewerInput,
            camera: this.wormholeCamera,
            backbufferWidth: this.wormholeCaptureWidth,
            backbufferHeight: this.wormholeCaptureHeight,
          };

          const wormholeCaptureTemplate = this.renderHelper.pushTemplateRenderInst();
          fillSceneParamsDataOnTemplate(wormholeCaptureTemplate, wormholeViewerInput, 0, this.world.getAnimTimeFrames());
          const wormholeCaptureCtx: RenderContext = {
            device,
            renderInstManager: this.renderHelper.renderInstManager,
            viewerInput: wormholeViewerInput,
            opaqueInstList: this.wormholeCaptureOpaqueInstList,
            translucentInstList: this.wormholeCaptureTranslucentInstList,
            wormholeCapture: true,
            skipStageTilt: true,
            skipWormholeSurfaces: true,
            skipWormholeIds,
            clipPlanePoint: hasWormholeClipPlane ? scratchWormholeClipPlanePoint : undefined,
            clipPlaneNormal: hasWormholeClipPlane ? scratchWormholeClipPlaneNormal : undefined,
          };
          const wormholeCaptureStartMs = perfEnabled ? perfNowMs() : 0;
          this.world.prepareToRender(wormholeCaptureCtx);
          if (perfEnabled) {
            perf.lastWormholeCaptureMs = perfNowMs() - wormholeCaptureStartMs;
          }
          this.renderHelper.renderInstManager.popTemplate();

          const wormholeOverlayTemplate = this.renderHelper.pushTemplateRenderInst();
          fillSceneParamsDataOnTemplate(wormholeOverlayTemplate, viewerInput, 0, this.world.getAnimTimeFrames());
          const wormholeOverlayCtx: RenderContext = {
            device,
            renderInstManager: this.renderHelper.renderInstManager,
            viewerInput,
            opaqueInstList: this.wormholeOverlayInstList,
            translucentInstList: this.wormholeOverlayInstList,
          };
          const wormholeOverlayStartMs = perfEnabled ? perfNowMs() : 0;
          this.world.prepareToRenderWormholeSurface(
            wormholeOverlayCtx,
            viewerInput.camera.viewMatrix,
            scratchWormholeClipFromWorld,
            this.activeWormholeSourceId,
            this.activeWormholeDestId
          );
          if (perfEnabled) {
            perf.lastWormholeOverlayMs = perfNowMs() - wormholeOverlayStartMs;
          }
          this.renderHelper.renderInstManager.popTemplate();
        } else {
          this.activeWormholeSourceId = null;
          this.activeWormholeDestId = null;
        }
      }
    }

    const template = this.renderHelper.pushTemplateRenderInst();
    fillSceneParamsDataOnTemplate(template, viewerInput, 0, this.world.getAnimTimeFrames());

    const renderCtx: RenderContext = {
      device,
      renderInstManager: this.renderHelper.renderInstManager,
      viewerInput,
      opaqueInstList,
      translucentInstList,
    };
    const mainWorldStartMs = perfEnabled ? perfNowMs() : 0;
    this.world.prepareToRender(renderCtx);
    if (perfEnabled) {
      perf.lastMainWorldMs = perfNowMs() - mainWorldStartMs;
      const worldPerf: WorldRenderPerfStats = this.world.getRenderPerfStats();
      perf.worldMainAnimGroupsMs = worldPerf.lastAnimGroupsMs;
      perf.worldMainAnimModelsMs = worldPerf.lastAnimModelsMs;
      perf.worldMainAnimStageModelsMs = worldPerf.lastAnimStageModelsMs;
      perf.worldMainAnimBananasMs = worldPerf.lastAnimBananasMs;
      perf.worldMainAnimGoalsMs = worldPerf.lastAnimGoalsMs;
      perf.worldMainAnimGoalTapesMs = worldPerf.lastAnimGoalTapesMs;
      perf.worldMainAnimBumpersMs = worldPerf.lastAnimBumpersMs;
      perf.worldMainAnimJamabarsMs = worldPerf.lastAnimJamabarsMs;
      perf.worldMainAnimWormholesMs = worldPerf.lastAnimWormholesMs;
      perf.worldMainAnimGoalBagsMs = worldPerf.lastAnimGoalBagsMs;
      perf.worldMainAnimSwitchesMs = worldPerf.lastAnimSwitchesMs;
      perf.worldMainAnimBlurBridgeMs = worldPerf.lastAnimBlurBridgeMs;
      perf.worldMainEffectsMs = worldPerf.lastEffectsMs;
      perf.worldMainFgMs = worldPerf.lastFgMs;
      perf.worldMainBgMs = worldPerf.lastBgMs;
      perf.worldMainBallsMs = worldPerf.lastBallsMs;
      perf.worldMainAnimRenderedGroups = worldPerf.lastAnimRenderedGroups;
      perf.worldMainAnimModelsCount = worldPerf.lastAnimModelsCount;
      perf.worldMainAnimStageModelsCount = worldPerf.lastAnimStageModelsCount;
      perf.worldMainAnimBananasRendered = worldPerf.lastAnimBananasRendered;
      perf.worldMainAnimGoalsRendered = worldPerf.lastAnimGoalsRendered;
      perf.worldMainAnimGoalTapesRendered = worldPerf.lastAnimGoalTapesRendered;
      perf.worldMainAnimBumpersRendered = worldPerf.lastAnimBumpersRendered;
      perf.worldMainAnimJamabarsRendered = worldPerf.lastAnimJamabarsRendered;
      perf.worldMainAnimWormholesRendered = worldPerf.lastAnimWormholesRendered;
      perf.worldMainAnimGoalBagsRendered = worldPerf.lastAnimGoalBagsRendered;
      perf.worldMainAnimSwitchesRendered = worldPerf.lastAnimSwitchesRendered;
      perf.worldMainAnimGroupCount = worldPerf.lastAnimGroupCount;
      perf.worldMainFgCount = worldPerf.lastFgObjectCount;
      perf.worldMainBallCount = worldPerf.lastBallCount;
      perf.worldMainBananaCount = worldPerf.lastBananaCount;
      perf.worldMainJamabarCount = worldPerf.lastJamabarCount;
      perf.worldMainGoalBagCount = worldPerf.lastGoalBagCount;
      perf.worldMainGoalTapeCount = worldPerf.lastGoalTapeCount;
      perf.worldMainSwitchCount = worldPerf.lastSwitchCount;
    }
    this.renderHelper.prepareToRender();
    this.renderHelper.renderInstManager.popTemplate();
    if (perfEnabled) {
      perf.lastPrepareTotalMs = perfNowMs() - prepareStartMs;
    }
  }

  public render(device: GfxDevice, viewerInput: RenderContext['viewerInput']) {
    const perf = this.perfStats;
    const perfEnabled = perf.enabled;
    const renderStartMs = perfEnabled ? perfNowMs() : 0;
    if (perfEnabled) {
      perf.lastRenderGraphMs = 0;
      perf.lastTotalMs = 0;
    }
    this.prepareToRender(device, viewerInput, this.opaqueInstList, this.translucentInstList);
    const mainColorDesc = makeBackbufferDescSimple(
      GfxrAttachmentSlot.Color0,
      viewerInput,
      makeAttachmentClearDescriptor(this.world.getClearColor())
    );
    const mainDepthDesc = makeBackbufferDescSimple(
      GfxrAttachmentSlot.DepthStencil,
      viewerInput,
      opaqueBlackFullClearRenderPassDescriptor
    );

    const builder = this.renderHelper.renderGraph.newGraphBuilder();

    let mirrorColorTargetID = null;
    let mirrorColorResolveID = null;
    let mirrorDepthTargetID = null;
    let mirrorDistortTargetID = null;
    let mirrorDistortResolveID = null;
    let mirrorDistortDepthTargetID = null;
    let wormholeColorTargetID = null;
    let wormholeColorResolveID = null;
    let wormholeDepthTargetID = null;
    if (this.mirrorMode !== 'none') {
      const mirrorDims = { width: this.mirrorCaptureWidth, height: this.mirrorCaptureHeight };
      const mirrorColorDesc = new GfxrRenderTargetDescription(GfxFormat.U8_RGBA_RT);
      mirrorColorDesc.setDimensions(mirrorDims.width, mirrorDims.height, 1);
      mirrorColorDesc.clearColor = this.world.getClearColor();
      mirrorColorDesc.clearDepth = opaqueBlackFullClearRenderPassDescriptor.clearDepth;
      mirrorColorDesc.clearStencil = 0;
      const mirrorDepthDesc = new GfxrRenderTargetDescription(GfxFormat.D24);
      mirrorDepthDesc.setDimensions(mirrorDims.width, mirrorDims.height, 1);
      mirrorDepthDesc.clearColor = 'load';
      mirrorDepthDesc.clearDepth = opaqueBlackFullClearRenderPassDescriptor.clearDepth;
      mirrorDepthDesc.clearStencil = 0;

      mirrorColorTargetID = builder.createRenderTargetID(mirrorColorDesc, 'Mirror Color');
      mirrorDepthTargetID = builder.createRenderTargetID(mirrorDepthDesc, 'Mirror Depth');

      builder.pushPass((pass) => {
        pass.setDebugName('Mirror Capture');
        pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mirrorColorTargetID!);
        pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mirrorDepthTargetID!);
        pass.exec((passRenderer) => {
          this.mirrorCaptureOpaqueInstList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
          this.mirrorCaptureTranslucentInstList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
        });
      });
      mirrorColorResolveID = builder.resolveRenderTarget(mirrorColorTargetID);

      if (this.mirrorNeedsDistort) {
        const distortDesc = new GfxrRenderTargetDescription(GfxFormat.U8_RGBA_RT);
        distortDesc.setDimensions(256, 256, 1);
        distortDesc.clearColor = makeAttachmentClearDescriptor({ r: 0, g: 0, b: 0, a: 0 }).clearColor;
        distortDesc.clearDepth = opaqueBlackFullClearRenderPassDescriptor.clearDepth;
        distortDesc.clearStencil = 0;
        const distortDepthDesc = new GfxrRenderTargetDescription(GfxFormat.D24);
        distortDepthDesc.setDimensions(256, 256, 1);
        distortDepthDesc.clearColor = 'load';
        distortDepthDesc.clearDepth = opaqueBlackFullClearRenderPassDescriptor.clearDepth;
        distortDepthDesc.clearStencil = 0;

        mirrorDistortTargetID = builder.createRenderTargetID(distortDesc, 'Mirror Distort');
        mirrorDistortDepthTargetID = builder.createRenderTargetID(distortDepthDesc, 'Mirror Distort Depth');

        builder.pushPass((pass) => {
          pass.setDebugName('Mirror Distort');
          pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mirrorDistortTargetID!);
          pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mirrorDistortDepthTargetID!);
          pass.exec((passRenderer) => {
            this.mirrorDistortInstList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
          });
        });
        mirrorDistortResolveID = builder.resolveRenderTarget(mirrorDistortTargetID);
      }
    }

    if (this.activeWormholeSourceId !== null && this.wormholeCaptureWidth > 0 && this.wormholeCaptureHeight > 0) {
      const wormholeDims = { width: this.wormholeCaptureWidth, height: this.wormholeCaptureHeight };
      const wormholeColorDesc = new GfxrRenderTargetDescription(GfxFormat.U8_RGBA_RT);
      wormholeColorDesc.setDimensions(wormholeDims.width, wormholeDims.height, 1);
      wormholeColorDesc.clearColor = this.world.getClearColor();
      wormholeColorDesc.clearDepth = opaqueBlackFullClearRenderPassDescriptor.clearDepth;
      wormholeColorDesc.clearStencil = 0;
      const wormholeDepthDesc = new GfxrRenderTargetDescription(GfxFormat.D24);
      wormholeDepthDesc.setDimensions(wormholeDims.width, wormholeDims.height, 1);
      wormholeDepthDesc.clearColor = 'load';
      wormholeDepthDesc.clearDepth = opaqueBlackFullClearRenderPassDescriptor.clearDepth;
      wormholeDepthDesc.clearStencil = 0;

      wormholeColorTargetID = builder.createRenderTargetID(wormholeColorDesc, 'Wormhole Color');
      wormholeDepthTargetID = builder.createRenderTargetID(wormholeDepthDesc, 'Wormhole Depth');

      builder.pushPass((pass) => {
        pass.setDebugName('Wormhole Capture');
        pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, wormholeColorTargetID!);
        pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, wormholeDepthTargetID!);
        pass.exec((passRenderer) => {
          this.wormholeCaptureOpaqueInstList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
          this.wormholeCaptureTranslucentInstList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
        });
      });
      wormholeColorResolveID = builder.resolveRenderTarget(wormholeColorTargetID);
    }

    const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
    const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
    builder.pushPass((pass) => {
      pass.setDebugName('Main Opaque');
      pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
      pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
      pass.exec((passRenderer) => {
        this.opaqueInstList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
      });
    });
    if (this.mirrorMode !== 'none' && mirrorColorResolveID !== null) {
      builder.pushPass((pass) => {
        pass.setDebugName('Mirror Overlay');
        pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
        pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
        pass.attachResolveTexture(mirrorColorResolveID!);
        if (this.mirrorNeedsDistort && mirrorDistortResolveID !== null) {
          pass.attachResolveTexture(mirrorDistortResolveID);
        }
        pass.exec((passRenderer, scope) => {
          const mirrorTexture = scope.getResolveTextureForID(mirrorColorResolveID!);
          this.mirrorOverlayInstList.resolveLateSamplerBinding('mirror-color', {
            gfxTexture: mirrorTexture,
            gfxSampler: null,
            lateBinding: null,
          });
          if (this.mirrorNeedsDistort && mirrorDistortResolveID !== null) {
            const distortTexture = scope.getResolveTextureForID(mirrorDistortResolveID);
            this.mirrorOverlayInstList.resolveLateSamplerBinding('mirror-distort', {
              gfxTexture: distortTexture,
              gfxSampler: null,
              lateBinding: null,
            });
          }
          this.mirrorOverlayInstList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
        });
      });
    }
    builder.pushPass((pass) => {
      pass.setDebugName('Main Translucent');
      pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
      pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
      pass.exec((passRenderer) => {
        this.translucentInstList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
      });
    });
    if (this.activeWormholeSourceId !== null && wormholeColorResolveID !== null) {
      builder.pushPass((pass) => {
        pass.setDebugName('Wormhole Overlay');
        pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
        pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
        pass.attachResolveTexture(wormholeColorResolveID!);
        pass.exec((passRenderer, scope) => {
          const wormholeTexture = scope.getResolveTextureForID(wormholeColorResolveID!);
          this.wormholeOverlayInstList.resolveLateSamplerBinding('wormhole-color', {
            gfxTexture: wormholeTexture,
            gfxSampler: null,
            lateBinding: null,
          });
          this.wormholeOverlayInstList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
        });
      });
    }
    this.renderHelper.antialiasingSupport.pushPasses(
      builder,
      viewerInput,
      mainColorTargetID
    );
    builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

    const renderGraphStartMs = perfEnabled ? perfNowMs() : 0;
    this.renderHelper.renderGraph.execute(builder);
    if (perfEnabled) {
      perf.lastRenderGraphMs = perfNowMs() - renderGraphStartMs;
      perf.lastTotalMs = perfNowMs() - renderStartMs;
      perf.frameCount += 1;
    }
  }

  public prewarmConfetti(device: GfxDevice, viewerInput: RenderContext['viewerInput']): void {
    const warmConfetti: ConfettiRenderState[] = [
      { modelIndex: 0, pos: { x: 0, y: 0, z: 0 }, rotX: 0, rotY: 0, rotZ: 0, scale: 0.001 },
      { modelIndex: 1, pos: { x: 0, y: 0, z: 0 }, rotX: 0, rotY: 0, rotZ: 0, scale: 0.001 },
      { modelIndex: 2, pos: { x: 0, y: 0, z: 0 }, rotX: 0, rotY: 0, rotZ: 0, scale: 0.001 },
      { modelIndex: 3, pos: { x: 0, y: 0, z: 0 }, rotX: 0, rotY: 0, rotZ: 0, scale: 0.001 },
      { modelIndex: 4, pos: { x: 0, y: 0, z: 0 }, rotX: 0, rotY: 0, rotZ: 0, scale: 0.001 },
    ];
    const warmGoalBags: GoalBagRenderState[] = [
      { animGroupId: 0, rotX: 0, rotY: 0, rotZ: 0, openness: 0, uSomePos: { x: 0, y: 0, z: 0 } },
      { animGroupId: 0, rotX: 0, rotY: 0, rotZ: 0, openness: 1, uSomePos: { x: 0, y: 0, z: 0 } },
    ];
    const prevDeltaTime = viewerInput.deltaTime;
    const prevTime = viewerInput.time;
    viewerInput.deltaTime = 0;
    this.world.setConfetti(warmConfetti);
    this.world.setGoalBags(warmGoalBags);
    this.render(device, viewerInput);
    this.world.setConfetti(null);
    this.world.setGoalBags(null);
    viewerInput.deltaTime = prevDeltaTime;
    viewerInput.time = prevTime;
  }

  public syncGameplayState(state: GameplaySyncState): void {
    if (state.timeFrames !== undefined && state.timeFrames !== null) {
      const delta = this.lastExternalTimeFrames === null
        ? 0
        : Math.max(0, state.timeFrames - this.lastExternalTimeFrames);
      this.lastExternalTimeFrames = state.timeFrames;
      this.world.setExternalTimeFrames(state.timeFrames, delta);
    }
    if (state.bananas !== undefined) {
      this.world.setBananas(state.bananas ?? null);
    }
    if (state.jamabars !== undefined) {
      this.world.setJamabars(state.jamabars ?? null);
    }
    if (state.bananaCollectedByAnimGroup) {
      this.world.setBananaCollectedByAnimGroup(state.bananaCollectedByAnimGroup);
    }
    const hasBalls = state.balls !== undefined;
    if (hasBalls) {
      this.world.setBallsState(state.balls ?? null);
    } else if (state.ball !== undefined) {
      this.world.setBallState(state.ball ?? null);
    }
    if (state.goalBags !== undefined) {
      this.world.setGoalBags(state.goalBags ?? null);
    }
    if (state.goalTapes !== undefined) {
      this.world.setGoalTapes(state.goalTapes ?? null);
    }
    if (state.confetti !== undefined) {
      this.world.setConfetti(state.confetti ?? null);
    }
    if (state.effects !== undefined) {
      this.world.setEffects(state.effects ?? null);
    }
    if (state.modPrimitives !== undefined) {
      this.world.setModPrimitives(state.modPrimitives ?? null);
    }
    if (state.switches !== undefined) {
      this.world.setSwitches(state.switches ?? null);
    }
    if (state.stageTilt !== undefined) {
      this.world.setStageTilt(state.stageTilt ?? null);
    }
    if (state.animGroupTransforms !== undefined) {
      this.world.setAnimGroupTransforms(state.animGroupTransforms ?? null);
    }
  }

  public destroy(device: GfxDevice): void {
    this.renderHelper.destroy();
    this.world.destroy(device);
  }

  public adjustCameraController(c: CameraController) {
    c.setSceneMoveSpeedMult(1 / 32);
    c.setKeyMoveSpeed(20);
  }
}
