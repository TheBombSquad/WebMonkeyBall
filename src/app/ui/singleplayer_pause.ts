import type { AudioManager } from '../../audio.js';
import type { Game } from '../../game.js';
import type { MenuPanel } from './menu_flow.js';

const NAV_DEADZONE = 0.45;
const NAV_DAS_MS = 250;
const NAV_ARR_MS = 125;
const PAUSE_MASTER_VOLUME_SCALE = 0.4;

type PauseActionId = 'resume' | 'retry' | 'save_replay' | 'view_stage' | 'return_main_menu';

type PauseActionEntry = {
  id: PauseActionId;
  button: HTMLButtonElement;
};

type SingleplayerPauseControllerOptions = {
  game: Game;
  audio: AudioManager;
  overlay: HTMLElement;
  pauseMenuPanel: HTMLElement | null;
  pauseResumeButton: HTMLButtonElement | null;
  pauseRetryButton: HTMLButtonElement | null;
  pauseSaveReplayButton: HTMLButtonElement | null;
  pauseViewStageButton: HTMLButtonElement | null;
  pauseReturnMainMenuButton: HTMLButtonElement | null;
  isRunning: () => boolean;
  isNetplayEnabled: () => boolean;
  getActiveMenu: () => MenuPanel;
  openPauseMenu: () => void;
  pauseGame: () => void;
  resumeGame: () => void;
  closeMenuOverlay: () => void;
  onRetry: () => void;
  onSaveReplay: () => void;
  onReturnMainMenu: () => void;
};

export class SingleplayerPauseController {
  private readonly options: SingleplayerPauseControllerOptions;
  private readonly actions: PauseActionEntry[];
  private selectedIndex = 0;
  private navDirection = 0;
  private navNextAtMs = 0;
  private actionDown = false;
  private viewStageActive = false;
  private pausedStateSnapshot: any = null;
  private savedInputRecordLength: number | null = null;
  private savedInputStartTick = 0;
  private savedAutoRecordInputs = true;
  private announcerMutedForViewStage = false;

  constructor(options: SingleplayerPauseControllerOptions) {
    this.options = options;
    this.actions = [
      { id: 'resume', button: options.pauseResumeButton },
      { id: 'retry', button: options.pauseRetryButton },
      { id: 'save_replay', button: options.pauseSaveReplayButton },
      { id: 'view_stage', button: options.pauseViewStageButton },
      { id: 'return_main_menu', button: options.pauseReturnMainMenuButton },
    ].filter((entry): entry is PauseActionEntry => !!entry.button);

    this.actions.forEach((entry, index) => {
      entry.button.addEventListener('mouseenter', () => {
        this.setSelectedIndex(index);
      });
      entry.button.addEventListener('focus', () => {
        this.setSelectedIndex(index);
      });
      entry.button.addEventListener('click', (event) => {
        event.preventDefault();
        this.setSelectedIndex(index);
        this.activateSelectedAction();
      });
    });

    this.setSelectedIndex(0);
  }

  handlePauseRequest() {
    if (!this.options.isRunning() || this.options.isNetplayEnabled()) {
      return;
    }
    if (this.viewStageActive) {
      this.restorePausedStateFromViewStage();
    }
    this.options.pauseGame();
    this.capturePausedState();
    this.options.overlay.classList.add('pause-menu-active');
    this.options.audio.setMasterVolumeScale(PAUSE_MASTER_VOLUME_SCALE);
    this.resetMenuInputState();
    this.setSelectedIndex(0);
  }

  handleResumeRequest() {
    if (!this.options.isRunning() || this.options.isNetplayEnabled()) {
      return;
    }
    this.options.overlay.classList.remove('pause-menu-active');
    this.options.audio.setMasterVolumeScale(1);
    this.resetMenuInputState();
    this.options.resumeGame();
  }

  tick(nowMs: number) {
    this.syncViewStageAnnouncerMute();
    this.handleStartButtonRequest();
    if (!this.canNavigatePauseMenu()) {
      this.resetMenuInputState();
      return;
    }

    const y = this.options.game.input?.getGamepadStick?.()?.y ?? 0;
    let direction = 0;
    if (y <= -NAV_DEADZONE) {
      direction = -1;
    } else if (y >= NAV_DEADZONE) {
      direction = 1;
    }

    if (direction === 0) {
      this.navDirection = 0;
      this.navNextAtMs = 0;
    } else if (direction !== this.navDirection) {
      this.stepSelection(direction);
      this.navDirection = direction;
      this.navNextAtMs = nowMs + NAV_DAS_MS;
    } else if (nowMs >= this.navNextAtMs) {
      this.stepSelection(direction);
      this.navNextAtMs = nowMs + NAV_ARR_MS;
    }

    const actionDown = !!this.options.game.input?.isPrimaryActionDown?.();
    if (actionDown && !this.actionDown) {
      this.activateSelectedAction();
    }
    this.actionDown = actionDown;
  }

