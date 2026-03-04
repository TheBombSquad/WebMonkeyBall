import type {
  ClientToHostMessage,
  FrameBundleMessage,
  HostToClientMessage,
  InputFrameMessage,
  RoomInfo,
  RoomMeta,
  RoomSettings,
} from './netcode_protocol.js';
import type { QuantizedInput } from './determinism.js';

export type SignalMessage = {
  type: 'signal';
  from: number;
  to: number | null;
  payload: any;
};

export type SignalCloseInfo = {
  code: number;
  reason: string;
  wasClean: boolean;
  byClient: boolean;
};

export type RoomJoinResult = {
  room: RoomInfo;
  playerId: number;
  playerToken: string;
  hostToken?: string;
};

const DEFAULT_STUN = [{ urls: 'stun:stun.l.google.com:19302' }];
const FAST_MESSAGE_TYPES = new Set(['frame', 'input', 'ack', 'ping', 'pong']);
const FAST_LEGACY_CHANNEL_LABEL = 'fast';
const FAST_C2S_CHANNEL_LABEL = 'fast_c2s';
const FAST_S2C_CHANNEL_LABEL = 'fast_s2c';
const FAST_CHANNEL_MAX_BUFFERED = 256 * 1024;
const CTRL_CHANNEL_MAX_BUFFERED = 1024 * 1024;
const SIGNAL_PROTOCOL = 'wmb.v1';
const SIGNAL_AUTH_PROTOCOL_PREFIX = 'auth.';
const CLIENT_SIGNAL_MAX_MESSAGE_BYTES = 256 * 1024;
const CLIENT_SIGNAL_RATE_WINDOW_MS = 1000;
const CLIENT_SIGNAL_RATE_MAX_MESSAGES = 180;
const CLIENT_SIGNAL_RATE_MAX_BYTES = 512 * 1024;
const HOST_SIGNAL_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const HOST_SIGNAL_RATE_WINDOW_MS = 1000;
const HOST_SIGNAL_RATE_MAX_MESSAGES = 240;
const HOST_SIGNAL_RATE_MAX_BYTES = 4 * 1024 * 1024;
const BINARY_PACKET_INPUT_BATCH = 1;
const BINARY_PACKET_FRAME_BATCH = 2;
const CLIENT_TO_HOST_TYPES = new Set([
  'input',
  'ack',
  'ping',
  'stage_ready',
  'snapshot_request',
  'player_join',
  'player_leave',
  'player_profile',
  'chat',
]);
const HOST_TO_CLIENT_TYPES = new Set([
  'input',
  'ack',
  'pong',
  'stage_sync',
  'frame',
  'hash_probe',
  'snapshot',
  'start',
  'player_join',
  'player_leave',
  'room_update',
  'player_profile',
  'chat',
  'kick',
  'match_end',
]);
const utf8Encoder = new TextEncoder();

type InputBatchEntry = {
  frame: number;
  input: QuantizedInput;
};

type FramePlayerInputEntry = {
  playerId: number;
  input: QuantizedInput;
};

type DecodedInputBatch = {
  stageSeq: number;
  lastAck: number;
  entries: InputBatchEntry[];
};

type IngressWindow = {
  windowStart: number;
  windowCount: number;
  windowBytes: number;
};

type BandwidthStats = {
  upBps: number;
  downBps: number;
  upTotalBytes: number;
  downTotalBytes: number;
};

type HostPeerBandwidthStats = BandwidthStats & {
  playerId: number;
};

type HostBandwidthStats = BandwidthStats & {
  peers: HostPeerBandwidthStats[];
};

type ByteSample = {
  timeMs: number;
  bytes: number;
};

const BANDWIDTH_WINDOW_MS = 1000;
const BANDWIDTH_COALESCE_MS = 5;

class RollingBandwidthTracker {
  private upSamples: ByteSample[] = [];
  private downSamples: ByteSample[] = [];
  private upWindowBytes = 0;
  private downWindowBytes = 0;
  private upTotalBytes = 0;
  private downTotalBytes = 0;

  private prune(nowMs: number) {
    const cutoff = nowMs - BANDWIDTH_WINDOW_MS;
    while (this.upSamples.length > 0 && this.upSamples[0].timeMs < cutoff) {
      this.upWindowBytes -= this.upSamples[0].bytes;
      this.upSamples.shift();
    }
    while (this.downSamples.length > 0 && this.downSamples[0].timeMs < cutoff) {
      this.downWindowBytes -= this.downSamples[0].bytes;
      this.downSamples.shift();
    }
  }

  private pushSample(samples: ByteSample[], nowMs: number, bytes: number) {
    const last = samples[samples.length - 1];
    if (last && (nowMs - last.timeMs) <= BANDWIDTH_COALESCE_MS) {
      last.bytes += bytes;
      return;
    }
    samples.push({ timeMs: nowMs, bytes });
  }

