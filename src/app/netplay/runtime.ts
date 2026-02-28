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
  clientInactivityTimeoutMs: number;
  hostMaxInputRollback: number;
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
  getSimHashBreakdown?: () => {
    ballsHash: number;
    worldsHash: number;
    stageHash: number;
    detHash: number;
    fullHash: number;
  };
  requestSnapshot: (reason: 'mismatch' | 'lag', frame?: number, force?: boolean) => void;
  hostApplyPendingRollback: () => void;
  sendSnapshotToClient: (playerId: number, frame?: number) => void;
  rejectHostConnection: (playerId: number, reason?: string) => void;
  maybeResendStageReady: (nowMs: number) => void;
  maybeForceStageSync: (nowMs: number) => void;
  getAuthoritativeHashFrame: (state: any) => number | null;
  getEstimatedHostFrame: (state: any) => number;
  getClientLeadFrames: (state: any) => number;
  isNetplayDebugEnabled: () => boolean;
  netplayDebugOverlay: { show: (warning: string | null, lines: string[]) => void; hide: () => void };
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

function formatBandwidthBps(bytesPerSecond: number) {
  const bps = Math.max(0, Math.trunc(bytesPerSecond));
  const kbps = ((bps * 8) / 1000).toFixed(2);
  return `${bps}B/s (${kbps}kbps)`;
}

function formatHash(value: unknown) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return `0x${(Number(value) >>> 0).toString(16).padStart(8, '0')}`;
}

