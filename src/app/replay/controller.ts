import type { AudioManager } from '../../audio.js';
import type { Game } from '../../game.js';
import type { ReplayData } from '../../replay.js';
import type { GameSource } from '../../shared/constants/index.js';
import { ReplayLibraryStore, type ReplayLibraryRecord } from './library_store.js';
import {
  buildReplaySummaryFromGame,
  buildReplaySummaryFromReplay,
  formatReplayName,
  formatReplaySubtitle,
} from './summary.js';

type ReplayControllerDeps = {
  game: Game;
  audio: AudioManager;
  resumeButton: HTMLButtonElement;
  hudStatus: HTMLElement | null;
  gameSourceSelect: HTMLSelectElement | null;
  setOverlayVisible: (visible: boolean) => void;
  updateGameSourceFields: () => void;
  setActiveGameSource: (source: GameSource) => void;
  setCurrentSmb2LikeMode: (mode: 'story' | 'challenge' | null) => void;
  getStageBasePath: (source: GameSource) => string;
  replayLibraryStatus: HTMLElement | null;
  replayLibraryList: HTMLElement | null;
  replayLibraryImportButton: HTMLButtonElement | null;
  replayLibraryRefreshButton: HTMLButtonElement | null;
  replayLibraryFileInput: HTMLInputElement | null;
  onReplayPlaybackExitToMenu: () => void;
};

type SaveReplayResult = {
  success: boolean;
  message: string;
};

function sanitizeFilenameBase(value: string) {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'replay';
}

function isReplayData(value: unknown): value is ReplayData {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const replay = value as ReplayData;
  if (replay.version !== 1) {
    return false;
  }
  if (!Array.isArray(replay.inputs)) {
    return false;
  }
  if (typeof replay.stageId !== 'number' || !Number.isFinite(replay.stageId)) {
    return false;
  }
  return true;
}

export class ReplayController {
  private readonly deps: ReplayControllerDeps;
  private readonly store = new ReplayLibraryStore();

  constructor(deps: ReplayControllerDeps) {
    this.deps = deps;
  }

  setReplayStatus(text: string) {
    if (this.deps.replayLibraryStatus) {
      this.deps.replayLibraryStatus.textContent = text;
    }
  }

  isReplayPlaybackActive() {
    const game = this.deps.game;
    return game.replayInputStartTick !== null && Array.isArray(game.inputFeed);
  }

  exitReplayPlaybackToMenu() {
    if (!this.isReplayPlaybackActive()) {
      return;
    }
    this.deps.game.setReplayMode(false);
    this.deps.onReplayPlaybackExitToMenu();
    this.setReplayStatus('Replays: exited playback');
  }

  async startReplay(replay: ReplayData) {
    const {
      setOverlayVisible,
      resumeButton,
      hudStatus,
      game,
      audio,
      gameSourceSelect,
      updateGameSourceFields,
      setActiveGameSource,
      setCurrentSmb2LikeMode,
      getStageBasePath,
    } = this.deps;
    setOverlayVisible(false);
    resumeButton.disabled = true;
    if (hudStatus) {
      hudStatus.textContent = '';
    }
    game.setReplayMode(true, true);
    setActiveGameSource(replay.gameSource);
    if (gameSourceSelect) {
      gameSourceSelect.value = replay.gameSource;
    }
    updateGameSourceFields();
    game.setGameSource(replay.gameSource);
    game.stageBasePath = getStageBasePath(replay.gameSource);
    setCurrentSmb2LikeMode(null);
    game.course = null;
    void audio.resume();
    await game.loadStage(replay.stageId);
    const localPlayer = game.getLocalPlayer?.() ?? null;
    if (localPlayer?.ball && game.stage) {
      const startTick = Math.max(0, replay.inputStartTick ?? 0);
      game.introTotalFrames = startTick;
      game.introTimerFrames = startTick;
      game.cameraController?.initForStage(localPlayer.ball, localPlayer.ball.startRotY, game.stageRuntime);
    }
    game.replayInputStartTick = Math.max(0, replay.inputStartTick ?? 0);
    game.setInputFeed(replay.inputs);
    game.paused = false;
    while (game.simTick < game.replayInputStartTick) {
      game.update(game.fixedStep);
    }
    game.replayAutoFastForward = false;
    game.setFixedTickMode(false, 1);
    this.setReplayStatus(`Replays: loaded stage ${replay.stageId}`);
  }

