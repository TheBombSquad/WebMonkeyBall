import type { LobbyClient } from '../../netplay.js';
import type { MultiplayerGameMode } from '../../game.js';
import type { RoomInfo } from '../../netcode_protocol.js';

export type LobbyRoom = RoomInfo;

type LobbyBrowserDeps = {
  lobbyClient: LobbyClient | null;
  lobbyStatus: HTMLElement | null;
  lobbyList: HTMLElement | null;
  multiplayerOnlineCount: HTMLElement | null;
  lobbyPublicCheckbox: HTMLInputElement | null;
  lobbyCodeInput: HTMLInputElement | null;
  getLobbyRoom: () => LobbyRoom | null;
  setLobbyRoom: (room: LobbyRoom | null) => void;
  setLobbySelfId: (id: number | null) => void;
  getLobbySelfId: () => number | null;
  setLobbyPlayerToken: (token: string | null) => void;
  getLobbyPlayerToken: () => string | null;
  setLobbyHostToken: (token: string | null) => void;
  getLobbyHostToken: () => string | null;
  getNetplayRole: () => 'host' | 'client' | null;
  getLobbySelectedGameMode: () => MultiplayerGameMode;
  lobbyDefaultPlayers: number;
  chainedDefaultPlayers: number;
  getRoomGameMode: (room: RoomInfo | null | undefined) => MultiplayerGameMode;
  formatMultiplayerGameModeLabel: (mode: MultiplayerGameMode) => string;
  formatGameSourceLabel: (source: unknown) => string;
  getRoomDisplayName: (room: RoomInfo) => string;
  buildRoomMetaForCreation: () => any;
  destroySingleplayerForNetplay: () => void;
  startHost: (room: LobbyRoom, playerToken: string) => void;
  startClient: (room: LobbyRoom, playerId: number, playerToken: string) => Promise<void>;
  resetNetplayConnections: () => void;
  clearLobbySignalRetry: () => void;
  setLobbySignalShouldReconnect: (enabled: boolean) => void;
};

export class LobbyBrowserController {
  private readonly deps: LobbyBrowserDeps;

  constructor(deps: LobbyBrowserDeps) {
    this.deps = deps;
  }

  private getErrorCode(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    return '';
  }

  private shouldTeardownAfterLeaveError(errorCode: string): boolean {
    return errorCode === 'room_not_found' || errorCode === 'unauthorized';
  }

  private setJoinErrorStatus(lobbyStatus: HTMLElement, err: unknown) {
    const message = err instanceof Error ? err.message : '';
    if (message === 'room_locked') {
      lobbyStatus.textContent = 'Lobby: room is locked';
    } else if (message === 'room_full') {
      lobbyStatus.textContent = 'Lobby: room is full';
    } else {
      lobbyStatus.textContent = 'Lobby: join failed';
    }
  }

  private async cleanupFailedClientJoin(roomId: string, playerId: number, playerToken: string) {
    this.deps.setLobbySignalShouldReconnect(false);
    this.deps.clearLobbySignalRetry();
    this.deps.resetNetplayConnections();
    const lobbyClient = this.deps.lobbyClient;
    if (!lobbyClient) {
      return;
    }
    try {
      await lobbyClient.leaveRoom(roomId, playerId, playerToken);
    } catch {
      // Ignore backend leave failures after client connection setup failure.
    }
  }