  private record(direction: 'up' | 'down', bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return;
    }
    const nowMs = performance.now();
    this.prune(nowMs);
    if (direction === 'up') {
      this.pushSample(this.upSamples, nowMs, bytes);
      this.upWindowBytes += bytes;
      this.upTotalBytes += bytes;
      return;
    }
    this.pushSample(this.downSamples, nowMs, bytes);
    this.downWindowBytes += bytes;
    this.downTotalBytes += bytes;
  }

  recordUp(bytes: number) {
    this.record('up', bytes);
  }

  recordDown(bytes: number) {
    this.record('down', bytes);
  }

  snapshot(): BandwidthStats {
    this.prune(performance.now());
    return {
      upBps: this.upWindowBytes,
      downBps: this.downWindowBytes,
      upTotalBytes: this.upTotalBytes,
      downTotalBytes: this.downTotalBytes,
    };
  }

  reset() {
    this.upSamples = [];
    this.downSamples = [];
    this.upWindowBytes = 0;
    this.downWindowBytes = 0;
    this.upTotalBytes = 0;
    this.downTotalBytes = 0;
  }
}

function clampI8(value: number) {
  return Math.max(-127, Math.min(127, value | 0));
}

function asArrayBuffer(data: unknown) {
  if (data instanceof ArrayBuffer) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return null;
}

function payloadByteSize(payload: string | ArrayBuffer) {
  return typeof payload === 'string'
    ? utf8Encoder.encode(payload).byteLength
    : payload.byteLength;
}

function encodeInputBatchPacket(stageSeq: number, lastAck: number, entries: InputBatchEntry[]) {
  const count = Math.min(0xffff, Math.max(0, entries.length | 0));
  const buffer = new ArrayBuffer(1 + 4 + 4 + 2 + (count * (4 + 1 + 1 + 4)));
  const view = new DataView(buffer);
  let offs = 0;
  view.setUint8(offs, BINARY_PACKET_INPUT_BATCH);
  offs += 1;
  view.setUint32(offs, stageSeq >>> 0, true);
  offs += 4;
  // Signed so -1 sentinel survives round-trip (no host frames acked yet).
  view.setInt32(offs, lastAck | 0, true);
  offs += 4;
  view.setUint16(offs, count, true);
  offs += 2;
  for (let i = 0; i < count; i += 1) {
    const entry = entries[i];
    view.setUint32(offs, entry.frame >>> 0, true);
    offs += 4;
    view.setInt8(offs, clampI8(entry.input.x));
    offs += 1;
    view.setInt8(offs, clampI8(entry.input.y));
    offs += 1;
    view.setInt32(offs, (entry.input.buttons ?? 0) | 0, true);
    offs += 4;
  }
  return buffer;
}

function decodeInputBatchPacket(data: ArrayBuffer): DecodedInputBatch | null {
  const view = new DataView(data);
  const headerBytes = 1 + 4 + 4 + 2;
  if (view.byteLength < headerBytes || view.getUint8(0) !== BINARY_PACKET_INPUT_BATCH) {
    return null;
  }
  let offs = 1;
  const stageSeq = view.getUint32(offs, true);
  offs += 4;
  const lastAck = view.getInt32(offs, true);
  offs += 4;
  const count = view.getUint16(offs, true);
  offs += 2;
  const expectedBytes = headerBytes + (count * (4 + 1 + 1 + 4));
  if (view.byteLength !== expectedBytes) {
    return null;
  }
  const entries: InputBatchEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const frame = view.getUint32(offs, true);
    offs += 4;
    const x = view.getInt8(offs);
    offs += 1;
    const y = view.getInt8(offs);
    offs += 1;
    const buttons = view.getInt32(offs, true);
    offs += 4;
    entries.push({ frame, input: { x, y, buttons } });
  }
  return { stageSeq, lastAck, entries };
}

