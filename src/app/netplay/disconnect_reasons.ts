import type { KickReasonCode } from '../../netcode_protocol.js';
import type { SignalCloseInfo } from '../../netplay.js';

export type LobbyDisconnectReasonCode =
  | 'manual_leave'
  | 'manual_close_host'
  | 'connect_timeout'
  | 'connect_failed'
  | 'host_peer_disconnect'
  | 'kick_removed_by_host'
  | 'kick_room_full'
  | 'kick_host_unavailable'
  | 'kick_client_inactivity_timeout'
  | 'signal_close_local'
  | 'signal_close_replaced'
  | 'signal_close_protocol_error'
  | 'signal_close_policy_violation'
  | 'signal_close_message_too_large'
  | 'signal_close_internal_error'
  | 'signal_close_abnormal'
  | 'signal_close_revoked_host_close'
  | 'signal_close_revoked_host_left'
  | 'signal_close_revoked_host_disconnect'
  | 'signal_close_revoked_room_expired'
  | 'signal_close_revoked_room_empty'
  | 'signal_close_revoked_host_missing'
  | 'signal_close_revoked_host_inactive'
  | 'signal_close_revoked_player_kicked'
  | 'signal_close_revoked_player_left'
  | 'signal_close_revoked_player_stale'
  | 'signal_close_revoked_player_join_timeout'
  | 'signal_close_revoked_room_cleanup'
  | 'signal_close_unknown'
  | 'heartbeat_room_not_found'
  | 'heartbeat_unauthorized'
  | 'leave_room_not_found'
  | 'leave_unauthorized'
  | 'close_room_not_found'
  | 'close_unauthorized'
  | 'unknown';

export type LobbyDisconnectReason = {
  code: LobbyDisconnectReasonCode;
  detail?: string;
};

const SIGNAL_CLOSE_REASON_PREFIX = 'wmb:';

const REASON_LABELS: Record<LobbyDisconnectReasonCode, string> = {
  manual_leave: 'left the lobby',
  manual_close_host: 'host closed the lobby',
  connect_timeout: 'connection attempt timed out',
  connect_failed: 'connection attempt failed',
  host_peer_disconnect: 'host peer connection closed',
  kick_removed_by_host: 'removed by host',
  kick_room_full: 'removed: room is full',
  kick_host_unavailable: 'removed: host unavailable',
  kick_client_inactivity_timeout: 'removed: inactivity timeout',
  signal_close_local: 'signal socket closed locally',
  signal_close_replaced: 'signal session replaced',
  signal_close_protocol_error: 'signal closed due protocol/payload error',
  signal_close_policy_violation: 'signal closed due policy violation',
  signal_close_message_too_large: 'signal closed due oversized message',
  signal_close_internal_error: 'signal closed due server internal error',
  signal_close_abnormal: 'signal socket closed abnormally',
  signal_close_revoked_host_close: 'room closed by host',
  signal_close_revoked_host_left: 'host left room',
  signal_close_revoked_host_disconnect: 'host signal disconnected',
  signal_close_revoked_room_expired: 'room expired',
  signal_close_revoked_room_empty: 'room closed because empty',
  signal_close_revoked_host_missing: 'room closed: host missing',
  signal_close_revoked_host_inactive: 'room closed: host inactive',
  signal_close_revoked_player_kicked: 'kicked by host',
  signal_close_revoked_player_left: 'removed after leaving room',
  signal_close_revoked_player_stale: 'removed: player stale',
  signal_close_revoked_player_join_timeout: 'removed: join handshake timeout',
  signal_close_revoked_room_cleanup: 'room cleanup revocation',
  signal_close_unknown: 'signal socket closed',
  heartbeat_room_not_found: 'heartbeat failed: room not found',
  heartbeat_unauthorized: 'heartbeat failed: unauthorized token',
  leave_room_not_found: 'leave failed: room not found',
  leave_unauthorized: 'leave failed: unauthorized token',
  close_room_not_found: 'close failed: room not found',
  close_unauthorized: 'close failed: unauthorized token',
  unknown: 'disconnected (unknown path)',
};

const KICK_CODE_MAP: Record<KickReasonCode, LobbyDisconnectReasonCode> = {
  kick_removed_by_host: 'kick_removed_by_host',
  kick_room_full: 'kick_room_full',
  kick_host_unavailable: 'kick_host_unavailable',
  kick_client_inactivity_timeout: 'kick_client_inactivity_timeout',
};