  private handleStartButtonRequest() {
    if (!this.options.isRunning() || this.options.isNetplayEnabled()) {
      return;
    }
    if (!this.options.game.input?.wasStartPressed?.()) {
      return;
    }
    if (!this.options.overlay.classList.contains('hidden')) {
      return;
    }
    this.options.openPauseMenu();
  }

  private syncViewStageAnnouncerMute() {
    const shouldMute = !!this.options.game.singleplayerStageViewActive;
    if (shouldMute === this.announcerMutedForViewStage) {
      return;
    }
    this.options.audio.setAnnouncerVolumeScale(shouldMute ? 0 : 1);
    this.announcerMutedForViewStage = shouldMute;
  }

  private canNavigatePauseMenu() {
    if (this.viewStageActive) {
      return false;
    }
    if (!this.options.pauseMenuPanel || this.actions.length === 0) {
      return false;
    }
    if (this.options.getActiveMenu() !== 'pause') {
      return false;
    }
    if (this.options.overlay.classList.contains('hidden')) {
      return false;
    }
    return true;
  }

  private resetMenuInputState() {
    this.navDirection = 0;
    this.navNextAtMs = 0;
    this.actionDown = false;
  }

  private setSelectedIndex(index: number) {
    if (this.actions.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    const count = this.actions.length;
    let wrapped = index % count;
    if (wrapped < 0) {
      wrapped += count;
    }
    this.selectedIndex = wrapped;
    for (let i = 0; i < this.actions.length; i += 1) {
      const selected = i === this.selectedIndex;
      this.actions[i].button.classList.toggle('is-selected', selected);
      this.actions[i].button.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
  }

  private stepSelection(direction: number) {
    this.setSelectedIndex(this.selectedIndex + direction);
  }

  private activateSelectedAction() {
    const action = this.actions[this.selectedIndex];
    if (!action) {
      return;
    }
    switch (action.id) {
      case 'resume':
        this.options.closeMenuOverlay();
        return;
      case 'retry':
        this.options.closeMenuOverlay();
        this.options.onRetry();
        return;
      case 'save_replay':
        this.options.onSaveReplay();
        return;
      case 'view_stage':
        this.enterViewStage();
        return;
      case 'return_main_menu':
        this.options.overlay.classList.remove('pause-menu-active');
        this.options.audio.setMasterVolumeScale(1);
        this.options.audio.setAnnouncerVolumeScale(1);
        this.announcerMutedForViewStage = false;
        this.options.onReturnMainMenu();
        return;
      default:
        return;
    }
  }

  private capturePausedState() {
    this.pausedStateSnapshot = this.options.game.saveRollbackState(this.pausedStateSnapshot);
  }

  private enterViewStage() {
    if (this.viewStageActive || !this.options.game.stageRuntime) {
      return;
    }
    this.capturePausedState();
    if (!this.pausedStateSnapshot) {
      return;
    }
    this.savedInputRecordLength = this.options.game.inputRecord ? this.options.game.inputRecord.length : null;
    this.savedInputStartTick = this.options.game.inputStartTick;
    this.savedAutoRecordInputs = this.options.game.autoRecordInputs;
    if (!this.options.game.loadStageViewRollbackState()) {
      return;
    }
    if (!this.options.game.enterSingleplayerStageView()) {
      return;
    }
    this.options.game.autoRecordInputs = false;
    this.viewStageActive = true;
    this.options.audio.setAnnouncerVolumeScale(0);
    this.announcerMutedForViewStage = true;
    this.options.closeMenuOverlay();
  }

  private restorePausedStateFromViewStage() {
    if (!this.viewStageActive) {
      return;
    }
    this.options.game.setSingleplayerStageViewActive(false);
    if (this.pausedStateSnapshot) {
      this.options.game.loadRollbackState(this.pausedStateSnapshot);
    }
    this.options.game.autoRecordInputs = this.savedAutoRecordInputs;
    if (this.options.game.inputRecord && this.savedInputRecordLength !== null) {
      this.options.game.inputRecord.length = this.savedInputRecordLength;
    }
    this.options.game.inputStartTick = this.savedInputStartTick;
    this.savedInputRecordLength = null;
    this.savedInputStartTick = 0;
    this.savedAutoRecordInputs = true;
    this.viewStageActive = false;
    this.options.audio.setAnnouncerVolumeScale(1);
    this.announcerMutedForViewStage = false;
  }
}