function encodeFrameBatchPacket(lastAck: number, frames: FrameBundleMessage[]) {
  const count = Math.min(0xffff, Math.max(0, frames.length | 0));
  const stageSeq = count > 0 ? (frames[0].stageSeq >>> 0) : 0;
  let byteLength = 1 + 4 + 4 + 2;
  const frameInputs = new Array<{ frame: number; hash?: number; hashFrame?: number; inputs: FramePlayerInputEntry[] }>(count);
  for (let i = 0; i < count; i += 1) {
    const bundle = frames[i];
    const inputs: FramePlayerInputEntry[] = [];
    for (const [playerId, input] of Object.entries(bundle.inputs)) {
      inputs.push({
        playerId: Number(playerId) | 0,
        input: {
          x: clampI8(input.x),
          y: clampI8(input.y),
          buttons: (input.buttons ?? 0) | 0,
        },
      });
    }
    const hasHash = Number.isFinite(bundle.hashFrame) && Number.isFinite(bundle.hash);
    frameInputs[i] = {
      frame: bundle.frame >>> 0,
      hash: hasHash ? (bundle.hash! >>> 0) : undefined,
      hashFrame: hasHash ? (bundle.hashFrame! >>> 0) : undefined,
      inputs,
    };
    byteLength += 4 + 1 + 1;
    if (hasHash) {
      byteLength += 4 + 4;
    }
    byteLength += inputs.length * (4 + 1 + 1 + 4);
  }
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  let offs = 0;
  view.setUint8(offs, BINARY_PACKET_FRAME_BATCH);
  offs += 1;
  view.setUint32(offs, stageSeq, true);
  offs += 4;
  view.setInt32(offs, lastAck | 0, true);
  offs += 4;
  view.setUint16(offs, count, true);
  offs += 2;
  for (let i = 0; i < count; i += 1) {
    const frame = frameInputs[i];
    const hasHash = frame.hash !== undefined && frame.hashFrame !== undefined;
    const inputCount = Math.min(0xff, frame.inputs.length);
    view.setUint32(offs, frame.frame >>> 0, true);
    offs += 4;
    view.setUint8(offs, hasHash ? 1 : 0);
    offs += 1;
    view.setUint8(offs, inputCount);
    offs += 1;
    if (hasHash) {
      view.setUint32(offs, frame.hashFrame! >>> 0, true);
      offs += 4;
      view.setUint32(offs, frame.hash! >>> 0, true);
      offs += 4;
    }
    for (let j = 0; j < inputCount; j += 1) {
      const input = frame.inputs[j];
      view.setUint32(offs, input.playerId >>> 0, true);
      offs += 4;
      view.setInt8(offs, clampI8(input.input.x));
      offs += 1;
      view.setInt8(offs, clampI8(input.input.y));
      offs += 1;
      view.setInt32(offs, (input.input.buttons ?? 0) | 0, true);
      offs += 4;
    }
  }
  return buffer;
}

function decodeFrameBatchPacket(data: ArrayBuffer): FrameBundleMessage[] | null {
  const view = new DataView(data);
  const headerBytes = 1 + 4 + 4 + 2;
  if (view.byteLength < headerBytes || view.getUint8(0) !== BINARY_PACKET_FRAME_BATCH) {
    return null;
  }
  let offs = 1;
  const stageSeq = view.getUint32(offs, true);
  offs += 4;
  const lastAck = view.getInt32(offs, true);
  offs += 4;
  const count = view.getUint16(offs, true);
  offs += 2;
  const frames: FrameBundleMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    if ((offs + 6) > view.byteLength) {
      return null;
    }
    const frame = view.getUint32(offs, true);
    offs += 4;
    const flags = view.getUint8(offs);
    offs += 1;
    const inputCount = view.getUint8(offs);
    offs += 1;
    let hashFrame: number | undefined;
    let hash: number | undefined;
    if ((flags & 1) !== 0) {
      if ((offs + 8) > view.byteLength) {
        return null;
      }
      hashFrame = view.getUint32(offs, true);
      offs += 4;
      hash = view.getUint32(offs, true);
      offs += 4;
    }
    const inputs: Record<number, QuantizedInput> = {};
    for (let j = 0; j < inputCount; j += 1) {
      if ((offs + 10) > view.byteLength) {
        return null;
      }
      const playerId = view.getUint32(offs, true);
      offs += 4;
      const x = view.getInt8(offs);
      offs += 1;
      const y = view.getInt8(offs);
      offs += 1;
      const buttons = view.getInt32(offs, true);
      offs += 4;
      inputs[playerId] = { x, y, buttons };
    }
    const msg: FrameBundleMessage = {
      type: 'frame',
      stageSeq,
      frame,
      inputs,
      lastAck,
    };
    if (hashFrame !== undefined && hash !== undefined) {
      msg.hashFrame = hashFrame;
      msg.hash = hash;
    }
    frames.push(msg);
  }
  if (offs !== view.byteLength) {
    return null;
  }
  return frames;
}

function isFastMessage(msg: { type: string }) {
  return FAST_MESSAGE_TYPES.has(msg.type);
}

function updateIngressWindow(
  window: IngressWindow,
  now: number,
  size: number,
  windowMs: number,
  maxMessages: number,
  maxBytes: number,
) {
  if ((now - window.windowStart) >= windowMs) {
    window.windowStart = now;
    window.windowCount = 0;
    window.windowBytes = 0;
  }
  window.windowCount += 1;
  window.windowBytes += size;
  if (window.windowCount > maxMessages || window.windowBytes > maxBytes) {
    return false;
  }
  return true;
}

type ChannelRole = 'ctrl' | 'fastLegacy' | 'fastC2S' | 'fastS2C';

function getChannelRole(label: string): ChannelRole {
  if (label === FAST_C2S_CHANNEL_LABEL) {
    return 'fastC2S';
  }
  if (label === FAST_S2C_CHANNEL_LABEL) {
    return 'fastS2C';
  }
  if (label === FAST_LEGACY_CHANNEL_LABEL) {
    return 'fastLegacy';
  }
  return 'ctrl';
}

function getChannelBufferedLimit(channel: RTCDataChannel) {
  return getChannelRole(channel.label) === 'ctrl' ? CTRL_CHANNEL_MAX_BUFFERED : FAST_CHANNEL_MAX_BUFFERED;
}

