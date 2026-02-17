import type { QuantizedInput } from './determinism.js';

export type FrameInputs = Map<number, QuantizedInput>;

export type RollbackCallbacks<T> = {
  saveState: (reuseState?: T) => T;
  loadState: (state: T) => void;
  advanceFrame: (inputs: FrameInputs) => void;
};

const INVALID_FRAME = -2147483648;

export class RollbackSession<T> {
  private callbacks: RollbackCallbacks<T>;
  private maxRollbackFrames: number;
  private historySize: number;
  private stateFrames: Int32Array;
  private inputFrames: Int32Array;
  private stateSlots: Array<T | null>;
  private inputSlots: Array<FrameInputs | null>;
  private statePool: T[] = [];
  private lastFrame = 0;
  public suppressVisuals = false;

  constructor(callbacks: RollbackCallbacks<T>, maxRollbackFrames = 30) {
    this.callbacks = callbacks;
    this.maxRollbackFrames = Math.max(1, maxRollbackFrames | 0);
    this.historySize = Math.max(this.maxRollbackFrames + 4, 8);
    this.stateFrames = new Int32Array(this.historySize);
    this.inputFrames = new Int32Array(this.historySize);
    this.stateSlots = new Array(this.historySize).fill(null);
    this.inputSlots = new Array(this.historySize).fill(null);
    this.clearSlots();
  }

  getFrame() {
    return this.lastFrame;
  }

  private recycleState(state: T | undefined) {
    if (state === undefined || state === null) {
      return;
    }
    if (this.statePool.length >= (this.maxRollbackFrames + 4)) {
      return;
    }
    this.statePool.push(state);
  }

  private clearSlots() {
    for (let i = 0; i < this.historySize; i += 1) {
      this.stateFrames[i] = INVALID_FRAME;
      this.inputFrames[i] = INVALID_FRAME;
      this.stateSlots[i] = null;
      this.inputSlots[i] = null;
    }
  }

  private slotForFrame(frame: number) {
    const mod = frame % this.historySize;
    return mod < 0 ? (mod + this.historySize) : mod;
  }

  private setStateHistory(frame: number, state: T) {
    const slot = this.slotForFrame(frame);
    const existingFrame = this.stateFrames[slot];
    const existing = this.stateSlots[slot];
    if (existingFrame !== frame && existing !== null && existing !== state) {
      this.recycleState(existing);
    }
    this.stateFrames[slot] = frame;
    this.stateSlots[slot] = state;
  }

  private setInputHistory(frame: number, inputs: FrameInputs) {
    const slot = this.slotForFrame(frame);
    this.inputFrames[slot] = frame;
    this.inputSlots[slot] = inputs;
  }

  private resetHistory() {
    for (let i = 0; i < this.historySize; i += 1) {
      if (this.stateFrames[i] !== INVALID_FRAME) {
        this.recycleState(this.stateSlots[i] ?? undefined);
      }
    }
    this.clearSlots();
  }

  prime(frame: number) {
    const target = frame | 0;
    this.resetHistory();
    this.lastFrame = target;
    const reusable = this.statePool.pop();
    this.setStateHistory(target, this.callbacks.saveState(reusable));
    this.setInputHistory(target, new Map());
    this.trimHistory(target);
  }

  pushLocalFrame(frame: number, inputs: FrameInputs) {
    this.setInputHistory(frame, inputs);
  }

  advanceTo(frame: number, inputs: FrameInputs) {
    this.setInputHistory(frame, inputs);
    this.callbacks.advanceFrame(inputs);
    this.lastFrame = frame;
    const reusable = this.getState(frame) ?? this.statePool.pop();
    this.setStateHistory(frame, this.callbacks.saveState(reusable));
    this.trimHistory(frame);
  }

  rollbackTo(frame: number) {
    const state = this.getState(frame);
    if (!state) {
      return false;
    }
    this.callbacks.loadState(state);
    this.lastFrame = frame;
    return true;
  }

  getState(frame: number) {
    if (frame < (this.lastFrame - this.maxRollbackFrames)) {
      return null;
    }
    const slot = this.slotForFrame(frame);
    if (this.stateFrames[slot] !== frame) {
      return null;
    }
    return this.stateSlots[slot] ?? null;
  }

  getInputs(frame: number) {
    if (frame < (this.lastFrame - this.maxRollbackFrames)) {
      return null;
    }
    const slot = this.slotForFrame(frame);
    if (this.inputFrames[slot] !== frame) {
      return null;
    }
    return this.inputSlots[slot] ?? null;
  }

  private trimHistory(frame: number) {
    const minFrame = frame - this.maxRollbackFrames;
    for (let i = 0; i < this.historySize; i += 1) {
      const stateFrame = this.stateFrames[i];
      if (stateFrame !== INVALID_FRAME && stateFrame < minFrame) {
        this.recycleState(this.stateSlots[i] ?? undefined);
        this.stateSlots[i] = null;
        this.stateFrames[i] = INVALID_FRAME;
      }
      const inputFrame = this.inputFrames[i];
      if (inputFrame !== INVALID_FRAME && inputFrame < minFrame) {
        this.inputSlots[i] = null;
        this.inputFrames[i] = INVALID_FRAME;
      }
    }
  }
}
