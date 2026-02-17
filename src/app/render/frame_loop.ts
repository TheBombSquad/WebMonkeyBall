import type { Camera } from '../../noclip/Camera.js';
import type { GameplaySyncState, Renderer } from '../../noclip/Render.js';
import type { Game } from '../../game.js';
import type { HudRenderer } from '../../hud.js';
import type { GfxDevice } from '../../noclip/gfx/platform/GfxPlatform.js';
import type { ViewerInputState } from './boot.js';
import type { createSwapChainForWebGL2 } from '../../noclip/gfx/platform/GfxPlatformWebGL2.js';

const RENDER_FRAME_MS = 1000 / 60;
const FRAME_STATS_REFRESH_MS = 100;
const FRAME_STATS_WINDOW_MS = 2000;

export function resizeCanvasToDisplaySize(canvasElem: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const viewport = window.visualViewport;
  const cssWidth = viewport?.width || canvasElem.clientWidth || window.innerWidth;
  const cssHeight = viewport?.height || canvasElem.clientHeight || window.innerHeight;
  const width = Math.floor(cssWidth * dpr);
  const height = Math.floor(cssHeight * dpr);
  if (canvasElem.width !== width || canvasElem.height !== height) {
    canvasElem.width = width;
    canvasElem.height = height;
  }
}

type FrameLoopDeps = {
  canvas: HTMLCanvasElement;
  hudCanvas: HTMLCanvasElement;
  hudRenderer: HudRenderer;
  game: Game;
  syncState: GameplaySyncState;
  getRunning: () => boolean;
  getLastTime: () => number;
  setLastTime: (value: number) => void;
  getLastRenderTime: () => number;
  setLastRenderTime: (value: number) => void;
  getLastHudTime: () => number;
  setLastHudTime: (value: number) => void;
  getInterpolationEnabled: () => boolean;
  getViewerInput: () => ViewerInputState | null;
  getCamera: () => Camera | null;
  getRenderer: () => Renderer | null;
  getGfxDevice: () => GfxDevice | null;
  getSwapChain: () => ReturnType<typeof createSwapChainForWebGL2> | null;
  isRenderReady: () => boolean;
  isNetplayEnabled: () => boolean;
  netplayTick: (dtSeconds: number) => void;
  updateNetplayDebugOverlay: (now: number) => void;
  isFrameStatsEnabled: () => boolean;
  showFrameStats: (line: string) => void;
  hideFrameStats: () => void;
  sendLobbyHeartbeat: (now: number) => void;
  applyGameCamera: (interpolationAlpha: number) => void;
  updateNameplates: (interpolationAlpha: number) => void;
  onBeforeTick: (now: number) => void;
};