export class NetplayRuntimeController {
  private readonly deps: RuntimeDeps;

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
  }

  private recordHashMismatch(state: any, frame: number, expectedHash: number, localHash: number, nowMs: number) {
    const normalizedExpected = expectedHash >>> 0;
    const normalizedLocal = localHash >>> 0;
    const sameSignature = state.lastMismatchSignatureFrame === frame
      && (Number(state.lastMismatchSignatureExpectedHash) >>> 0) === normalizedExpected
      && (Number(state.lastMismatchSignatureLocalHash) >>> 0) === normalizedLocal;
    if (sameSignature) {
      return false;
    }
    state.lastMismatchSignatureFrame = frame;
    state.lastMismatchSignatureExpectedHash = normalizedExpected;
    state.lastMismatchSignatureLocalHash = normalizedLocal;
    state.lastMismatchSignatureAtMs = nowMs;
    state.debugHashMismatchCount = (state.debugHashMismatchCount ?? 0) + 1;
    state.debugLastMismatchFrame = frame;
    state.debugLastMismatchExpectedHash = normalizedExpected;
    state.debugLastMismatchLocalHash = normalizedLocal;
    state.debugLastMismatchAtMs = nowMs;
    const localParts = state.hashBreakdownHistory?.get?.(frame) ?? null;
    const expectedParts = state.expectedHashProbeByFrame?.get?.(frame) ?? null;
    if (!localParts || !expectedParts) {
      state.debugLastMismatchParts = null;
      return true;
    }
    state.debugLastMismatchParts = {
      ballsLocal: localParts.ballsHash >>> 0,
      ballsHost: expectedParts.ballsHash >>> 0,
      worldsLocal: localParts.worldsHash >>> 0,
      worldsHost: expectedParts.worldsHash >>> 0,
      stageLocal: localParts.stageHash >>> 0,
      stageHost: expectedParts.stageHash >>> 0,
      detLocal: localParts.detHash >>> 0,
      detHost: expectedParts.detHash >>> 0,
    };
    return true;
  }

  private getNetplayTargetFrame(state: any, currentFrame: number) {
    if (state.role === 'client') {
      return this.deps.getEstimatedHostFrame(state) + this.deps.getClientLeadFrames(state);
    }
    return currentFrame;
  }

  private hostCanonizeClientInputAcks(state: any, currentFrame: number) {
    if (!state || state.role !== 'host' || !state.clientStates?.entries) {
      return;
    }
    // Canonize slightly behind the host frontier to smooth ACK progression without
    // immediately freezing out late-arriving corrections for the most recent frames.
    const rollbackLimit = Math.max(0, Math.floor(this.deps.constants.hostMaxInputRollback ?? 0));
    const canonizeSlack = Math.min(rollbackLimit, 2);
    const canonizeThrough = Math.floor(currentFrame) - canonizeSlack;
    if (!Number.isFinite(canonizeThrough)) {
      return;
    }
    for (const [playerId, clientState] of state.clientStates.entries()) {
      if (!clientState) {
        continue;
      }
      const pending = clientState.pendingClientInputReceipts;
      let contiguous = Number.isFinite(clientState.lastAckedClientInput)
        ? Math.floor(clientState.lastAckedClientInput)
        : -1;
      if (contiguous >= canonizeThrough) {
        continue;
      }
      const player = this.deps.game.players.find((entry) => entry.id === playerId);
      const autoCanonize = !player || player.isSpectator || player.pendingSpawn;
      while (contiguous < canonizeThrough) {
        const next = contiguous + 1;
        if (pending?.has?.(next)) {
          pending.delete(next);
          contiguous = next;
          continue;
        }
        if (autoCanonize) {
          contiguous = next;
          continue;
        }
        const frameInputs = state.inputHistory?.get?.(next);
        if (frameInputs?.has?.(playerId)) {
          contiguous = next;
          continue;
        }
        break;
      }
      clientState.lastAckedClientInput = contiguous;
      if (pending?.keys && pending.delete) {
        for (const frame of pending.keys()) {
          if (frame <= contiguous) {
            pending.delete(frame);
          }
        }
      }
    }
  }

  private pruneHostFrameBuffer(state: any, currentFrame: number) {
    if (!state?.hostFrameBuffer?.keys || !state.hostFrameBuffer.delete) {
      return;
    }
    const historyWindow = Math.max(
      60,
      Math.floor(state.maxRollback ?? 0),
      Math.floor(state.maxResend ?? 0),
    );
    let cutoff = Math.floor(currentFrame) - historyWindow;
    let minAck: number | null = null;
    for (const clientState of state.clientStates?.values?.() ?? []) {
      const ack = Number(clientState?.lastAckedHostFrame);
      if (!Number.isFinite(ack)) {
        continue;
      }
      const ackFrame = Math.floor(ack);
      minAck = minAck === null ? ackFrame : Math.min(minAck, ackFrame);
    }
    if (minAck !== null) {
      cutoff = Math.max(cutoff, minAck);
    }
    if (state.pendingHostUpdates?.size > 0) {
      let earliestPending = Infinity;
      for (const frame of state.pendingHostUpdates) {
        if (frame < earliestPending) {
          earliestPending = frame;
        }
      }
      if (Number.isFinite(earliestPending) && earliestPending <= cutoff) {
        cutoff = earliestPending - 1;
      }
    }
    for (const frame of state.hostFrameBuffer.keys()) {
      if (frame <= cutoff) {
        state.hostFrameBuffer.delete(frame);
      }
    }
  }

  private hostResendFrames(currentFrame: number) {
    const hostRelay = this.deps.getHostRelay();
    const state = this.deps.getNetplayState();
    if (!hostRelay || !state) {
      return;
    }
    this.hostCanonizeClientInputAcks(state, currentFrame);
    const pendingFrames = state.pendingHostUpdates.size > 0
      ? Array.from(state.pendingHostUpdates).sort((a, b) => a - b)
      : [];
    const bufferedFrames = state.hostFrameBuffer.size > 0
      ? Array.from(state.hostFrameBuffer.keys()).sort((a, b) => a - b)
      : [];
    const bundleCache = new Map<number, FrameBundleMessage[]>();
    for (const [playerId, clientState] of state.clientStates.entries()) {
      const ackedHostFrame = Math.min(clientState.lastAckedHostFrame, currentFrame);
      let bundles = bundleCache.get(ackedHostFrame);
      if (!bundles) {
        const selected = new Set<number>();
        for (const frame of bufferedFrames) {
          if (frame > ackedHostFrame && frame <= currentFrame) {
            selected.add(frame);
          }
        }
        for (const frame of pendingFrames) {
          if (frame <= currentFrame) {
            selected.add(frame);
          }
        }
        const sortedFrames = selected.size > 0
          ? Array.from(selected).sort((a, b) => a - b)
          : [];
        bundles = [];
        for (const frame of sortedFrames) {
          const bundle = state.hostFrameBuffer.get(frame);
          if (!bundle) {
            continue;
          }
          bundles.push(bundle);
        }
        bundleCache.set(ackedHostFrame, bundles);
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

  private hostDisconnectInactiveClients(nowMs: number) {
    const state = this.deps.getNetplayState();
    if (!state || state.role !== 'host') {
      return;
    }
    const graceUntil = Number(state.hostInactivityKickGraceUntilMs);
    if (Number.isFinite(graceUntil) && nowMs < graceUntil) {
      return;
    }
    if (state.awaitingStageReady) {
      return;
    }
    const timeoutMs = this.deps.constants.clientInactivityTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return;
    }
    for (const [playerId, clientState] of state.clientStates.entries()) {
      if (clientState.timeoutKickSentMs !== null && clientState.timeoutKickSentMs !== undefined) {
        continue;
      }
      if (!Number.isFinite(clientState.lastInboundMessageMs)) {
        clientState.lastInboundMessageMs = nowMs;
      }
      if ((nowMs - clientState.lastInboundMessageMs) < timeoutMs) {
        continue;
      }
      clientState.timeoutKickSentMs = nowMs;
      this.deps.rejectHostConnection(playerId, `Disconnected: timed out (${Math.round(timeoutMs / 1000)}s no messages)`);
    }
  }

  private clientSendInputBuffer(currentFrame: number) {
    const clientPeer = this.deps.getClientPeer();
    const state = this.deps.getNetplayState();
    if (!clientPeer || !state) {
      return;
    }
    const hostAckFrame = Number.isFinite(state.highestContiguousHostFrame)
      ? Math.floor(state.highestContiguousHostFrame)
      : Math.max(-1, Math.floor(state.lastReceivedHostFrame ?? -1));
    const start = state.lastAckedLocalFrame + 1;
    const end = currentFrame;
    const resendWindow = Math.max(1, state.maxResend | 0);
    const tailStart = Math.max(start, end - resendWindow + 1);
    const batchEntries: Array<{ frame: number; input: QuantizedInput }> = [];
    for (let frame = tailStart; frame <= end; frame += 1) {
      const input = state.pendingLocalInputs.get(frame);
      if (!input) {
        continue;
      }
      batchEntries.push({ frame, input });
    }
    if (batchEntries.length > 0) {
      clientPeer.sendInputBatch(state.stageSeq, hostAckFrame, batchEntries);
    }
    if (start > end) {
      clientPeer.send({
        type: 'ack',
        stageSeq: state.stageSeq,
        playerId: this.deps.game.localPlayerId,
        frame: hostAckFrame,
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
      const breakdown = this.deps.getSimHashBreakdown?.();
      if (breakdown) {
        hash = breakdown.fullHash >>> 0;
        state.hashBreakdownHistory?.set?.(frame, {
          ballsHash: breakdown.ballsHash >>> 0,
          worldsHash: breakdown.worldsHash >>> 0,
          stageHash: breakdown.stageHash >>> 0,
          detHash: breakdown.detHash >>> 0,
          fullHash: breakdown.fullHash >>> 0,
        });
      } else {
        hash = this.deps.getSimHash();
      }
      state.hashHistory.set(frame, hash);
      const expected = state.expectedHashes.get(frame);
      const canValidate = state.role !== 'client'
        || frame <= (Number.isFinite(state.highestContiguousHostFrame) ? Math.floor(state.highestContiguousHostFrame) : -1);
      if (canValidate && expected !== undefined && expected !== hash) {
        state.expectedHashes.delete(frame);
        if (this.recordHashMismatch(state, frame, expected, hash, performance.now())) {
          this.deps.requestSnapshot('mismatch', frame);
        }
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
        const probe = state.hashBreakdownHistory?.get?.(hashFrame);
        if (probe) {
          this.deps.getHostRelay()?.broadcast?.({
            type: 'hash_probe',
            stageSeq: state.stageSeq,
            frame: hashFrame,
            hash: authHash >>> 0,
            ballsHash: probe.ballsHash >>> 0,
            worldsHash: probe.worldsHash >>> 0,
            stageHash: probe.stageHash >>> 0,
            detHash: probe.detHash >>> 0,
          });
        }
      }
      state.hostFrameBuffer.set(frame, bundle);
      this.pruneHostFrameBuffer(state, frame);
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
    if (state.role === 'host') {
      this.hostDisconnectInactiveClients(nowMs);
    }
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
    if (!this.deps.netplayEnabled() || !state) {
      this.deps.game.netplayDebugLines = null;
      this.deps.game.netplayWarning = null;
      this.deps.netplayDebugOverlay.hide();
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
    const snapMismatch = state.debugSnapshotRequestsMismatch ?? 0;
    const snapLag = state.debugSnapshotRequestsLag ?? 0;
    const snapReason = state.debugLastSnapshotRequestReason ?? '-';
    const snapFrame = Number.isFinite(state.debugLastSnapshotRequestFrame) ? state.debugLastSnapshotRequestFrame : '-';
    lines.push(`snapReq m=${snapMismatch} l=${snapLag} last=${snapReason}@${snapFrame}`);
    if (Number.isFinite(state.debugLastMismatchFrame)) {
      lines.push(
        `mismatch#${state.debugHashMismatchCount ?? 0}`
        + ` f=${state.debugLastMismatchFrame}`
        + ` local=${formatHash(state.debugLastMismatchLocalHash)}`
        + ` host=${formatHash(state.debugLastMismatchExpectedHash)}`,
      );
      const mismatchParts = state.debugLastMismatchParts;
      if (mismatchParts) {
        lines.push(
          `mismatchParts`
          + ` balls ${formatHash(mismatchParts.ballsLocal)}/${formatHash(mismatchParts.ballsHost)}`
          + ` worlds ${formatHash(mismatchParts.worldsLocal)}/${formatHash(mismatchParts.worldsHost)}`
          + ` stage ${formatHash(mismatchParts.stageLocal)}/${formatHash(mismatchParts.stageHost)}`
          + ` det ${formatHash(mismatchParts.detLocal)}/${formatHash(mismatchParts.detHost)}`,
        );
      }
    }
    if (state.role === 'client') {
      const chanState = this.deps.getClientPeer()?.getChannelState?.() ?? 'none';
      const hostAge = state.lastHostFrameTimeMs === null ? 'n/a' : `${((nowMs - state.lastHostFrameTimeMs) / 1000).toFixed(1)}s`;
      lines.push(`peer=${chanState} hostAge=${hostAge}`);
      if (Number.isFinite(state.highestContiguousHostFrame)) {
        lines.push(`hostContig=${Math.floor(state.highestContiguousHostFrame)}`);
      }
      const bw = this.deps.getClientPeer()?.getBandwidthStats?.();
      if (bw) {
        lines.push(`bw up=${formatBandwidthBps(bw.upBps)} dn=${formatBandwidthBps(bw.downBps)}`);
        lines.push(`bwTotal up=${bw.upTotalBytes}B dn=${bw.downTotalBytes}B`);
      }
    } else {
      const peers = this.deps.getHostRelay()?.getChannelStates?.() ?? [];
      const peerText = peers.length
        ? peers.map((peer: any) => `${peer.playerId}:${peer.readyState}`).join(' ')
        : 'none';
      lines.push(`peers=${peerText}`);
      const bw = this.deps.getHostRelay()?.getBandwidthStats?.();
      if (bw) {
        lines.push(`bw up=${formatBandwidthBps(bw.upBps)} dn=${formatBandwidthBps(bw.downBps)}`);
        lines.push(`bwTotal up=${bw.upTotalBytes}B dn=${bw.downTotalBytes}B`);
        if (bw.peers?.length > 0) {
          const peerBw = bw.peers
            .map((peer: any) => `${peer.playerId}:u${Math.trunc(peer.upBps)} d${Math.trunc(peer.downBps)}B/s`)
            .join(' ');
          lines.push(`bwPeer=${peerBw}`);
        }
      }
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
    lines.push(`intro=${this.deps.game.introTimerFrames} timeover=${this.deps.game.timeoverTimerFrames}`);
    this.deps.game.netplayDebugLines = lines;
    this.deps.netplayDebugOverlay.show(warning, lines);
  }
}
