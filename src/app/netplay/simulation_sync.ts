import type { Game } from '../../game.js';
import type { QuantizedInput } from '../../determinism.js';

type SimulationDeps = {
  game: Game;
  getNetplayState: () => any | null;
  getPendingSnapshot: () => any | null;
  setPendingSnapshot: (snapshot: any | null) => void;
  getSimHash: () => number;
  resetNetplaySession: () => void;
  quantizedEqual: (a: QuantizedInput, b: QuantizedInput) => boolean;
};

export class NetplaySimulationSyncController {
  private readonly deps: SimulationDeps;

  constructor(deps: SimulationDeps) {
    this.deps = deps;
  }

  private nowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  private ensureRollbackPerf(state: any) {
    if (state.rollbackPerf) {
      return state.rollbackPerf;
    }
    state.rollbackPerf = {
      rollbackEvents: 0,
      rollbackFails: 0,
      rollbackResimFrames: 0,
      rollbackResimMsTotal: 0,
      rollbackResimMsLast: 0,
      rollbackResimMsMax: 0,
      snapshotApplyCount: 0,
      snapshotResimEvents: 0,
      snapshotResimFrames: 0,
      snapshotResimMsTotal: 0,
      snapshotResimMsLast: 0,
      snapshotResimMsMax: 0,
      lastRollbackStartFrame: -1,
      lastRollbackDistance: 0,
      lastSnapshotFrame: -1,
      lastSnapshotResimFrames: 0,
    };
    return state.rollbackPerf;
  }

  recordInputForFrame(frame: number, playerId: number, input: QuantizedInput) {
    const state = this.deps.getNetplayState();
    if (!state) {
      return false;
    }
    let frameInputs = state.inputHistory.get(frame);
    if (!frameInputs) {
      frameInputs = new Map();
      state.inputHistory.set(frame, frameInputs);
    }
    const prev = frameInputs.get(playerId);
    if (prev && this.deps.quantizedEqual(prev, input)) {
      return false;
    }
    frameInputs.set(playerId, input);
    state.lastInputs.set(playerId, input);
    return true;
  }

  buildInputsForFrame(frame: number) {
    const state = this.deps.getNetplayState();
    if (!state) {
      return new Map<number, QuantizedInput>();
    }
    let frameInputs = state.inputHistory.get(frame);
    if (!frameInputs) {
      frameInputs = new Map();
      state.inputHistory.set(frame, frameInputs);
    }
    for (const player of this.deps.game.players) {
      if (!frameInputs.has(player.id)) {
        const last = state.lastInputs.get(player.id) ?? { x: 0, y: 0, buttons: 0 };
        frameInputs.set(player.id, last);
      }
    }
    return frameInputs;
  }

  private trimFrameMap(map: Map<number, unknown>, minFrame: number) {
    for (const key of map.keys()) {
      if (key < minFrame) {
        map.delete(key);
      }
    }
  }

  trimNetplayHistory(frame: number) {
    const state = this.deps.getNetplayState();
    if (!state) {
      return;
    }
    const minFrame = frame - state.maxRollback;
    this.trimFrameMap(state.inputHistory, minFrame);
    this.trimFrameMap(state.hashHistory, minFrame);
    this.trimFrameMap(state.expectedHashes, minFrame);
  }