function isChannelWritable(channel: RTCDataChannel | null | undefined) {
  if (!channel || channel.readyState !== 'open') {
    return false;
  }
  return channel.bufferedAmount <= getChannelBufferedLimit(channel);
}

function readApiErrorCode(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== 'string' || !error) {
    return null;
  }
  return error;
}

async function parseApiJson<T>(res: Response): Promise<T | null> {
  try {
    return await res.json() as T;
  } catch {
    return null;
  }
}

async function assertApiSuccess(res: Response, fallbackCode: string): Promise<any> {
  const data = await parseApiJson<any>(res);
  if (!res.ok) {
    throw new Error(readApiErrorCode(data) ?? `${fallbackCode}_${res.status}`);
  }
  if (data && typeof data === 'object' && data.ok === false) {
    throw new Error(readApiErrorCode(data) ?? fallbackCode);
  }
  return data ?? {};
}

export class LobbyClient {
  constructor(private baseUrl: string) {}

  async listRooms(): Promise<RoomInfo[]> {
    const res = await fetch(`${this.baseUrl}/rooms`);
    const data = await assertApiSuccess(res, 'list_rooms');
    return data.rooms ?? [];
  }

  async createRoom(room: Partial<RoomInfo>): Promise<RoomJoinResult> {
    const res = await fetch(`${this.baseUrl}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(room),
    });
    const data = await assertApiSuccess(res, 'create_room');
    return {
      room: data.room,
      playerId: data.playerId,
      playerToken: data.playerToken,
      hostToken: data.hostToken,
    };
  }

  async joinRoom(roomIdOrCode: {
    roomId?: string;
    roomCode?: string;
    playerId?: number;
    token?: string;
  }): Promise<RoomJoinResult> {
    const res = await fetch(`${this.baseUrl}/rooms/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(roomIdOrCode),
    });
    const data = await assertApiSuccess(res, 'join_room');
    return {
      room: data.room,
      playerId: data.playerId,
      playerToken: data.playerToken,
      hostToken: data.hostToken,
    };
  }

  async heartbeat(
    roomId: string,
    playerId: number,
    token: string,
    meta?: RoomMeta,
    settings?: RoomSettings,
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rooms/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, playerId, token, meta, settings }),
    });
    await assertApiSuccess(res, 'heartbeat');
  }

  async closeRoom(roomId: string, hostToken: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rooms/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, hostToken }),
    });
    await assertApiSuccess(res, 'close_room');
  }

  async leaveRoom(roomId: string, playerId: number, token: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rooms/leave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, playerId, token }),
    });
    await assertApiSuccess(res, 'leave_room');
  }

  async kickPlayer(roomId: string, hostToken: string, playerId: number): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rooms/kick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, hostToken, playerId }),
    });
    await assertApiSuccess(res, 'kick_player');
  }

  openSignal(
    roomId: string,
    playerId: number,
    token: string,
    onMessage: (msg: SignalMessage) => void,
    onClose: (info: SignalCloseInfo) => void,
  ) {
    const ws = new WebSocket(
      `${this.baseUrl.replace('http', 'ws')}/room/${roomId}?playerId=${playerId}`,
      [SIGNAL_PROTOCOL, `${SIGNAL_AUTH_PROTOCOL_PREFIX}${token}`],
    );
    const pending: SignalMessage[] = [];
    let closedByClient = false;
    ws.addEventListener('open', () => {
      while (pending.length > 0) {
        const msg = pending.shift();
        if (msg) {
          ws.send(JSON.stringify(msg));
        }
      }
    });
    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data) as Partial<SignalMessage>;
        if (msg?.type !== 'signal' || !msg.payload || typeof msg.payload !== 'object') {
          return;
        }
        const from = Number(msg.from);
        const toRaw = msg.to;
        const to = toRaw === null ? null : Number(toRaw);
        if (!Number.isFinite(from) || from <= 0) {
          return;
        }
        if (to !== null && (!Number.isFinite(to) || to <= 0)) {
          return;
        }
        onMessage({
          type: 'signal',
          from: Math.trunc(from),
          to: to === null ? null : Math.trunc(to),
          payload: msg.payload,
        });
      } catch {
        // Ignore malformed.
      }
    });
    ws.addEventListener('close', (event) => {
      onClose({
        code: event.code,
        reason: event.reason ?? '',
        wasClean: event.wasClean,
        byClient: closedByClient,
      });
    });
    return {
      send: (msg: SignalMessage) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        } else if (ws.readyState === WebSocket.CONNECTING) {
          pending.push(msg);
        }
      },
      close: () => {
        closedByClient = true;
        ws.close(1000, 'ClientClosed');
      },
    };
  }

}

