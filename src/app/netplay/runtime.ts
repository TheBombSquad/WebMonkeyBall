import type { Game } from '../../game.js';
import type { QuantizedInput } from '../../determinism.js';
import type { FrameBundleMessage } from '../../netcode_protocol.js';

type RuntimeConstants = {
  maxFrameDelta: number;
  clientAheadSlack: number;
  clientRateMin: number;
  clientRateMax: number;
  clientDriftRate: number;
  driftForceTick: number;
  driftExtraTicks: number;
  syncRateMin: number;
  syncRateMax: number;
  syncDriftRate: number;
  syncForceTick: number;
  syncExtraTicks: number;
  syncMaxTicks: number;
  pingIntervalMs: number;
  hostStallMs: number;
  lagFuseFrames: number;
  lagFuseMs: number;
  snapshotCooldownMs: number;
  hostSnapshotBehindFrames: number;
  hostSnapshotCooldownMs: number;
};

type RuntimeDeps = {
  game: Game;
  netplayEnabled: () => boolean;
  getNetplayState: () => any | null;
  getClientPeer: () => any | null;
  getHostRelay: () => any | null;
  getNetplayAccumulator: () => number;
  setNetplayAccumulator: (value: number) => void;
  buildInputsForFrame: (frame: number) => Map<number, QuantizedInput>;
  recordInputForFrame: (frame: number, playerId: number, input: QuantizedInput) => boolean;
  trimNetplayHistory: (frame: number) => void;
  getSimHash: () => number;
  requestSnapshot: (reason: 'mismatch' | 'lag', frame?: number, force?: boolean) => void;
  hostApplyPendingRollback: () => void;
  sendSnapshotToClient: (playerId: number, frame?: number) => void;
  maybeResendStageReady: (nowMs: number) => void;
  maybeForceStageSync: (nowMs: number) => void;
  getAuthoritativeHashFrame: (state: any) => number | null;
  getEstimatedHostFrame: (state: any) => number;
  getClientLeadFrames: (state: any) => number;
  isNetplayDebugEnabled: () => boolean;
  netplayDebugOverlay: { show: (warning: string | null, lines: string[]) => void; hide: () => void };
  simPerfDebugOverlay: { show: (lines: string[]) => void; hide: () => void };
  constants: RuntimeConstants;
};