  async refreshLobbyList() {
    const { lobbyClient, lobbyList, lobbyStatus, multiplayerOnlineCount } = this.deps;
    if (!lobbyClient || !lobbyList || !lobbyStatus) {
      return;
    }
    lobbyStatus.textContent = 'Lobby: loading...';
    try {
      const rooms = await lobbyClient.listRooms();
      lobbyList.innerHTML = '';
      const totalPlayers = rooms.reduce((sum, room) => sum + (room.playerCount ?? 0), 0);
      if (multiplayerOnlineCount) {
        multiplayerOnlineCount.textContent = `${totalPlayers} player${totalPlayers === 1 ? '' : 's'} online`;
      }
      for (const room of rooms) {
        const item = document.createElement('div');
        item.className = 'lobby-item';
        const info = document.createElement('div');
        info.className = 'lobby-item-main';
        const title = document.createElement('div');
        title.className = 'lobby-item-title';
        title.textContent = this.deps.getRoomDisplayName(room);
        const subtitle = document.createElement('div');
        subtitle.className = 'lobby-item-subtitle';
        const sourceLabel = this.deps.formatGameSourceLabel(room.meta?.gameSource);
        const courseLabel = room.meta?.courseLabel ?? room.courseId ?? 'Unknown';
        const stageLabel = room.meta?.stageLabel ? ` • ${room.meta.stageLabel}` : '';
        const modeLabel = ` • ${this.deps.formatMultiplayerGameModeLabel(this.deps.getRoomGameMode(room))}`;
        subtitle.textContent = `${sourceLabel} • ${courseLabel}${stageLabel}${modeLabel}`;
        const meta = document.createElement('div');
        meta.className = 'lobby-item-meta';
        const status = room.meta?.status === 'in_game' ? 'In Game' : 'Waiting';
        const playerCount = room.playerCount ?? 0;
        const maxPlayers = room.settings?.maxPlayers ?? this.deps.lobbyDefaultPlayers;
        const locked = !!room.settings?.locked;
        const lockLabel = locked ? ' • Locked' : '';
        meta.textContent = `${status} • ${playerCount}/${maxPlayers} players${lockLabel}`;
        info.append(title, subtitle, meta);
        const join = document.createElement('button');
        join.className = 'ghost compact';
        join.type = 'button';
        join.textContent = 'Join';
        if (playerCount >= maxPlayers || locked) {
          join.disabled = true;
        }
        join.addEventListener('click', async () => {
          await this.joinRoom(room.roomId);
        });
        item.append(info, join);
        lobbyList.appendChild(item);
      }
      lobbyStatus.textContent = `Lobby: ${rooms.length} room(s)`;
    } catch (err) {
      console.error(err);
      lobbyStatus.textContent = 'Lobby: failed';
      if (multiplayerOnlineCount) {
        multiplayerOnlineCount.textContent = '0 players online';
      }
    }
  }

  async createRoom() {
    const { lobbyClient, lobbyStatus } = this.deps;
    if (!lobbyClient || !lobbyStatus) {
      return;
    }
    const isPublic = this.deps.lobbyPublicCheckbox?.checked ?? true;
    const mode = this.deps.getLobbySelectedGameMode();
    const defaultMaxPlayers = mode === 'chained_together'
      ? this.deps.chainedDefaultPlayers
      : this.deps.lobbyDefaultPlayers;
    lobbyStatus.textContent = 'Lobby: creating...';
    try {
      const result = await lobbyClient.createRoom({
        isPublic,
        courseId: 'smb1-main',
        settings: { maxPlayers: defaultMaxPlayers, collisionEnabled: true, infiniteTimeEnabled: false, locked: false },
        meta: this.deps.buildRoomMetaForCreation(),
      });
      this.deps.destroySingleplayerForNetplay();
      this.deps.setLobbyRoom(result.room);
      this.deps.setLobbySelfId(result.playerId);
      this.deps.setLobbyPlayerToken(result.playerToken);
      this.deps.setLobbyHostToken(result.hostToken ?? null);
      lobbyStatus.textContent = 'Lobby: hosting room';
      this.deps.startHost(result.room, result.playerToken);
    } catch (err) {
      console.error(err);
      lobbyStatus.textContent = 'Lobby: create failed';
    }
  }

  async joinRoom(roomId: string) {
    const { lobbyClient, lobbyStatus } = this.deps;
    if (!lobbyClient || !lobbyStatus) {
      return;
    }
    const lobbyRoom = this.deps.getLobbyRoom();
    if (lobbyRoom) {
      if (lobbyRoom.roomId === roomId) {
        lobbyStatus.textContent = 'Lobby: already in room';
        return;
      }
      lobbyStatus.textContent = 'Lobby: leave current room first';
      return;
    }
    lobbyStatus.textContent = 'Lobby: joining...';
    let result: { room: LobbyRoom; playerId: number; playerToken: string };
    try {
      result = await lobbyClient.joinRoom({ roomId });
    } catch (err) {
      console.error(err);
      this.setJoinErrorStatus(lobbyStatus, err);
      return;
    }
    this.deps.destroySingleplayerForNetplay();
    this.deps.setLobbyRoom(result.room);
    this.deps.setLobbySelfId(result.playerId);
    this.deps.setLobbyPlayerToken(result.playerToken);
    this.deps.setLobbyHostToken(null);
    lobbyStatus.textContent = 'Lobby: connecting...';
    try {
      await this.deps.startClient(result.room, result.playerId, result.playerToken);
    } catch (err) {
      console.error(err);
      await this.cleanupFailedClientJoin(result.room.roomId, result.playerId, result.playerToken);
      lobbyStatus.textContent = 'Lobby: connection failed';
    }
  }