  rollbackAndResim(startFrame: number) {
    const state = this.deps.getNetplayState();
    if (!state) {
      return false;
    }
    const perf = this.ensureRollbackPerf(state);
    perf.rollbackEvents += 1;
    perf.lastRollbackStartFrame = startFrame | 0;
    const session = state.session;
    const current = session.getFrame();
    const rollbackFrame = Math.max(0, startFrame - 1);
    if (!session.rollbackTo(rollbackFrame)) {
      perf.rollbackFails += 1;
      return false;
    }
    const resimFrames = Math.max(0, current - rollbackFrame);
    perf.lastRollbackDistance = resimFrames;
    const startMs = this.nowMs();
    const prevSuppress = session.suppressVisuals;
    session.suppressVisuals = true;
    try {
      for (let frame = rollbackFrame + 1; frame <= current; frame += 1) {
        const inputs = this.buildInputsForFrame(frame);
        session.advanceTo(frame, inputs);
        let hash: number | undefined;
        if (state.hashInterval > 0 && frame % state.hashInterval === 0) {
          hash = this.deps.getSimHash();
          state.hashHistory.set(frame, hash);
        }
        if (state.role === 'host') {
          const bundleInputs: Record<number, QuantizedInput> = {};
          for (const [playerId, input] of inputs.entries()) {
            bundleInputs[playerId] = input;
          }
          state.hostFrameBuffer.set(frame, {
            type: 'frame',
            stageSeq: state.stageSeq,
            frame,
            inputs: bundleInputs,
          });
        }
        this.trimNetplayHistory(frame);
      }
    } finally {
      session.suppressVisuals = prevSuppress;
      const elapsedMs = this.nowMs() - startMs;
      perf.rollbackResimFrames += resimFrames;
      perf.rollbackResimMsTotal += elapsedMs;
      perf.rollbackResimMsLast = elapsedMs;
      if (elapsedMs > perf.rollbackResimMsMax) {
        perf.rollbackResimMsMax = elapsedMs;
      }
    }
    return true;
  }

  private resimFromSnapshot(snapshotFrame: number, targetFrame: number) {
    const state = this.deps.getNetplayState();
    if (!state) {
      return;
    }
    const perf = this.ensureRollbackPerf(state);
    perf.lastSnapshotFrame = snapshotFrame | 0;
    if (targetFrame <= snapshotFrame) {
      perf.lastSnapshotResimFrames = 0;
      return;
    }
    const session = state.session;
    const resimFrames = Math.max(0, targetFrame - snapshotFrame);
    perf.snapshotResimEvents += 1;
    perf.lastSnapshotResimFrames = resimFrames;
    const startMs = this.nowMs();
    const prevSuppress = session.suppressVisuals;
    session.suppressVisuals = true;
    try {
      for (let frame = snapshotFrame + 1; frame <= targetFrame; frame += 1) {
        const inputs = this.buildInputsForFrame(frame);
        session.advanceTo(frame, inputs);
        if (state.hashInterval > 0 && frame % state.hashInterval === 0) {
          state.hashHistory.set(frame, this.deps.getSimHash());
        }
        this.trimNetplayHistory(frame);
      }
    } finally {
      session.suppressVisuals = prevSuppress;
      const elapsedMs = this.nowMs() - startMs;
      perf.snapshotResimFrames += resimFrames;
      perf.snapshotResimMsTotal += elapsedMs;
      perf.snapshotResimMsLast = elapsedMs;
      if (elapsedMs > perf.snapshotResimMsMax) {
        perf.snapshotResimMsMax = elapsedMs;
      }
    }
  }

  tryApplyPendingSnapshot(stageId: number) {
    const pendingSnapshot = this.deps.getPendingSnapshot();
    if (!pendingSnapshot) {
      return;
    }
    const state = this.deps.getNetplayState();
    if (state && pendingSnapshot.stageSeq !== undefined && pendingSnapshot.stageSeq !== state.stageSeq) {
      this.deps.setPendingSnapshot(null);
      return;
    }
    if (pendingSnapshot.stageId !== undefined && pendingSnapshot.stageId !== stageId) {
      return;
    }
    const targetFrame = state?.session.getFrame() ?? this.deps.game.simTick;
    const snapshotFrame = pendingSnapshot.frame;
    this.deps.game.loadRollbackState(pendingSnapshot.state);
    this.deps.resetNetplaySession();
    if (state) {
      const perf = this.ensureRollbackPerf(state);
      perf.snapshotApplyCount += 1;
      perf.lastSnapshotFrame = snapshotFrame | 0;
      state.lastReceivedHostFrame = Math.max(state.lastReceivedHostFrame, snapshotFrame);
      state.awaitingSnapshot = false;
      state.hashHistory.clear();
      for (const key of state.expectedHashes.keys()) {
        if (key <= snapshotFrame) {
          state.expectedHashes.delete(key);
        }
      }
    }
    this.resimFromSnapshot(snapshotFrame, targetFrame);
    if (state) {
      state.lagBehindSinceMs = null;
    }
    this.deps.setPendingSnapshot(null);
  }
}