function clamp(value: number, min: number, max: number) {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export class NetplayRuntimeController {
  private readonly deps: RuntimeDeps;

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
  }

  private getNetplayTargetFrame(state: any, currentFrame: number) {
    if (state.role === 'client') {
      return this.deps.getEstimatedHostFrame(state) + this.deps.getClientLeadFrames(state);
    }
    return currentFrame;
  }

  private hostResendFrames(currentFrame: number) {
    const hostRelay = this.deps.getHostRelay();
    const state = this.deps.getNetplayState();
    if (!hostRelay || !state) {
      return;
    }
    const pendingFrames = state.pendingHostUpdates.size > 0
      ? Array.from(state.pendingHostUpdates).sort((a, b) => a - b)
      : [];
    for (const [playerId, clientState] of state.clientStates.entries()) {
      const ackedHostFrame = Math.min(clientState.lastAckedHostFrame, currentFrame);
      const start = Math.max(ackedHostFrame + 1, currentFrame - state.maxResend + 1);
      const bundles: FrameBundleMessage[] = [];
      let pendingIdx = 0;
      let frame = start;
      while (pendingIdx < pendingFrames.length || frame <= currentFrame) {
        let nextFrame: number;
        if (pendingIdx >= pendingFrames.length) {
          nextFrame = frame;
          frame += 1;
        } else if (frame > currentFrame || pendingFrames[pendingIdx] < frame) {
          nextFrame = pendingFrames[pendingIdx];
          pendingIdx += 1;
        } else if (pendingFrames[pendingIdx] === frame) {
          nextFrame = frame;
          pendingIdx += 1;
          frame += 1;
        } else {
          nextFrame = frame;
          frame += 1;
        }
        const bundle = state.hostFrameBuffer.get(nextFrame);
        if (!bundle) {
          continue;
        }
        bundles.push(bundle);
      }
      if (bundles.length > 0) {
        hostRelay.sendFrameBatch(playerId, clientState.lastAckedClientInput, bundles);
      }
    }
    if (pendingFrames.length > 0) {
      state.pendingHostUpdates.clear();
    }
  }

  private hostMaybeSendSnapshots(nowMs: number) {
    const hostRelay = this.deps.getHostRelay();
    const state = this.deps.getNetplayState();
    if (!hostRelay || !state || state.role !== 'host') {
      return;
    }
    const currentFrame = state.session.getFrame();
    for (const [playerId, clientState] of state.clientStates.entries()) {
      const ackedHostFrame = Math.min(clientState.lastAckedHostFrame, currentFrame);
      if (ackedHostFrame < 0) {
        continue;
      }
      const behind = currentFrame - ackedHostFrame;
      if (behind < this.deps.constants.hostSnapshotBehindFrames) {
        continue;
      }
      const lastSnap = clientState.lastSnapshotMs;
      if (lastSnap !== null && (nowMs - lastSnap) < this.deps.constants.hostSnapshotCooldownMs) {
        continue;
      }
      clientState.lastSnapshotMs = nowMs;
      this.deps.sendSnapshotToClient(playerId, currentFrame);
    }
  }

  private clientSendInputBuffer(currentFrame: number) {
    const clientPeer = this.deps.getClientPeer();
    const state = this.deps.getNetplayState();
    if (!clientPeer || !state) {
      return;
    }
    const start = state.lastAckedLocalFrame + 1;
    const end = currentFrame;
    const minFrame = Math.max(start, end - state.maxResend + 1);
    const batchEntries: Array<{ frame: number; input: QuantizedInput }> = [];
    for (let frame = minFrame; frame <= end; frame += 1) {
      const input = state.pendingLocalInputs.get(frame);
      if (!input) {
        continue;
      }
      batchEntries.push({ frame, input });
    }
    if (batchEntries.length > 0) {
      clientPeer.sendInputBatch(state.stageSeq, state.lastReceivedHostFrame, batchEntries);
    }
    if (start > end) {
      clientPeer.send({
        type: 'ack',
        stageSeq: state.stageSeq,
        playerId: this.deps.game.localPlayerId,
        frame: state.lastReceivedHostFrame,
      });
    }
  }

  private netplayStep() {
    const state = this.deps.getNetplayState();
    if (!state) {
      return;
    }
    const session = state.session;
    const currentFrame = session.getFrame();
    const targetFrame = this.getNetplayTargetFrame(state, currentFrame);
    const drift = targetFrame - currentFrame;
    if (state.role === 'client' && drift < -this.deps.constants.clientAheadSlack) {
      this.clientSendInputBuffer(currentFrame);
      return;
    }
    const frame = session.getFrame() + 1;
    const localInput = this.deps.game.sampleLocalInput();
    this.deps.recordInputForFrame(frame, this.deps.game.localPlayerId, localInput);
    if (state.role === 'client') {
      state.pendingLocalInputs.set(frame, localInput);
    }
    const inputs = this.deps.buildInputsForFrame(frame);
    session.advanceTo(frame, inputs);
    let hash: number | undefined;
    if (state.hashInterval > 0 && frame % state.hashInterval === 0) {
      hash = this.deps.getSimHash();
      state.hashHistory.set(frame, hash);
      const expected = state.expectedHashes.get(frame);
      if (expected !== undefined && expected !== hash) {
        this.deps.requestSnapshot('mismatch', frame);
      }
    }
    if (state.role === 'host') {
      let hashFrame: number | null = null;
      let authHash: number | undefined;
      const authHashFrame = this.deps.getAuthoritativeHashFrame(state);
      if (authHashFrame !== null) {
        const value = state.hashHistory.get(authHashFrame);
        if (value !== undefined) {
          hashFrame = authHashFrame;
          authHash = value;
          state.lastAuthHashFrameSent = authHashFrame;
        }
      }
      const bundleInputs: Record<number, QuantizedInput> = {};
      for (const [playerId, input] of inputs.entries()) {
        bundleInputs[playerId] = input;
      }
      const bundle: FrameBundleMessage = {
        type: 'frame',
        stageSeq: state.stageSeq,
        frame,
        inputs: bundleInputs,
      };
      if (hashFrame !== null && authHash !== undefined) {
        bundle.hashFrame = hashFrame;
        bundle.hash = authHash;
      }
      state.hostFrameBuffer.set(frame, bundle);
      const minFrame = frame - Math.max(state.maxRollback, state.maxResend);
      for (const key of state.hostFrameBuffer.keys()) {
        if (key < minFrame) {
          state.hostFrameBuffer.delete(key);
        }
      }
    }
    this.deps.trimNetplayHistory(frame);
    if (state.role === 'host') {
      this.hostResendFrames(session.getFrame());
    } else {
      this.clientSendInputBuffer(session.getFrame());
    }
  }

  netplayTick(dtSeconds: number) {
    const state = this.deps.getNetplayState();
    if (!state) {
      return;
    }
    if (!this.deps.game.stageRuntime || this.deps.game.loadingStage) {
      this.deps.game.update(0);
      return;
    }
    const nowMs = performance.now();
    if (state.role === 'client' && state.awaitingStageSync) {
      this.deps.maybeResendStageReady(nowMs);
      this.deps.game.accumulator = 0;
      return;
    }
    if (state.role === 'host' && state.awaitingStageReady) {
      this.deps.maybeForceStageSync(nowMs);
      if (state.awaitingStageReady) {
        this.deps.game.accumulator = 0;
        return;
      }
    }
    if (state.role === 'host') {
      this.deps.hostApplyPendingRollback();
    }
    let netplayAccumulator = this.deps.getNetplayAccumulator();
    if (netplayAccumulator < 0) {
      netplayAccumulator = 0;
    }
    const session = state.session;
    const currentFrame = session.getFrame();
    const targetFrame = this.getNetplayTargetFrame(state, currentFrame);
    const simFrame = currentFrame + (netplayAccumulator / this.deps.game.fixedStep);
    const drift = targetFrame - simFrame;
    const introSync = this.deps.game.introTimerFrames > 0;
    if (state.role === 'client') {
      const clientPeer = this.deps.getClientPeer();
      if (clientPeer && nowMs - state.lastPingTimeMs >= this.deps.constants.pingIntervalMs) {
        const pingId = (state.pingSeq += 1);
        state.pendingPings.set(pingId, nowMs);
        state.lastPingTimeMs = nowMs;
        clientPeer.send({ type: 'ping', id: pingId });
      }
      const hostAge = state.lastHostFrameTimeMs === null ? null : nowMs - state.lastHostFrameTimeMs;
      const lastRequest = state.lastSnapshotRequestTimeMs ?? 0;
      const canRequest = state.lastSnapshotRequestTimeMs === null
        || (nowMs - lastRequest) >= this.deps.constants.snapshotCooldownMs;
      if (hostAge !== null && hostAge >= this.deps.constants.hostStallMs && canRequest) {
        this.deps.requestSnapshot('lag', state.lastReceivedHostFrame, true);
      }
      if (drift > this.deps.constants.lagFuseFrames) {
        if (state.lagBehindSinceMs === null) {
          state.lagBehindSinceMs = nowMs;
        }
        const timeBehind = nowMs - state.lagBehindSinceMs;
        if (timeBehind >= this.deps.constants.lagFuseMs && canRequest) {
          this.deps.requestSnapshot('lag', state.lastReceivedHostFrame, true);
        }
      } else {
        state.lagBehindSinceMs = null;
      }
    }
    if (state.role === 'client' && drift < -this.deps.constants.clientAheadSlack) {
      this.clientSendInputBuffer(currentFrame);
      return;
    }
    let rateScale = 1;
    if (state.role === 'client') {
      const driftRate = introSync ? this.deps.constants.syncDriftRate : this.deps.constants.clientDriftRate;
      const desired = 1 + drift * driftRate;
      const minRate = introSync ? this.deps.constants.syncRateMin : this.deps.constants.clientRateMin;
      const maxRate = introSync ? this.deps.constants.syncRateMax : this.deps.constants.clientRateMax;
      rateScale = clamp(desired, minRate, maxRate);
    }
    netplayAccumulator = Math.min(
      netplayAccumulator + dtSeconds * rateScale,
      this.deps.game.fixedStep * this.deps.constants.maxFrameDelta,
    );
    let ticks = Math.floor(netplayAccumulator / this.deps.game.fixedStep);
    const forceTick = introSync ? this.deps.constants.syncForceTick : this.deps.constants.driftForceTick;
    if (ticks <= 0 && drift > forceTick) {
      ticks = 1;
    }
    const extraTick = introSync ? this.deps.constants.syncExtraTicks : this.deps.constants.driftExtraTicks;
    if (drift > extraTick) {
      const maxTicks = introSync ? this.deps.constants.syncMaxTicks : 3;
      const add = introSync ? 2 : 1;
      ticks = Math.min(maxTicks, Math.max(1, ticks + add));
    }
    for (let i = 0; i < ticks; i += 1) {
      this.netplayStep();
      netplayAccumulator -= this.deps.game.fixedStep;
    }
    if (netplayAccumulator < 0) {
      netplayAccumulator = 0;
    }
    this.deps.setNetplayAccumulator(netplayAccumulator);
    if (state.role === 'host') {
      this.hostMaybeSendSnapshots(nowMs);
    }
    this.deps.game.accumulator = Math.max(0, Math.min(this.deps.game.fixedStep, netplayAccumulator));
  }

  updateNetplayDebugOverlay(nowMs: number) {
    const state = this.deps.getNetplayState();
    const debugEnabled = this.deps.isNetplayDebugEnabled();
    const perfEnabled = this.deps.netplayEnabled() && !!state && debugEnabled;
    const simPerf = this.deps.game.simPerf;
    if (simPerf) {
      simPerf.enabled = perfEnabled;
    }
    const stagePerf = this.deps.game.stageRuntime?.advancePerf;
    if (stagePerf) {
      stagePerf.enabled = perfEnabled;
    }
    if (!this.deps.netplayEnabled() || !state) {
      this.deps.game.netplayDebugLines = null;
      this.deps.game.netplayWarning = null;
      this.deps.netplayDebugOverlay.hide();
      this.deps.simPerfDebugOverlay.hide();
      return;
    }
    const localPlayer = this.deps.game.getLocalPlayer?.() ?? null;
    let warning: string | null = null;
    if (state.role === 'client') {
      const hostAge = state.lastHostFrameTimeMs === null ? null : nowMs - state.lastHostFrameTimeMs;
      if (hostAge !== null && hostAge > this.deps.constants.hostStallMs) {
        warning = `NET: host frames stale ${(hostAge / 1000).toFixed(1)}s`;
      } else if (state.awaitingStageSync) {
        warning = 'NET: awaiting stage sync';
      }
    }
    if (!warning && localPlayer) {
      if (localPlayer.isSpectator) {
        warning = 'NET: local spectator';
      } else if (localPlayer.pendingSpawn) {
        warning = 'NET: local pending spawn';
      }
    }
    this.deps.game.netplayWarning = warning;

    if (!debugEnabled) {
      this.deps.game.netplayDebugLines = null;
      this.deps.simPerfDebugOverlay.hide();
      if (!warning) {
        this.deps.netplayDebugOverlay.hide();
        return;
      }
      this.deps.netplayDebugOverlay.show(warning, []);
      return;
    }

    const sessionFrame = state.session.getFrame();
    const simFrame = sessionFrame + (this.deps.getNetplayAccumulator() / this.deps.game.fixedStep);
    const targetFrame = this.getNetplayTargetFrame(state, sessionFrame);
    const drift = targetFrame - simFrame;
    const lines: string[] = [];
    lines.push(`net ${state.role} id=${this.deps.game.localPlayerId}`);
    lines.push(`stage=${state.currentStageId ?? this.deps.game.stage?.stageId ?? 0} seq=${state.stageSeq}`);
    lines.push(`frame=${sessionFrame} host=${state.lastReceivedHostFrame} ack=${state.lastAckedLocalFrame}`);
    lines.push(`drift=${drift.toFixed(2)} acc=${this.deps.getNetplayAccumulator().toFixed(3)}`);
    lines.push(`sync=${state.awaitingStageSync ? 1 : 0} ready=${state.awaitingStageReady ? 1 : 0} snap=${state.awaitingSnapshot ? 1 : 0}`);
    if (state.role === 'client') {
      const chanState = this.deps.getClientPeer()?.getChannelState?.() ?? 'none';
      const hostAge = state.lastHostFrameTimeMs === null ? 'n/a' : `${((nowMs - state.lastHostFrameTimeMs) / 1000).toFixed(1)}s`;
      lines.push(`peer=${chanState} hostAge=${hostAge}`);
    } else {
      const peers = this.deps.getHostRelay()?.getChannelStates?.() ?? [];
      const peerText = peers.length
        ? peers.map((peer: any) => `${peer.playerId}:${peer.readyState}`).join(' ')
        : 'none';
      lines.push(`peers=${peerText}`);
      if (state.clientStates.size > 0) {
        const currentFrame = state.session.getFrame();
        const behindParts: string[] = [];
        for (const [playerId, clientState] of state.clientStates.entries()) {
          const ackedHostFrame = Math.min(clientState.lastAckedHostFrame, currentFrame);
          behindParts.push(`${playerId}:${currentFrame - ackedHostFrame}`);
        }
        const behind = behindParts.join(' ');
        lines.push(`behind=${behind}`);
      }
    }
    if (localPlayer) {
      lines.push(`local spec=${localPlayer.isSpectator ? 1 : 0} spawn=${localPlayer.pendingSpawn ? 1 : 0} state=${localPlayer.ball?.state ?? 0}`);
    }
    const sessionPerf = state.session?.perf;
    if (sessionPerf) {
      const saveAvg = sessionPerf.saveCount > 0 ? (sessionPerf.saveMsTotal / sessionPerf.saveCount) : 0;
      const loadAvg = sessionPerf.loadCount > 0 ? (sessionPerf.loadMsTotal / sessionPerf.loadCount) : 0;
      const advanceAvg = sessionPerf.advanceCount > 0 ? (sessionPerf.advanceMsTotal / sessionPerf.advanceCount) : 0;
      const rollbackAvgDist = sessionPerf.rollbackCount > 0
        ? (sessionPerf.rollbackDistanceTotal / sessionPerf.rollbackCount)
        : 0;
      lines.push(`rbk cnt=${sessionPerf.rollbackCount} miss=${sessionPerf.rollbackMissCount} dist=${rollbackAvgDist.toFixed(1)}/${sessionPerf.rollbackDistanceMax}`);
      lines.push(`rbkms s=${saveAvg.toFixed(3)}/${sessionPerf.saveMsMax.toFixed(2)} l=${loadAvg.toFixed(3)}/${sessionPerf.loadMsMax.toFixed(2)} a=${advanceAvg.toFixed(3)}/${sessionPerf.advanceMsMax.toFixed(2)}`);
    }
    const rollbackPerf = state.rollbackPerf;
    if (rollbackPerf) {
      const rollbackResimAvgMs = rollbackPerf.rollbackEvents > 0
        ? (rollbackPerf.rollbackResimMsTotal / rollbackPerf.rollbackEvents)
        : 0;
      const snapshotResimAvgMs = rollbackPerf.snapshotResimEvents > 0
        ? (rollbackPerf.snapshotResimMsTotal / rollbackPerf.snapshotResimEvents)
        : 0;
      lines.push(`resim rbk=${rollbackPerf.rollbackEvents} fail=${rollbackPerf.rollbackFails} fr=${rollbackPerf.rollbackResimFrames} ms=${rollbackResimAvgMs.toFixed(2)}/${rollbackPerf.rollbackResimMsMax.toFixed(2)}`);
      lines.push(`resim snap=${rollbackPerf.snapshotApplyCount}/${rollbackPerf.snapshotResimEvents} fr=${rollbackPerf.snapshotResimFrames} ms=${snapshotResimAvgMs.toFixed(2)}/${rollbackPerf.snapshotResimMsMax.toFixed(2)}`);
    }
    lines.push(`intro=${this.deps.game.introTimerFrames} timeover=${this.deps.game.timeoverTimerFrames}`);
    this.deps.game.netplayDebugLines = lines;
    this.deps.netplayDebugOverlay.show(warning, lines);

    const simLines: string[] = [];
    if (simPerf) {
      const tickAvg = simPerf.tickCount > 0 ? (simPerf.tickMsTotal / simPerf.tickCount) : 0;
      const stageAvg = simPerf.stageAdvanceCount > 0 ? (simPerf.stageAdvanceMsTotal / simPerf.stageAdvanceCount) : 0;
      const ballAvg = simPerf.ballStepCount > 0 ? (simPerf.ballStepMsTotal / simPerf.ballStepCount) : 0;
      const collPairAvg = simPerf.playerCollisionCount > 0
        ? (simPerf.playerCollisionMsTotal / simPerf.playerCollisionCount)
        : 0;
      const stageColAvg = simPerf.stageCollisionCalls > 0
        ? (simPerf.stageCollisionMsTotal / simPerf.stageCollisionCalls)
        : 0;
      const objColAvg = simPerf.stageObjectCollisionCalls > 0
        ? (simPerf.stageObjectCollisionMsTotal / simPerf.stageObjectCollisionCalls)
        : 0;
      simLines.push(`sim tick=${tickAvg.toFixed(3)}/${simPerf.tickMsMax.toFixed(2)} n=${simPerf.tickCount}`);
      simLines.push(`sim stage=${stageAvg.toFixed(3)}/${simPerf.stageAdvanceMsMax.toFixed(2)} ball=${ballAvg.toFixed(3)}/${simPerf.ballStepMsMax.toFixed(2)}`);
      simLines.push(`sim col pair=${collPairAvg.toFixed(3)}/${simPerf.playerCollisionMsMax.toFixed(2)} stage=${stageColAvg.toFixed(3)}/${simPerf.stageCollisionMsMax.toFixed(2)} obj=${objColAvg.toFixed(3)}/${simPerf.stageObjectCollisionMsMax.toFixed(2)}`);
      const stageTests = simPerf.stageCollisionCalls > 0
        ? `${simPerf.stageAnimGroupsBroadphaseHits}/${simPerf.stageAnimGroupsVisited} tri=${simPerf.stageTriCandidates} prim=${simPerf.stagePrimitiveTests}`
        : '0/0 tri=0 prim=0';
      const objectTests = simPerf.stageObjectCollisionCalls > 0
        ? `ag=${simPerf.objectAnimGroupsVisited} b=${simPerf.objectBumperTests} j=${simPerf.objectJamabarTests} g=${simPerf.objectGoalBagTests} t=${simPerf.objectGoalTapeTests} s=${simPerf.objectSwitchTests}`
        : 'ag=0 b=0 j=0 g=0 t=0 s=0';
      simLines.push(`sim stageTests ${stageTests}`);
      simLines.push(`sim objectTests ${objectTests}`);
      const modAllAvg = simPerf.modHookCalls > 0 ? (simPerf.modHookMsTotal / simPerf.modHookCalls) : 0;
      const modBeforeAvg = simPerf.modBeforeSimTickCalls > 0 ? (simPerf.modBeforeSimTickMsTotal / simPerf.modBeforeSimTickCalls) : 0;
      const modAfterAvg = simPerf.modAfterSimTickCalls > 0 ? (simPerf.modAfterSimTickMsTotal / simPerf.modAfterSimTickCalls) : 0;
      const modBallAvg = simPerf.modBallUpdateCalls > 0 ? (simPerf.modBallUpdateMsTotal / simPerf.modBallUpdateCalls) : 0;
      const modPostAvg = simPerf.modAfterBallStepCalls > 0 ? (simPerf.modAfterBallStepMsTotal / simPerf.modAfterBallStepCalls) : 0;
      const modCameraAvg = simPerf.modCameraUpdateCalls > 0 ? (simPerf.modCameraUpdateMsTotal / simPerf.modCameraUpdateCalls) : 0;
      const modGoalAvg = simPerf.modGoalHitCalls > 0 ? (simPerf.modGoalHitMsTotal / simPerf.modGoalHitCalls) : 0;
      simLines.push(`sim mod all=${modAllAvg.toFixed(3)}/${simPerf.modHookMsMax.toFixed(2)} ball=${modBallAvg.toFixed(3)}/${simPerf.modBallUpdateMsMax.toFixed(2)} post=${modPostAvg.toFixed(3)}/${simPerf.modAfterBallStepMsMax.toFixed(2)}`);
      simLines.push(`sim mod pre=${modBeforeAvg.toFixed(3)} aft=${modAfterAvg.toFixed(3)} cam=${modCameraAvg.toFixed(3)} goal=${modGoalAvg.toFixed(3)} n=${simPerf.modHookCalls}`);
    }
    if (stagePerf) {
      const animAvg = stagePerf.tickCount > 0 ? (stagePerf.animMs / stagePerf.tickCount) : 0;
      const animPlaybackAvg = stagePerf.tickCount > 0 ? (stagePerf.animPlaybackMs / stagePerf.tickCount) : 0;
      const animKeyframesAvg = stagePerf.tickCount > 0 ? (stagePerf.animKeyframesMs / stagePerf.tickCount) : 0;
      const animMatrixAvg = stagePerf.tickCount > 0 ? (stagePerf.animMatrixMs / stagePerf.tickCount) : 0;
      const animSeesawAvg = stagePerf.tickCount > 0 ? (stagePerf.animSeesawMs / stagePerf.tickCount) : 0;
      const animFinalizeAvg = stagePerf.tickCount > 0 ? (stagePerf.animFinalizeMs / stagePerf.tickCount) : 0;
      const animGroupsAvg = stagePerf.tickCount > 0 ? (stagePerf.animGroupsProcessed / stagePerf.tickCount) : 0;
      const animGroupsWithAnimAvg = stagePerf.tickCount > 0 ? (stagePerf.animGroupsWithAnim / stagePerf.tickCount) : 0;
      const animGroupsWithSeesawAvg = stagePerf.tickCount > 0 ? (stagePerf.animGroupsWithSeesaw / stagePerf.tickCount) : 0;
      const animKeyEvalAvg = stagePerf.tickCount > 0 ? (stagePerf.animKeyframeEvals / stagePerf.tickCount) : 0;
      const switchAvg = stagePerf.tickCount > 0 ? (stagePerf.switchesMs / stagePerf.tickCount) : 0;
      const objAvg = stagePerf.tickCount > 0 ? (stagePerf.objectsMs / stagePerf.tickCount) : 0;
      const goalTapeAvg = stagePerf.tickCount > 0 ? (stagePerf.goalTapesMs / stagePerf.tickCount) : 0;
      const goalBagAvg = stagePerf.tickCount > 0 ? (stagePerf.goalBagsMs / stagePerf.tickCount) : 0;
      const visualAvg = stagePerf.tickCount > 0 ? (stagePerf.visualsMs / stagePerf.tickCount) : 0;
      const bumperAvg = stagePerf.tickCount > 0 ? (stagePerf.bumpersMs / stagePerf.tickCount) : 0;
      const jamabarAvg = stagePerf.tickCount > 0 ? (stagePerf.jamabarsMs / stagePerf.tickCount) : 0;
      const bananaAvg = stagePerf.tickCount > 0 ? (stagePerf.bananasMs / stagePerf.tickCount) : 0;
      const switchObjAvg = stagePerf.tickCount > 0 ? (stagePerf.objectsSwitchesMs / stagePerf.tickCount) : 0;
      const syncAvg = stagePerf.tickCount > 0 ? (stagePerf.syncTransformsMs / stagePerf.tickCount) : 0;
      simLines.push(`stage anim=${animAvg.toFixed(3)} sw=${switchAvg.toFixed(3)} obj=${objAvg.toFixed(3)}`);
      simLines.push(`anim key=${animKeyframesAvg.toFixed(3)} mat=${animMatrixAvg.toFixed(3)} play=${animPlaybackAvg.toFixed(3)} see=${animSeesawAvg.toFixed(3)} fin=${animFinalizeAvg.toFixed(3)}`);
      simLines.push(`anim grp=${animGroupsAvg.toFixed(1)} a=${animGroupsWithAnimAvg.toFixed(1)} s=${animGroupsWithSeesawAvg.toFixed(1)} eval=${animKeyEvalAvg.toFixed(1)}`);
      simLines.push(`obj tape=${goalTapeAvg.toFixed(3)} bag=${goalBagAvg.toFixed(3)} vis=${visualAvg.toFixed(3)} bump=${bumperAvg.toFixed(3)} jam=${jamabarAvg.toFixed(3)}`);
      simLines.push(`obj banana=${bananaAvg.toFixed(3)} switch=${switchObjAvg.toFixed(3)} sync=${syncAvg.toFixed(3)}`);
    }
    if (simLines.length > 0) {
      this.deps.simPerfDebugOverlay.show(simLines);
    } else {
      this.deps.simPerfDebugOverlay.hide();
    }
  }
}