export class HostRelay {
  private peers = new Map<number, RTCPeerConnection>();
  private channels = new Map<number, {
    ctrl?: RTCDataChannel;
    fastLegacy?: RTCDataChannel;
    fastC2S?: RTCDataChannel;
    fastS2C?: RTCDataChannel;
  }>();
  private connected = new Set<number>();
  private pendingIce = new Map<number, RTCIceCandidateInit[]>();
  private ingressWindows = new Map<number, IngressWindow>();
  private traffic = new RollingBandwidthTracker();
  private peerTraffic = new Map<number, RollingBandwidthTracker>();
  private disconnecting = new Set<number>();

  constructor(private onMessage: (playerId: number, msg: ClientToHostMessage) => void) {}

  private getPeerTraffic(playerId: number) {
    let tracker = this.peerTraffic.get(playerId);
    if (!tracker) {
      tracker = new RollingBandwidthTracker();
      this.peerTraffic.set(playerId, tracker);
    }
    return tracker;
  }

  private recordInbound(playerId: number, bytes: number) {
    this.traffic.recordDown(bytes);
    this.getPeerTraffic(playerId).recordDown(bytes);
  }

  private recordOutbound(playerId: number, bytes: number) {
    this.traffic.recordUp(bytes);
    this.getPeerTraffic(playerId).recordUp(bytes);
  }

  private shouldAcceptIngress(playerId: number, size: number) {
    const now = performance.now();
    const window = this.ingressWindows.get(playerId) ?? {
      windowStart: now,
      windowCount: 0,
      windowBytes: 0,
    };
    const accepted = updateIngressWindow(
      window,
      now,
      size,
      CLIENT_SIGNAL_RATE_WINDOW_MS,
      CLIENT_SIGNAL_RATE_MAX_MESSAGES,
      CLIENT_SIGNAL_RATE_MAX_BYTES,
    );
    this.ingressWindows.set(playerId, window);
    return accepted;
  }

  getPeer(playerId: number): RTCPeerConnection {
    const existing = this.peers.get(playerId);
    if (existing) {
      return existing;
    }
    const pc = new RTCPeerConnection({ iceServers: DEFAULT_STUN });
    pc.addEventListener('icecandidate', (ev) => {
      if (ev.candidate) {
        this.onSignal?.({ type: 'signal', from: this.hostId, to: playerId, payload: { ice: ev.candidate } });
      }
    });
    pc.addEventListener('datachannel', (ev) => {
      this.attachChannel(playerId, ev.channel);
    });
    this.peers.set(playerId, pc);
    return pc;
  }

  attachChannel(playerId: number, channel: RTCDataChannel) {
    const role = getChannelRole(channel.label);
    const entry = this.channels.get(playerId) ?? {};
    if (role === 'ctrl') {
      entry.ctrl = channel;
    } else if (role === 'fastLegacy') {
      entry.fastLegacy = channel;
    } else if (role === 'fastC2S') {
      entry.fastC2S = channel;
    } else {
      entry.fastS2C = channel;
    }
    this.channels.set(playerId, entry);
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('open', () => {
      if (role === 'ctrl' && !this.connected.has(playerId)) {
        this.connected.add(playerId);
        this.onConnect?.(playerId);
      }
    });
    channel.addEventListener('message', (event) => {
      const binary = asArrayBuffer(event.data);
      if (binary) {
        if (role !== 'ctrl' && !this.connected.has(playerId)) {
          return;
        }
        if (role === 'ctrl' || role === 'fastS2C') {
          return;
        }
        const size = binary.byteLength;
        this.recordInbound(playerId, size);
        if (size > CLIENT_SIGNAL_MAX_MESSAGE_BYTES || !this.shouldAcceptIngress(playerId, size)) {
          this.disconnect(playerId);
          return;
        }
        const packet = decodeInputBatchPacket(binary);
        if (!packet) {
          return;
        }
        for (const entry of packet.entries) {
          const msg: InputFrameMessage = {
            type: 'input',
            stageSeq: packet.stageSeq,
            frame: entry.frame,
            playerId,
            input: entry.input,
            lastAck: packet.lastAck,
          };
          this.onMessage(playerId, msg);
        }
        return;
      }
      if (typeof event.data !== 'string') {
        return;
      }
      if (role !== 'ctrl' && !this.connected.has(playerId)) {
        return;
      }
      if (role === 'fastS2C') {
        return;
      }
      const size = utf8Encoder.encode(event.data).byteLength;
      this.recordInbound(playerId, size);
      if (size > CLIENT_SIGNAL_MAX_MESSAGE_BYTES || !this.shouldAcceptIngress(playerId, size)) {
        this.disconnect(playerId);
        return;
      }
      try {
        const msg = JSON.parse(event.data) as ClientToHostMessage;
        if (
          msg
          && typeof msg === 'object'
          && typeof (msg as { type?: unknown }).type === 'string'
          && CLIENT_TO_HOST_TYPES.has((msg as { type: string }).type)
        ) {
          this.onMessage(playerId, msg);
        }
      } catch {
        // Ignore malformed.
      }
    });
    channel.addEventListener('close', () => {
      const current = this.channels.get(playerId);
      const active = role === 'ctrl'
        ? current?.ctrl
        : role === 'fastLegacy'
          ? current?.fastLegacy
          : role === 'fastC2S'
            ? current?.fastC2S
            : current?.fastS2C;
      if (active !== channel) {
        return;
      }
      const ctrl = current?.ctrl;
      if (role === 'ctrl' || !ctrl || ctrl.readyState === 'closed' || ctrl.readyState === 'closing') {
        this.disconnect(playerId);
      }
    });
  }

