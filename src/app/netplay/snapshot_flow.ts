import type { Game } from '../../game.js';

type SnapshotFlowDeps = {
  game: Game;
  getNetplayState: () => any | null;
  getClientPeer: () => { send: (msg: any) => boolean | void } | null;
  getHostRelay: () => { sendTo: (playerId: number, msg: any) => boolean | void } | null;
  rollbackAndResim: (startFrame: number) => boolean;
  snapshotCooldownMs: number;
  snapshotMismatchCooldownMs: number;
};

export class SnapshotFlowController {
  private readonly deps: SnapshotFlowDeps;

  constructor(deps: SnapshotFlowDeps) {
    this.deps = deps;
  }

  requestSnapshot(reason: 'mismatch' | 'lag', frame?: number, force = false) {
    const clientPeer = this.deps.getClientPeer();
    const state = this.deps.getNetplayState();
    if (!clientPeer || !state) {
      return;
    }
    const nowMs = performance.now();
    const lastRequest = state.lastSnapshotRequestTimeMs ?? 0;
    const cooldownMs = reason === 'mismatch'
      ? this.deps.snapshotMismatchCooldownMs
      : this.deps.snapshotCooldownMs;
    const cooldownOk = state.lastSnapshotRequestTimeMs === null
      || (nowMs - lastRequest) >= cooldownMs;
    if (state.awaitingSnapshot && !force && !cooldownOk) {
      return;
    }
    if (!cooldownOk) {
      return;
    }
    const targetFrame = frame ?? state.session.getFrame();
    const snapshotRequest = {
      type: 'snapshot_request',
      stageSeq: state.stageSeq,
      frame: targetFrame,
      reason,
    };
    const sendResult = clientPeer.send(snapshotRequest);
    if (sendResult === false) {
      return;
    }
    state.lastSnapshotRequestTimeMs = nowMs;
    state.awaitingSnapshot = true;
    if (reason === 'mismatch') {
      state.debugSnapshotRequestsMismatch = (state.debugSnapshotRequestsMismatch ?? 0) + 1;
    } else {
      state.debugSnapshotRequestsLag = (state.debugSnapshotRequestsLag ?? 0) + 1;
    }
    state.debugLastSnapshotRequestReason = reason;
    state.debugLastSnapshotRequestFrame = targetFrame;
    state.debugLastSnapshotRequestAtMs = nowMs;
  }

  hostApplyPendingRollback() {
    const state = this.deps.getNetplayState();
    if (!state || state.role !== 'host') {
      return;
    }
    const rollbackFrame = state.pendingHostRollbackFrame;
    if (rollbackFrame === null) {
      return;
    }
    const snapshotTargets = Array.from(state.pendingHostRollbackPlayers);
    state.pendingHostRollbackFrame = null;
    state.pendingHostRollbackPlayers.clear();
    if (!this.deps.rollbackAndResim(rollbackFrame)) {
      for (const playerId of snapshotTargets) {
        this.sendSnapshotToClient(playerId, rollbackFrame);
      }
      return;
    }
    state.pendingHostUpdates.add(rollbackFrame);
  }

  sendSnapshotToClient(playerId: number, frame?: number) {
    const hostRelay = this.deps.getHostRelay();
    const state = this.deps.getNetplayState();
    if (!hostRelay || !state) {
      return;
    }
    const session = state.session;
    let snapshotFrame = frame ?? session.getFrame();
    if (snapshotFrame > session.getFrame()) {
      snapshotFrame = session.getFrame();
    }
    let snapshotState = session.getState(snapshotFrame);
    if (!snapshotState) {
      snapshotFrame = session.getFrame();
      snapshotState = this.deps.game.saveRollbackState();
    }
    if (!snapshotState) {
      return;
    }
    const snapshot = {
      type: 'snapshot',
      stageSeq: state.stageSeq,
      frame: snapshotFrame,
      state: snapshotState,
      stageId: this.deps.game.stage?.stageId,
      gameSource: this.deps.game.gameSource,
    };
    const sendResult = hostRelay.sendTo(playerId, snapshot);
    return sendResult !== false;
  }
}