const SIGNAL_REVOKE_MAP: Record<string, LobbyDisconnectReasonCode> = {
  host_close: 'signal_close_revoked_host_close',
  host_left: 'signal_close_revoked_host_left',
  host_disconnect: 'signal_close_revoked_host_disconnect',
  room_expired: 'signal_close_revoked_room_expired',
  room_empty: 'signal_close_revoked_room_empty',
  host_missing: 'signal_close_revoked_host_missing',
  host_inactive: 'signal_close_revoked_host_inactive',
  player_kicked: 'signal_close_revoked_player_kicked',
  player_left: 'signal_close_revoked_player_left',
  player_stale: 'signal_close_revoked_player_stale',
  player_join_timeout: 'signal_close_revoked_player_join_timeout',
  room_cleanup: 'signal_close_revoked_room_cleanup',
};

export function formatLobbyDisconnectStatus(reason: LobbyDisconnectReason): string {
  const label = REASON_LABELS[reason.code] ?? REASON_LABELS.unknown;
  const detail = reason.detail?.trim();
  if (detail) {
    return `Lobby: ${label} [${reason.code}] (${detail})`;
  }
  return `Lobby: ${label} [${reason.code}]`;
}

function buildSignalCloseDetail(info: SignalCloseInfo): string {
  const reason = info.reason?.trim() ? info.reason.trim() : 'none';
  return `ws_code=${info.code}, ws_reason=${reason}, clean=${info.wasClean ? '1' : '0'}`;
}

export function resolveKickDisconnectReason(
  reasonCode?: KickReasonCode,
  reason?: string,
): LobbyDisconnectReason {
  const detail = reason?.trim() || undefined;
  let mapped = reasonCode ? KICK_CODE_MAP[reasonCode] : undefined;
  if (!mapped && detail) {
    const lower = detail.toLowerCase();
    if (lower.includes('room is full')) {
      mapped = 'kick_room_full';
    } else if (lower.includes('host unavailable')) {
      mapped = 'kick_host_unavailable';
    } else if (lower.includes('timed out')) {
      mapped = 'kick_client_inactivity_timeout';
    } else if (lower.includes('removed by host')) {
      mapped = 'kick_removed_by_host';
    }
  }
  return {
    code: mapped ?? 'unknown',
    detail,
  };
}

export function resolveSignalCloseDisconnectReason(info: SignalCloseInfo): LobbyDisconnectReason {
  const detail = buildSignalCloseDetail(info);
  if (info.byClient) {
    return { code: 'signal_close_local', detail };
  }
  const rawReason = info.reason?.trim() ?? '';
  if (rawReason === 'Replaced') {
    return { code: 'signal_close_replaced', detail };
  }
  if (rawReason.startsWith(SIGNAL_CLOSE_REASON_PREFIX)) {
    const token = rawReason.slice(SIGNAL_CLOSE_REASON_PREFIX.length).trim();
    return {
      code: SIGNAL_REVOKE_MAP[token] ?? 'signal_close_revoked_room_cleanup',
      detail,
    };
  }
  switch (info.code) {
    case 1002:
    case 1003:
      return { code: 'signal_close_protocol_error', detail };
    case 1008:
      return { code: 'signal_close_policy_violation', detail };
    case 1009:
      return { code: 'signal_close_message_too_large', detail };
    case 1011:
      return { code: 'signal_close_internal_error', detail };
    case 4001:
      return { code: 'signal_close_revoked_room_cleanup', detail };
    case 1006:
      return { code: 'signal_close_abnormal', detail };
    default:
      return { code: 'signal_close_unknown', detail };
  }
}

export function resolveHeartbeatDisconnectReason(errorCode: string): LobbyDisconnectReason | null {
  if (errorCode === 'room_not_found') {
    return { code: 'heartbeat_room_not_found' };
  }
  if (errorCode === 'unauthorized') {
    return { code: 'heartbeat_unauthorized' };
  }
  return null;
}

export function resolveLeaveApiErrorDisconnectReason(errorCode: string, wasHost: boolean): LobbyDisconnectReason | null {
  if (errorCode === 'room_not_found') {
    return { code: wasHost ? 'close_room_not_found' : 'leave_room_not_found' };
  }
  if (errorCode === 'unauthorized') {
    return { code: wasHost ? 'close_unauthorized' : 'leave_unauthorized' };
  }
  return null;
}