  private pickChannel(playerId: number, preferFast: boolean, allowFastFallbackToCtrl = true) {
    const entry = this.channels.get(playerId);
    if (!entry) {
      return null;
    }
    const primary = preferFast
      ? (entry.fastS2C ?? entry.fastLegacy)
      : entry.ctrl;
    const fallback = preferFast
      ? (allowFastFallbackToCtrl ? entry.ctrl : null)
      : (entry.fastS2C ?? entry.fastLegacy ?? entry.fastC2S);
    if (isChannelWritable(primary)) {
      return primary;
    }
    if (isChannelWritable(fallback)) {
      return fallback;
    }
    return null;
  }

  private sendPayload(
    playerId: number,
    payload: string | ArrayBuffer,
    preferFast: boolean,
    allowFastFallbackToCtrl = true,
  ) {
    const channel = this.pickChannel(playerId, preferFast, allowFastFallbackToCtrl);
    if (!channel) {
      return false;
    }
    const size = payloadByteSize(payload);
    try {
      channel.send(payload);
      this.recordOutbound(playerId, size);
      return true;
    } catch {
      this.disconnect(playerId);
      return false;
    }
  }

  broadcast(msg: HostToClientMessage) {
    const payload = JSON.stringify(msg);
    const preferFast = isFastMessage(msg);
    for (const playerId of this.channels.keys()) {
      this.sendPayload(playerId, payload, preferFast);
    }
  }

  getChannelStates() {
    const states: Array<{ playerId: number; readyState: string }> = [];
    for (const [playerId, entry] of this.channels.entries()) {
      const ctrl = entry.ctrl?.readyState ?? 'none';
      const fastC2S = entry.fastC2S?.readyState ?? 'none';
      const fastS2C = entry.fastS2C?.readyState ?? 'none';
      const fastLegacy = entry.fastLegacy?.readyState ?? 'none';
      states.push({ playerId, readyState: `ctrl=${ctrl} c2s=${fastC2S} s2c=${fastS2C} fast=${fastLegacy}` });
    }
    return states;
  }

  getBandwidthStats(): HostBandwidthStats {
    const totals = this.traffic.snapshot();
    const peers = Array.from(this.peerTraffic.entries())
      .map(([playerId, tracker]) => ({ playerId, ...tracker.snapshot() }))
      .sort((a, b) => a.playerId - b.playerId);
    return {
      ...totals,
      peers,
    };
  }

  sendTo(playerId: number, msg: HostToClientMessage) {
    return this.sendPayload(playerId, JSON.stringify(msg), isFastMessage(msg));
  }

  sendFrameBatch(playerId: number, lastAck: number, frames: FrameBundleMessage[]) {
    if (frames.length <= 0) {
      return;
    }
    this.sendPayload(playerId, encodeFrameBatchPacket(lastAck, frames), true, false);
  }

  closeAll() {
    for (const entry of this.channels.values()) {
      for (const channel of [entry.ctrl, entry.fastLegacy, entry.fastC2S, entry.fastS2C]) {
        if (!channel) {
          continue;
        }
        try {
          channel.close();
        } catch {
          // Ignore.
        }
      }
    }
    for (const peer of this.peers.values()) {
      try {
        peer.close();
      } catch {
        // Ignore.
      }
    }
    this.channels.clear();
    this.peers.clear();
    this.connected.clear();
    this.pendingIce.clear();
    this.ingressWindows.clear();
    this.traffic.reset();
    this.peerTraffic.clear();
    this.disconnecting.clear();
  }

  disconnect(playerId: number) {
    if (this.disconnecting.has(playerId)) {
      return;
    }
    this.disconnecting.add(playerId);
    const entry = this.channels.get(playerId);
    try {
      if (entry) {
        for (const channel of [entry.ctrl, entry.fastLegacy, entry.fastC2S, entry.fastS2C]) {
          if (!channel) {
            continue;
          }
          try {
            channel.close();
          } catch {
            // Ignore.
          }
        }
      }
      const peer = this.peers.get(playerId);
      if (peer) {
        try {
          peer.close();
        } catch {
          // Ignore.
        }
      }
      this.channels.delete(playerId);
      this.peers.delete(playerId);
      this.pendingIce.delete(playerId);
      this.ingressWindows.delete(playerId);
      this.peerTraffic.delete(playerId);
      if (this.connected.has(playerId)) {
        this.connected.delete(playerId);
        this.onDisconnect?.(playerId);
      }
    } finally {
      this.disconnecting.delete(playerId);
    }
  }

