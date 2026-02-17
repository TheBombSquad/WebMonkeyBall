import type { Camera } from '../../noclip/Camera.js';
import type { GameplaySyncState, Renderer } from '../../noclip/Render.js';
import type { Game } from '../../game.js';
import type { HudRenderer } from '../../hud.js';
import type { GfxDevice } from '../../noclip/gfx/platform/GfxPlatform.js';
import type { ViewerInputState } from './boot.js';
import type { createSwapChainForWebGL2 } from '../../noclip/gfx/platform/GfxPlatformWebGL2.js';

const RENDER_FRAME_MS = 1000 / 60;
const RENDER_PERF_WINDOW_MS = 2000;
const RENDER_PERF_MAX_SAMPLES = 512;
const RENDER_PERF_OVERLAY_UPDATE_MS = 100;
const renderPerfNowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

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
  isRenderPerfDebugEnabled: () => boolean;
  showRenderPerfDebugOverlay: (lines: string[]) => void;
  hideRenderPerfDebugOverlay: () => void;
  sendLobbyHeartbeat: (now: number) => void;
  applyGameCamera: (interpolationAlpha: number) => void;
  updateNameplates: (interpolationAlpha: number) => void;
  onBeforeTick: (now: number) => void;
};

export function startRenderLoop(deps: FrameLoopDeps) {
  const perfTimestamps = new Float64Array(RENDER_PERF_MAX_SAMPLES);
  const perfFrameMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfCpuMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfSimMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfSyncMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfRenderCallMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfHudUpdateMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfHudRenderMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfRenderPrepareMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfRenderGraphMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfRenderTotalMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfWorldUpdateMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfWorldMainMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfWorldAnimGroupsMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfWorldEffectsMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfWorldFgMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfWorldBgMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfWorldBallsMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfMirrorMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  const perfWormholeMs = new Float32Array(RENDER_PERF_MAX_SAMPLES);
  let perfHead = 0;
  let perfSize = 0;
  let perfLastRenderedAt = 0;
  let perfLastOverlayUpdateMs = 0;

  const pushRenderPerfSample = (
    nowMs: number,
    frameMs: number,
    cpuMs: number,
    simMs: number,
    syncMs: number,
    renderCallMs: number,
    hudUpdateMs: number,
    hudRenderMs: number,
    renderPrepareMs: number,
    renderGraphMs: number,
    renderTotalMs: number,
    worldUpdateMs: number,
    worldMainMs: number,
    worldAnimGroupsMs: number,
    worldEffectsMs: number,
    worldFgMs: number,
    worldBgMs: number,
    worldBallsMs: number,
    mirrorMs: number,
    wormholeMs: number,
  ) => {
    let index = (perfHead + perfSize) % RENDER_PERF_MAX_SAMPLES;
    if (perfSize === RENDER_PERF_MAX_SAMPLES) {
      perfHead = (perfHead + 1) % RENDER_PERF_MAX_SAMPLES;
      perfSize -= 1;
      index = (perfHead + perfSize) % RENDER_PERF_MAX_SAMPLES;
    }
    perfTimestamps[index] = nowMs;
    perfFrameMs[index] = frameMs;
    perfCpuMs[index] = cpuMs;
    perfSimMs[index] = simMs;
    perfSyncMs[index] = syncMs;
    perfRenderCallMs[index] = renderCallMs;
    perfHudUpdateMs[index] = hudUpdateMs;
    perfHudRenderMs[index] = hudRenderMs;
    perfRenderPrepareMs[index] = renderPrepareMs;
    perfRenderGraphMs[index] = renderGraphMs;
    perfRenderTotalMs[index] = renderTotalMs;
    perfWorldUpdateMs[index] = worldUpdateMs;
    perfWorldMainMs[index] = worldMainMs;
    perfWorldAnimGroupsMs[index] = worldAnimGroupsMs;
    perfWorldEffectsMs[index] = worldEffectsMs;
    perfWorldFgMs[index] = worldFgMs;
    perfWorldBgMs[index] = worldBgMs;
    perfWorldBallsMs[index] = worldBallsMs;
    perfMirrorMs[index] = mirrorMs;
    perfWormholeMs[index] = wormholeMs;
    perfSize += 1;

    const cutoff = nowMs - RENDER_PERF_WINDOW_MS;
    while (perfSize > 0 && perfTimestamps[perfHead] < cutoff) {
      perfHead = (perfHead + 1) % RENDER_PERF_MAX_SAMPLES;
      perfSize -= 1;
    }
  };

  const computeAvgMax = (samples: Float32Array): [number, number] => {
    if (perfSize <= 0) {
      return [0, 0];
    }
    let sum = 0;
    let max = 0;
    for (let i = 0; i < perfSize; i += 1) {
      const idx = (perfHead + i) % RENDER_PERF_MAX_SAMPLES;
      const value = samples[idx];
      sum += value;
      if (value > max) {
        max = value;
      }
    }
    return [sum / perfSize, max];
  };

  const buildRenderPerfLines = (renderer: Renderer): string[] => {
    const lines: string[] = [];
    const [frameAvg, frameMax] = computeAvgMax(perfFrameMs);
    const [cpuAvg, cpuMax] = computeAvgMax(perfCpuMs);
    const [simAvg, simMax] = computeAvgMax(perfSimMs);
    const [syncAvg, syncMax] = computeAvgMax(perfSyncMs);
    const [drawAvg, drawMax] = computeAvgMax(perfRenderCallMs);
    const [hudUpdateAvg, hudUpdateMax] = computeAvgMax(perfHudUpdateMs);
    const [hudRenderAvg, hudRenderMax] = computeAvgMax(perfHudRenderMs);
    const [prepAvg, prepMax] = computeAvgMax(perfRenderPrepareMs);
    const [graphAvg, graphMax] = computeAvgMax(perfRenderGraphMs);
    const [renderTotalAvg, renderTotalMax] = computeAvgMax(perfRenderTotalMs);
    const [worldUpdateAvg, worldUpdateMax] = computeAvgMax(perfWorldUpdateMs);
    const [worldMainAvg, worldMainMax] = computeAvgMax(perfWorldMainMs);
    const [worldAnimAvg, worldAnimMax] = computeAvgMax(perfWorldAnimGroupsMs);
    const [worldEffectsAvg, worldEffectsMax] = computeAvgMax(perfWorldEffectsMs);
    const [worldFgAvg, worldFgMax] = computeAvgMax(perfWorldFgMs);
    const [worldBgAvg, worldBgMax] = computeAvgMax(perfWorldBgMs);
    const [worldBallsAvg, worldBallsMax] = computeAvgMax(perfWorldBallsMs);
    const [mirrorAvg, mirrorMax] = computeAvgMax(perfMirrorMs);
    const [wormholeAvg, wormholeMax] = computeAvgMax(perfWormholeMs);
    const latestIdx = perfSize > 0 ? (perfHead + perfSize - 1) % RENDER_PERF_MAX_SAMPLES : -1;
    let fps = 0;
    if (perfSize > 1) {
      const oldestTime = perfTimestamps[perfHead];
      const newestTime = perfTimestamps[latestIdx];
      const spanMs = Math.max(1e-3, newestTime - oldestTime);
      fps = ((perfSize - 1) * 1000) / spanMs;
    } else if (frameAvg > 0) {
      fps = 1000 / frameAvg;
    }
    const rendererPerf = renderer.perfStats;

    lines.push(`render fps=${fps.toFixed(1)} frame=${frameAvg.toFixed(2)}/${frameMax.toFixed(2)} n=${perfSize}`);
    lines.push(`render cpu=${cpuAvg.toFixed(3)}/${cpuMax.toFixed(2)} sim=${simAvg.toFixed(3)}/${simMax.toFixed(2)} sync=${syncAvg.toFixed(3)}/${syncMax.toFixed(2)}`);
    lines.push(`render draw=${drawAvg.toFixed(3)}/${drawMax.toFixed(2)} prep=${prepAvg.toFixed(3)}/${prepMax.toFixed(2)} graph=${graphAvg.toFixed(3)}/${graphMax.toFixed(2)}`);
    lines.push(`render total=${renderTotalAvg.toFixed(3)}/${renderTotalMax.toFixed(2)} hudUp=${hudUpdateAvg.toFixed(3)}/${hudUpdateMax.toFixed(2)} hudUi=${hudRenderAvg.toFixed(3)}/${hudRenderMax.toFixed(2)}`);
    lines.push(`world upd=${worldUpdateAvg.toFixed(3)}/${worldUpdateMax.toFixed(2)} main=${worldMainAvg.toFixed(3)}/${worldMainMax.toFixed(2)} ag=${worldAnimAvg.toFixed(3)}/${worldAnimMax.toFixed(2)} fx=${worldEffectsAvg.toFixed(3)}/${worldEffectsMax.toFixed(2)}`);
    lines.push(`world fg=${worldFgAvg.toFixed(3)}/${worldFgMax.toFixed(2)} bg=${worldBgAvg.toFixed(3)}/${worldBgMax.toFixed(2)} ball=${worldBallsAvg.toFixed(3)}/${worldBallsMax.toFixed(2)}`);
    lines.push(`caps mirror=${mirrorAvg.toFixed(3)}/${mirrorMax.toFixed(2)} worm=${wormholeAvg.toFixed(3)}/${wormholeMax.toFixed(2)}`);
    lines.push(`ag last m=${rendererPerf.worldMainAnimModelsMs.toFixed(3)} sm=${rendererPerf.worldMainAnimStageModelsMs.toFixed(3)} b=${rendererPerf.worldMainAnimBananasMs.toFixed(3)} g=${rendererPerf.worldMainAnimGoalsMs.toFixed(3)} t=${rendererPerf.worldMainAnimGoalTapesMs.toFixed(3)}`);
    lines.push(`ag last bump=${rendererPerf.worldMainAnimBumpersMs.toFixed(3)} jam=${rendererPerf.worldMainAnimJamabarsMs.toFixed(3)} worm=${rendererPerf.worldMainAnimWormholesMs.toFixed(3)} bag=${rendererPerf.worldMainAnimGoalBagsMs.toFixed(3)} sw=${rendererPerf.worldMainAnimSwitchesMs.toFixed(3)} blur=${rendererPerf.worldMainAnimBlurBridgeMs.toFixed(3)}`);
    lines.push(`ag cnt grp=${rendererPerf.worldMainAnimRenderedGroups}/${rendererPerf.worldMainAnimGroupCount} m=${rendererPerf.worldMainAnimModelsCount} sm=${rendererPerf.worldMainAnimStageModelsCount} b=${rendererPerf.worldMainAnimBananasRendered} g=${rendererPerf.worldMainAnimGoalsRendered} t=${rendererPerf.worldMainAnimGoalTapesRendered}`);
    lines.push(`ag cnt bump=${rendererPerf.worldMainAnimBumpersRendered} jam=${rendererPerf.worldMainAnimJamabarsRendered} worm=${rendererPerf.worldMainAnimWormholesRendered} bag=${rendererPerf.worldMainAnimGoalBagsRendered} sw=${rendererPerf.worldMainAnimSwitchesRendered}`);
    lines.push(`counts ag=${rendererPerf.worldMainAnimGroupCount} fg=${rendererPerf.worldMainFgCount} ball=${rendererPerf.worldMainBallCount}`);
    lines.push(`objects b=${rendererPerf.worldMainBananaCount} j=${rendererPerf.worldMainJamabarCount} g=${rendererPerf.worldMainGoalBagCount} t=${rendererPerf.worldMainGoalTapeCount} s=${rendererPerf.worldMainSwitchCount}`);
    return lines;
  };

  const renderFrame = (now: number) => {
    requestAnimationFrame(renderFrame);

    deps.onBeforeTick(now);

    const renderPerfEnabled = deps.isRenderPerfDebugEnabled();
    if (!renderPerfEnabled) {
      deps.hideRenderPerfDebugOverlay();
    }
    const viewerInput = deps.getViewerInput();
    const camera = deps.getCamera();
    if (!deps.getRunning() || !viewerInput || !camera) {
      deps.setLastTime(now);
      deps.hideRenderPerfDebugOverlay();
      return;
    }

    const perfFrameStart = renderPerfEnabled ? renderPerfNowMs() : 0;
    let simMs = 0;
    let syncMs = 0;
    let renderCallMs = 0;
    let hudUpdateMs = 0;
    let hudRenderMs = 0;

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

    const simStart = renderPerfEnabled ? renderPerfNowMs() : 0;
    if (deps.isNetplayEnabled()) {
      deps.netplayTick(dtSeconds);
    } else {
      deps.game.update(dtSeconds);
    }
    if (renderPerfEnabled) {
      simMs = renderPerfNowMs() - simStart;
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
      deps.hideRenderPerfDebugOverlay();
      return;
    }
    renderer.setPerfEnabled(renderPerfEnabled);
    if (!renderPerfEnabled) {
      deps.hideRenderPerfDebugOverlay();
    }

    deps.setLastRenderTime(now);

    resizeCanvasToDisplaySize(deps.canvas);
    resizeCanvasToDisplaySize(deps.hudCanvas);
    deps.hudRenderer.resize(deps.hudCanvas.width, deps.hudCanvas.height);

    if (deps.game.loadingStage) {
      const hudDelta = now - deps.getLastHudTime();
      deps.setLastHudTime(now);
      const hudDtFrames = deps.game.paused ? 0 : (hudDelta / 1000) * 60;
      const hudUpdateStart = renderPerfEnabled ? renderPerfNowMs() : 0;
      deps.hudRenderer.update(deps.game, hudDtFrames);
      if (renderPerfEnabled) {
        hudUpdateMs = renderPerfNowMs() - hudUpdateStart;
      }
      const hudRenderStart = renderPerfEnabled ? renderPerfNowMs() : 0;
      deps.hudRenderer.render(deps.game, dtSeconds);
      if (renderPerfEnabled) {
        hudRenderMs = renderPerfNowMs() - hudRenderStart;
        const frameMs = perfLastRenderedAt > 0 ? Math.max(0, now - perfLastRenderedAt) : dt;
        perfLastRenderedAt = now;
        const cpuMs = renderPerfNowMs() - perfFrameStart;
        pushRenderPerfSample(
          now,
          frameMs,
          cpuMs,
          simMs,
          0,
          0,
          hudUpdateMs,
          hudRenderMs,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
        );
        if ((now - perfLastOverlayUpdateMs) >= RENDER_PERF_OVERLAY_UPDATE_MS) {
          perfLastOverlayUpdateMs = now;
          deps.showRenderPerfDebugOverlay(buildRenderPerfLines(renderer));
        }
      }
      return;
    }

    const aspect = deps.canvas.width / deps.canvas.height;
    camera.clipSpaceNearZ = gfxDevice.queryVendorInfo().clipSpaceNearZ;
    camera.aspect = aspect;
    camera.setClipPlanes(5);

    viewerInput.backbufferWidth = deps.canvas.width;
    viewerInput.backbufferHeight = deps.canvas.height;

    const interpolationAlpha = deps.getInterpolationEnabled() ? deps.game.getInterpolationAlpha() : 1;
    const syncStart = renderPerfEnabled ? renderPerfNowMs() : 0;
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
    if (renderPerfEnabled) {
      syncMs = renderPerfNowMs() - syncStart;
    }
    const hudDelta = now - deps.getLastHudTime();
    deps.setLastHudTime(now);
    const hudDtFrames = deps.game.paused ? 0 : (hudDelta / 1000) * 60;
    const hudUpdateStart = renderPerfEnabled ? renderPerfNowMs() : 0;
    deps.hudRenderer.update(deps.game, hudDtFrames);
    if (renderPerfEnabled) {
      hudUpdateMs = renderPerfNowMs() - hudUpdateStart;
    }

    swapChain.configureSwapChain(deps.canvas.width, deps.canvas.height);
    gfxDevice.beginFrame();
    viewerInput.onscreenTexture = swapChain.getOnscreenTexture();

    const renderCallStart = renderPerfEnabled ? renderPerfNowMs() : 0;
    renderer.render(gfxDevice, viewerInput);

    gfxDevice.endFrame();
    if (renderPerfEnabled) {
      renderCallMs = renderPerfNowMs() - renderCallStart;
    }

    const hudRenderStart = renderPerfEnabled ? renderPerfNowMs() : 0;
    deps.hudRenderer.render(deps.game, dtSeconds);
    if (renderPerfEnabled) {
      hudRenderMs = renderPerfNowMs() - hudRenderStart;
      const rendererPerf = renderer.perfStats;
      const frameMs = perfLastRenderedAt > 0 ? Math.max(0, now - perfLastRenderedAt) : dt;
      perfLastRenderedAt = now;
      const cpuMs = renderPerfNowMs() - perfFrameStart;
      pushRenderPerfSample(
        now,
        frameMs,
        cpuMs,
        simMs,
        syncMs,
        renderCallMs,
        hudUpdateMs,
        hudRenderMs,
        rendererPerf.lastPrepareTotalMs,
        rendererPerf.lastRenderGraphMs,
        rendererPerf.lastTotalMs,
        rendererPerf.lastWorldUpdateMs,
        rendererPerf.lastMainWorldMs,
        rendererPerf.worldMainAnimGroupsMs,
        rendererPerf.worldMainEffectsMs,
        rendererPerf.worldMainFgMs,
        rendererPerf.worldMainBgMs,
        rendererPerf.worldMainBallsMs,
        rendererPerf.lastMirrorCaptureMs + rendererPerf.lastMirrorOverlayMs + rendererPerf.lastMirrorDistortMs,
        rendererPerf.lastWormholeCaptureMs + rendererPerf.lastWormholeOverlayMs,
      );
      if ((now - perfLastOverlayUpdateMs) >= RENDER_PERF_OVERLAY_UPDATE_MS) {
        perfLastOverlayUpdateMs = now;
        deps.showRenderPerfDebugOverlay(buildRenderPerfLines(renderer));
      }
    }
  };

  requestAnimationFrame(renderFrame);
}