  async joinRoomByCode() {
    const { lobbyClient, lobbyStatus, lobbyCodeInput } = this.deps;
    if (!lobbyClient || !lobbyStatus) {
      return;
    }
    const code = lobbyCodeInput?.value?.trim();
    if (!code) {
      lobbyStatus.textContent = 'Lobby: enter a room code';
      return;
    }
    const lobbyRoom = this.deps.getLobbyRoom();
    if (lobbyRoom) {
      const existingCode = lobbyRoom.roomCode?.trim().toUpperCase();
      if (existingCode && existingCode === code.trim().toUpperCase()) {
        lobbyStatus.textContent = 'Lobby: already in room';
        return;
      }
      lobbyStatus.textContent = 'Lobby: leave current room first';
      return;
    }
    lobbyStatus.textContent = 'Lobby: joining...';
    let result: { room: LobbyRoom; playerId: number; playerToken: string };
    try {
      result = await lobbyClient.joinRoom({ roomCode: code });
    } catch (err) {
      console.error(err);
      this.setJoinErrorStatus(lobbyStatus, err);
      return;
    }
    this.deps.destroySingleplayerForNetplay();
    this.deps.setLobbyRoom(result.room);
    this.deps.setLobbySelfId(result.playerId);
    this.deps.setLobbyPlayerToken(result.playerToken);
    this.deps.setLobbyHostToken(null);
    lobbyStatus.textContent = 'Lobby: connecting...';
    try {
      await this.deps.startClient(result.room, result.playerId, result.playerToken);
    } catch (err) {
      console.error(err);
      await this.cleanupFailedClientJoin(result.room.roomId, result.playerId, result.playerToken);
      lobbyStatus.textContent = 'Lobby: connection failed';
    }
  }

  async leaveRoom(skipConfirm = false) {
    const { lobbyClient, lobbyStatus } = this.deps;
    if (!lobbyClient) {
      this.deps.resetNetplayConnections();
      return;
    }
    const lobbyRoom = this.deps.getLobbyRoom();
    const roomId = lobbyRoom?.roomId;
    const wasHost = this.deps.getNetplayRole() === 'host';

    const hostToken = this.deps.getLobbyHostToken();
    const playerId = this.deps.getLobbySelfId();
    const playerToken = this.deps.getLobbyPlayerToken();

    if (!skipConfirm && wasHost && roomId) {
      const confirmed = window.confirm('Leaving will close this lobby for everyone. Leave anyway?');
      if (!confirmed) {
        return;
      }
    }
    const isHostClose = !!roomId && wasHost && !!hostToken;
    if (roomId && wasHost && hostToken) {
      try {
        await lobbyClient.closeRoom(roomId, hostToken);
      } catch (err) {
        const errorCode = this.getErrorCode(err);
        if (!this.shouldTeardownAfterLeaveError(errorCode)) {
          console.error(err);
          if (lobbyStatus) {
            lobbyStatus.textContent = 'Lobby: close failed';
          }
          return;
        }
      }
    } else if (roomId && playerId !== null && playerToken) {
      try {
        await lobbyClient.leaveRoom(roomId, playerId, playerToken);
      } catch (err) {
        const errorCode = this.getErrorCode(err);
        if (!this.shouldTeardownAfterLeaveError(errorCode)) {
          console.error(err);
          if (lobbyStatus) {
            lobbyStatus.textContent = isHostClose ? 'Lobby: close failed' : 'Lobby: leave failed';
          }
          return;
        }
      }
    }

    this.deps.setLobbySignalShouldReconnect(false);
    this.deps.clearLobbySignalRetry();
    this.deps.resetNetplayConnections();

    if (lobbyStatus) {
      lobbyStatus.textContent = 'Lobby: idle';
    }
  }
}