  queueIceCandidate(playerId: number, candidate: RTCIceCandidateInit) {
    const pending = this.pendingIce.get(playerId) ?? [];
    pending.push(candidate);
    this.pendingIce.set(playerId, pending);
  }

  drainIceCandidates(playerId: number) {
    const pending = this.pendingIce.get(playerId) ?? [];
    this.pendingIce.delete(playerId);
    return pending;
  }

  hostId = 0;
  onSignal?: (msg: SignalMessage) => void;
  onConnect?: (playerId: number) => void;
  onDisconnect?: (playerId: number) => void;
}

export class ClientPeer {
  private pc: RTCPeerConnection | null = null;
  private ctrlChannel: RTCDataChannel | null = null;
  private fastLegacyChannel: RTCDataChannel | null = null;
  private fastC2SChannel: RTCDataChannel | null = null;
  private fastS2CChannel: RTCDataChannel | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private ingressWindow: IngressWindow = {
    windowStart: performance.now(),
    windowCount: 0,
    windowBytes: 0,
  };
  private traffic = new RollingBandwidthTracker();

  constructor(private onMessage: (msg: HostToClientMessage) => void) {}

  private shouldAcceptIngress(size: number) {
    return updateIngressWindow(
      this.ingressWindow,
      performance.now(),
      size,
      HOST_SIGNAL_RATE_WINDOW_MS,
      HOST_SIGNAL_RATE_MAX_MESSAGES,
      HOST_SIGNAL_RATE_MAX_BYTES,
    );
  }

  private getPeerStateSummary() {
    const pcState = this.pc?.connectionState ?? 'none';
    const iceState = this.pc?.iceConnectionState ?? 'none';
    const signalingState = this.pc?.signalingState ?? 'none';
    return `pc=${pcState} ice=${iceState} sig=${signalingState} ${this.getChannelState()}`;
  }

  private buildDisconnectDetail(source: string) {
    return `source=${source} ${this.getPeerStateSummary()}`;
  }

  private attachChannel(channel: RTCDataChannel) {
    const role = getChannelRole(channel.label);
    if (role === 'ctrl') {
      this.ctrlChannel = channel;
    } else if (role === 'fastLegacy') {
      this.fastLegacyChannel = channel;
    } else if (role === 'fastC2S') {
      this.fastC2SChannel = channel;
    } else {
      this.fastS2CChannel = channel;
    }
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('open', () => {
      if (role === 'ctrl') {
        this.onConnect?.();
      }
    });
    channel.addEventListener('message', (event) => {
      const binary = asArrayBuffer(event.data);
      if (binary) {
        if (role === 'ctrl' || role === 'fastC2S') {
          return;
        }
        const size = binary.byteLength;
        this.traffic.recordDown(size);
        if (size > HOST_SIGNAL_MAX_MESSAGE_BYTES || !this.shouldAcceptIngress(size)) {
          this.close();
          return;
        }
        const frames = decodeFrameBatchPacket(binary);
        if (!frames) {
          return;
        }
        for (const frame of frames) {
          this.onMessage(frame);
        }
        return;
      }
      if (typeof event.data !== 'string') {
        return;
      }
      if (role === 'fastC2S') {
        return;
      }
      const size = utf8Encoder.encode(event.data).byteLength;
      this.traffic.recordDown(size);
      if (size > HOST_SIGNAL_MAX_MESSAGE_BYTES || !this.shouldAcceptIngress(size)) {
        this.close();
        return;
      }
      try {
        const msg = JSON.parse(event.data) as HostToClientMessage;
        if (
          msg
          && typeof msg === 'object'
          && typeof (msg as { type?: unknown }).type === 'string'
          && HOST_TO_CLIENT_TYPES.has((msg as { type: string }).type)
        ) {
          this.onMessage(msg);
        }
      } catch {
        // Ignore malformed.
      }
    });
    channel.addEventListener('close', () => {
      const active = role === 'ctrl'
        ? this.ctrlChannel
        : role === 'fastLegacy'
          ? this.fastLegacyChannel
          : role === 'fastC2S'
            ? this.fastC2SChannel
            : this.fastS2CChannel;
      if (active !== channel) {
        return;
      }
      if (role === 'ctrl') {
        this.onDisconnect?.(this.buildDisconnectDetail('ctrl_channel_close'));
      }
    });
  }

  async createConnection(): Promise<RTCPeerConnection> {
    const pc = new RTCPeerConnection({ iceServers: DEFAULT_STUN });
    pc.addEventListener('icecandidate', (ev) => {
      if (ev.candidate) {
        this.onSignal?.({ type: 'signal', from: this.playerId, to: this.hostId, payload: { ice: ev.candidate } });
      }
    });
    pc.addEventListener('datachannel', (ev) => {
      this.attachChannel(ev.channel);
    });
    this.pc = pc;
    return pc;
  }