  downloadReplay(replay: ReplayData, filenameBase?: string) {
    const label = String(replay.stageId).padStart(3, '0');
    const fallback = `replay_${replay.gameSource}_st${label}`;
    const filename = `${sanitizeFilenameBase(filenameBase ?? fallback)}.json`;
    const blob = new Blob([JSON.stringify(replay, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async saveActiveReplayToLibrary(): Promise<SaveReplayResult> {
    const { game } = this.deps;
    if (!game.stage) {
      this.setReplayStatus('Replays: no stage active');
      return { success: false, message: 'No active stage to save.' };
    }
    const replay = game.exportReplay();
    if (!replay) {
      this.setReplayStatus('Replays: no inputs recorded');
      return { success: false, message: 'No replay data recorded yet.' };
    }
    const summary = buildReplaySummaryFromGame(game, replay);
    const name = formatReplayName(summary);
    try {
      await this.store.add(replay, summary, name);
      this.setReplayStatus('Replays: saved');
      await this.refreshReplayLibrary();
      return { success: true, message: 'Replay saved to replay library.' };
    } catch (error) {
      console.error(error);
      this.downloadReplay(replay, name);
      this.setReplayStatus('Replays: exported (storage unavailable)');
      return { success: true, message: 'Replay exported as a file (storage unavailable).' };
    }
  }

  private renderReplayRow(record: ReplayLibraryRecord) {
    const replayList = this.deps.replayLibraryList;
    if (!replayList) {
      return;
    }
    const summary = record.summary ?? buildReplaySummaryFromReplay(record.replay);
    const displayName = record.name?.trim() || formatReplayName(summary);

    const row = document.createElement('div');
    row.className = 'replay-library-row';

    const info = document.createElement('div');
    info.className = 'replay-library-info';
    const title = document.createElement('div');
    title.className = 'replay-library-title';
    title.textContent = displayName;
    const subtitle = document.createElement('div');
    subtitle.className = 'replay-library-subtitle';
    subtitle.textContent = formatReplaySubtitle(summary);
    info.append(title, subtitle);

    const actions = document.createElement('div');
    actions.className = 'replay-library-actions';

    const loadButton = document.createElement('button');
    loadButton.type = 'button';
    loadButton.className = 'ghost compact';
    loadButton.textContent = 'Load';
    loadButton.addEventListener('click', () => {
      void this.startReplay(record.replay);
    });

    const renameButton = document.createElement('button');
    renameButton.type = 'button';
    renameButton.className = 'ghost compact';
    renameButton.textContent = 'Rename';
    renameButton.addEventListener('click', () => {
      const nextName = window.prompt('Replay name', displayName);
      if (nextName === null) {
        return;
      }
      const trimmed = nextName.trim();
      if (!trimmed) {
        return;
      }
      void this.store.rename(record.id, trimmed).then(() => this.refreshReplayLibrary()).catch((error) => {
        console.error(error);
        this.setReplayStatus('Replays: rename failed');
      });
    });

    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.className = 'ghost compact';
    exportButton.textContent = 'Export';
    exportButton.addEventListener('click', () => {
      this.downloadReplay(record.replay, displayName);
      this.setReplayStatus('Replays: exported');
    });

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'ghost compact';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => {
      const confirmed = window.confirm(`Delete replay "${displayName}"?`);
      if (!confirmed) {
        return;
      }
      void this.store.remove(record.id).then(() => this.refreshReplayLibrary()).catch((error) => {
        console.error(error);
        this.setReplayStatus('Replays: delete failed');
      });
    });

    actions.append(loadButton, renameButton, exportButton, deleteButton);
    row.append(info, actions);
    replayList.appendChild(row);
  }

  async refreshReplayLibrary() {
    const replayList = this.deps.replayLibraryList;
    if (!replayList) {
      return;
    }
    replayList.innerHTML = '';
    try {
      const records = await this.store.list();
      if (records.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = 'No saved replays.';
        replayList.appendChild(empty);
      } else {
        for (const record of records) {
          this.renderReplayRow(record);
        }
      }
      this.setReplayStatus(`Replays: ${records.length} saved`);
    } catch (error) {
      console.error(error);
      this.setReplayStatus('Replays: unavailable');
    }
  }

  private async importReplayFile(file: File) {
    let replay: ReplayData | null = null;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!isReplayData(parsed)) {
        throw new Error('Invalid replay');
      }
      replay = parsed as ReplayData;
      const summary = buildReplaySummaryFromReplay(replay);
      const name = formatReplayName(summary);
      try {
        await this.store.add(replay, summary, name);
        this.setReplayStatus('Replays: imported');
        await this.refreshReplayLibrary();
      } catch (storeError) {
        console.error(storeError);
        await this.startReplay(replay);
        this.setReplayStatus('Replays: loaded from file');
      }
    } catch (error) {
      console.error(error);
      this.setReplayStatus('Replays: import failed');
    }
  }

  bindReplayUi() {
    const {
      replayLibraryImportButton,
      replayLibraryRefreshButton,
      replayLibraryFileInput,
    } = this.deps;

    replayLibraryImportButton?.addEventListener('click', () => {
      replayLibraryFileInput?.click();
    });

    replayLibraryRefreshButton?.addEventListener('click', () => {
      void this.refreshReplayLibrary();
    });

    replayLibraryFileInput?.addEventListener('change', () => {
      const file = replayLibraryFileInput.files?.[0];
      replayLibraryFileInput.value = '';
      if (!file) {
        return;
      }
      void this.importReplayFile(file);
    });

    void this.refreshReplayLibrary();
  }
}