export function startRenderLoop(deps: FrameLoopDeps) {
  let frameStatsWasEnabled = false;
  let frameStatsVisible = false;
  let frameStatsWindowStartMs = 0;
  let frameStatsFrames = 0;
  let frameStatsFrameTotalMs = 0;
  let frameStatsLastPresentMs: number | null = null;
  let frameStatsLastUiUpdateMs = 0;

  const resetFrameStats = () => {
    frameStatsWindowStartMs = 0;
    frameStatsFrames = 0;
    frameStatsFrameTotalMs = 0;
    frameStatsLastPresentMs = null;
    frameStatsLastUiUpdateMs = 0;
    if (frameStatsVisible) {
      deps.hideFrameStats();
      frameStatsVisible = false;
    }
  };

  const renderFrame = (now: number) => {
    requestAnimationFrame(renderFrame);

    deps.onBeforeTick(now);

    const frameStatsEnabled = deps.isFrameStatsEnabled();
    if (!frameStatsEnabled) {
      if (frameStatsWasEnabled) {
        resetFrameStats();
        frameStatsWasEnabled = false;
      }
    } else if (!frameStatsWasEnabled) {
      frameStatsWasEnabled = true;
      frameStatsWindowStartMs = now;
      frameStatsLastPresentMs = now;
    }

    const viewerInput = deps.getViewerInput();
    const camera = deps.getCamera();
    if (!deps.getRunning() || !viewerInput || !camera) {
      if (frameStatsWasEnabled) {
        resetFrameStats();
        frameStatsWasEnabled = false;
      }
      deps.setLastTime(now);
      return;
    }

    const dt = Math.max(0, now - deps.getLastTime());
    deps.setLastTime(now);
    const dtSeconds = dt / 1000;
    deps.sendLobbyHeartbeat(now);

    if (!deps.game.paused) {
      viewerInput.deltaTime = dt;
      viewerInput.time += dt;
    } else {
      viewerInput.deltaTime = 0;
    }

    if (deps.isNetplayEnabled()) {
      deps.netplayTick(dtSeconds);
    } else {
      deps.game.update(dtSeconds);
    }
    deps.updateNetplayDebugOverlay(now);

    const shouldRender = deps.getInterpolationEnabled() || (now - deps.getLastRenderTime()) >= RENDER_FRAME_MS;
    if (!shouldRender) {
      return;
    }

    const renderer = deps.getRenderer();
    const gfxDevice = deps.getGfxDevice();
    const swapChain = deps.getSwapChain();
    if (!renderer || !gfxDevice || !swapChain || !deps.isRenderReady()) {
      deps.setLastTime(now);
      return;
    }

    deps.setLastRenderTime(now);

    if (frameStatsEnabled && frameStatsWasEnabled) {
      const frameMs = frameStatsLastPresentMs === null ? RENDER_FRAME_MS : Math.max(0, now - frameStatsLastPresentMs);
      frameStatsLastPresentMs = now;

      frameStatsFrames += 1;
      frameStatsFrameTotalMs += frameMs;
      const elapsedMs = Math.max(1, now - frameStatsWindowStartMs);
      if ((now - frameStatsLastUiUpdateMs) >= FRAME_STATS_REFRESH_MS) {
        const fps = (frameStatsFrames * 1000) / elapsedMs;
        const avgFrameMs = frameStatsFrameTotalMs / frameStatsFrames;
        deps.showFrameStats(`fps=${fps.toFixed(1)} frame=${avgFrameMs.toFixed(2)}ms`);
        frameStatsVisible = true;
        frameStatsLastUiUpdateMs = now;
      }
      if (elapsedMs >= FRAME_STATS_WINDOW_MS) {
        frameStatsWindowStartMs = now;
        frameStatsFrames = 1;
        frameStatsFrameTotalMs = frameMs;
      }
    }

    resizeCanvasToDisplaySize(deps.canvas);
    resizeCanvasToDisplaySize(deps.hudCanvas);
    deps.hudRenderer.resize(deps.hudCanvas.width, deps.hudCanvas.height);

    if (deps.game.loadingStage) {
      const hudDelta = now - deps.getLastHudTime();
      deps.setLastHudTime(now);
      const hudDtFrames = deps.game.paused ? 0 : (hudDelta / 1000) * 60;
      deps.hudRenderer.update(deps.game, hudDtFrames);
      deps.hudRenderer.render(deps.game, dtSeconds);
      return;
    }

    const aspect = deps.canvas.width / deps.canvas.height;
    camera.clipSpaceNearZ = gfxDevice.queryVendorInfo().clipSpaceNearZ;
    camera.aspect = aspect;
    camera.setClipPlanes(5);

    viewerInput.backbufferWidth = deps.canvas.width;
    viewerInput.backbufferHeight = deps.canvas.height;

    const interpolationAlpha = deps.getInterpolationEnabled() ? deps.game.getInterpolationAlpha() : 1;
    const baseTimeFrames = deps.game.getAnimTimeFrames(interpolationAlpha);
    deps.syncState.timeFrames = baseTimeFrames === null ? null : baseTimeFrames;
    deps.syncState.bananas = deps.game.getBananaRenderState(interpolationAlpha);
    deps.syncState.jamabars = deps.game.getJamabarRenderState(interpolationAlpha);
    deps.syncState.bananaCollectedByAnimGroup = null;
    deps.syncState.animGroupTransforms = deps.game.getAnimGroupTransforms(interpolationAlpha);
    deps.syncState.ball = deps.game.getBallRenderState(interpolationAlpha);
    deps.syncState.balls = deps.game.getBallRenderStates(interpolationAlpha);
    deps.syncState.goalBags = deps.game.getGoalBagRenderState(interpolationAlpha);
    deps.syncState.goalTapes = deps.game.getGoalTapeRenderState(interpolationAlpha);
    deps.syncState.confetti = deps.game.getConfettiRenderState(interpolationAlpha);
    deps.syncState.effects = deps.game.getEffectRenderState(interpolationAlpha);
    deps.syncState.modPrimitives = deps.game.getModRenderPrimitiveState(interpolationAlpha);
    deps.syncState.switches = deps.game.getSwitchRenderState(interpolationAlpha);
    deps.syncState.stageTilt = deps.game.getStageTiltRenderState(interpolationAlpha);
    renderer.syncGameplayState(deps.syncState);

    deps.applyGameCamera(interpolationAlpha);
    deps.updateNameplates(interpolationAlpha);

    const hudDelta = now - deps.getLastHudTime();
    deps.setLastHudTime(now);
    const hudDtFrames = deps.game.paused ? 0 : (hudDelta / 1000) * 60;
    deps.hudRenderer.update(deps.game, hudDtFrames);

    swapChain.configureSwapChain(deps.canvas.width, deps.canvas.height);
    gfxDevice.beginFrame();
    viewerInput.onscreenTexture = swapChain.getOnscreenTexture();

    renderer.render(gfxDevice, viewerInput);

    gfxDevice.endFrame();
    deps.hudRenderer.render(deps.game, dtSeconds);
  };

  requestAnimationFrame(renderFrame);
}