  private sendPayload(payload: string | ArrayBuffer, preferFast: boolean, allowFastFallbackToCtrl = true) {
    const primary = preferFast
      ? (this.fastC2SChannel ?? this.fastLegacyChannel)
      : this.ctrlChannel;
    const fallback = preferFast
      ? (allowFastFallbackToCtrl ? this.ctrlChannel : null)
      : (this.fastC2SChannel ?? this.fastLegacyChannel ?? this.fastS2CChannel);
    const size = payloadByteSize(payload);
    if (isChannelWritable(primary)) {
      try {
        primary.send(payload);
        this.traffic.recordUp(size);
        return true;
      } catch {
        // Try fallback below.
      }
    }
    if (isChannelWritable(fallback)) {
      try {
        fallback.send(payload);
        this.traffic.recordUp(size);
        return true;
      } catch {
        // Ignore send failures from a stale/closing channel.
      }
    }
    return false;
  }

  send(msg: ClientToHostMessage) {
    return this.sendPayload(JSON.stringify(msg), isFastMessage(msg));
  }

  sendInputBatch(stageSeq: number, lastAck: number, entries: InputBatchEntry[]) {
    if (entries.length <= 0) {
      return;
    }
    this.sendPayload(encodeInputBatchPacket(stageSeq, lastAck, entries), true, false);
  }

  getChannelState(): string {
    const ctrl = this.ctrlChannel?.readyState ?? 'none';
    const c2s = this.fastC2SChannel?.readyState ?? 'none';
    const s2c = this.fastS2CChannel?.readyState ?? 'none';
    const fast = this.fastLegacyChannel?.readyState ?? 'none';
    return `ctrl=${ctrl} c2s=${c2s} s2c=${s2c} fast=${fast}`;
  }

  getBandwidthStats(): BandwidthStats {
    return this.traffic.snapshot();
  }

  close() {
    for (const channel of [this.ctrlChannel, this.fastLegacyChannel, this.fastC2SChannel, this.fastS2CChannel]) {
      if (!channel) {
        continue;
      }
      try {
        channel.close();
      } catch {
        // Ignore.
      }
    }
    try {
      this.pc?.close();
    } catch {
      // Ignore.
    }
    this.ctrlChannel = null;
    this.fastLegacyChannel = null;
    this.fastC2SChannel = null;
    this.fastS2CChannel = null;
    this.pc = null;
    this.pendingIce = [];
    this.ingressWindow = {
      windowStart: performance.now(),
      windowCount: 0,
      windowBytes: 0,
    };
    this.traffic.reset();
  }

  async handleSignal(payload: any) {
    if (!this.pc) {
      return;
    }
    if (payload?.sdp) {
      try {
        await this.pc.setRemoteDescription(payload.sdp);
      } catch {
        return;
      }
      if (this.pendingIce.length > 0) {
        const pending = this.pendingIce.splice(0, this.pendingIce.length);
        for (const candidate of pending) {
          try {
            await this.pc.addIceCandidate(candidate);
          } catch {
            // Ignore stale/invalid candidates.
          }
        }
      }
      if (payload.sdp.type === 'offer') {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.onSignal?.({ type: 'signal', from: this.playerId, to: this.hostId, payload: { sdp: this.pc.localDescription } });
      }
    } else if (payload?.ice) {
      const candidate = payload.ice as RTCIceCandidateInit;
      if (!this.pc.remoteDescription) {
        this.pendingIce.push(candidate);
        return;
      }
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {
        // Ignore stale/invalid candidates.
      }
    }
  }

  playerId = 0;
  hostId = 0;
  onSignal?: (msg: SignalMessage) => void;
  onDisconnect?: (detail?: string) => void;
  onConnect?: () => void;
}

export async function createHostOffer(host: HostRelay, playerId: number) {
  const pc = host.getPeer(playerId);
  const ctrl = pc.createDataChannel('ctrl');
  host.attachChannel(playerId, ctrl);
  // Godot's unreliable_ordered behaves closer to UDP + stale packet drop than strict
  // in-order delivery. `ordered:false` avoids WebRTC HOL stalls under loss.
  const fastC2S = pc.createDataChannel(FAST_C2S_CHANNEL_LABEL, { ordered: false, maxRetransmits: 0 });
  host.attachChannel(playerId, fastC2S);
  const fastS2C = pc.createDataChannel(FAST_S2C_CHANNEL_LABEL, { ordered: false, maxRetransmits: 0 });
  host.attachChannel(playerId, fastS2C);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  return pc.localDescription;
}

export async function applyHostSignal(host: HostRelay, playerId: number, payload: any) {
  const pc = host.getPeer(playerId);
  if (payload?.sdp) {
    try {
      await pc.setRemoteDescription(payload.sdp);
    } catch {
      return;
    }
    const pending = host.drainIceCandidates(playerId);
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // Ignore stale/invalid candidates.
      }
    }
    if (payload.sdp.type === 'answer') {
      return;
    }
  } else if (payload?.ice) {
    const candidate = payload.ice as RTCIceCandidateInit;
    if (!pc.remoteDescription) {
      host.queueIceCandidate(playerId, candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      // Ignore stale/invalid candidates.
    }
  }
}
