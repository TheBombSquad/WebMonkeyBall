export type MenuPanel =
  | 'main'
  | 'singleplayer'
  | 'course-play'
  | 'replays'
  | 'pause'
  | 'multiplayer'
  | 'multiplayer-ingame'
  | 'settings'
  | 'level-select'
  | 'leaderboards';

type MenuFlowOptions = {
  mainMenuPanel: HTMLElement | null;
  singleplayerMenuPanel: HTMLElement | null;
  coursePlayMenuPanel: HTMLElement | null;
  replayLibraryMenuPanel: HTMLElement | null;
  pauseMenuPanel: HTMLElement | null;
  multiplayerLayout: HTMLElement | null;
  multiplayerMenuPanel: HTMLElement | null;
  multiplayerIngameMenuPanel: HTMLElement | null;
  settingsMenuPanel: HTMLElement | null;
  levelSelectMenuPanel: HTMLElement | null;
  leaderboardsMenuPanel: HTMLElement | null;
  onMenuChanged: () => void;
  onOpenMultiplayerMenu: () => void;
  onOpenSingleplayerMenu?: () => void;
  onOpenCoursePlayMenu?: () => void;
  onOpenReplaysMenu?: () => void;
  onOpenSettingsMenu: () => void;
  onOpenLevelSelectMenu: () => void;
  onOpenLeaderboardsMenu: () => void;
  setOverlayVisible: (visible: boolean) => void;
  isRunning: () => boolean;
  isNetplayEnabled: () => boolean;
  isLeaderboardsMenuEnabled?: () => boolean;
  onPauseSingleplayer: () => void;
  onResumeSingleplayer: () => void;
};

export class MenuFlowController {
  private readonly options: MenuFlowOptions;
  private activeMenu: MenuPanel = 'main';

  constructor(options: MenuFlowOptions) {
    this.options = options;
  }

  getActiveMenu() {
    return this.activeMenu;
  }

  setActiveMenu(menu: MenuPanel) {
    const leaderboardsEnabled = this.options.isLeaderboardsMenuEnabled?.() ?? true;
    const nextMenu = menu === 'leaderboards' && !leaderboardsEnabled ? 'main' : menu;
    if (this.activeMenu === nextMenu) {
      return;
    }
    this.activeMenu = nextMenu;
    this.options.mainMenuPanel?.classList.toggle('hidden', nextMenu !== 'main');
    this.options.singleplayerMenuPanel?.classList.toggle('hidden', nextMenu !== 'singleplayer');
    this.options.coursePlayMenuPanel?.classList.toggle('hidden', nextMenu !== 'course-play');
    this.options.replayLibraryMenuPanel?.classList.toggle('hidden', nextMenu !== 'replays');
    this.options.pauseMenuPanel?.classList.toggle('hidden', nextMenu !== 'pause');
    this.options.multiplayerLayout?.classList.toggle('hidden', nextMenu !== 'multiplayer');
    this.options.multiplayerMenuPanel?.classList.toggle('hidden', nextMenu !== 'multiplayer');
    this.options.multiplayerIngameMenuPanel?.classList.toggle('hidden', nextMenu !== 'multiplayer-ingame');
    this.options.settingsMenuPanel?.classList.toggle('hidden', nextMenu !== 'settings');
    this.options.levelSelectMenuPanel?.classList.toggle('hidden', nextMenu !== 'level-select');
    this.options.leaderboardsMenuPanel?.classList.toggle('hidden', nextMenu !== 'leaderboards');
    this.options.onMenuChanged();
    if (nextMenu === 'multiplayer') {
      this.options.onOpenMultiplayerMenu();
    }
    if (nextMenu === 'singleplayer') {
      this.options.onOpenSingleplayerMenu?.();
    }
    if (nextMenu === 'course-play') {
      this.options.onOpenCoursePlayMenu?.();
    }
    if (nextMenu === 'replays') {
      this.options.onOpenReplaysMenu?.();
    }
    if (nextMenu === 'settings') {
      this.options.onOpenSettingsMenu();
    }
    if (nextMenu === 'level-select') {
      this.options.onOpenLevelSelectMenu();
    }
    if (nextMenu === 'leaderboards') {
      this.options.onOpenLeaderboardsMenu();
    }
  }

  openMenuOverlay(preferredMenu?: MenuPanel) {
    if (!this.options.isRunning()) {
      return;
    }
    if (this.options.isNetplayEnabled()) {
      this.setActiveMenu('multiplayer-ingame');
      this.options.setOverlayVisible(true);
      return;
    }
    this.setActiveMenu(preferredMenu ?? 'pause');
    this.options.onPauseSingleplayer();
  }

  closeMenuOverlay() {
    if (!this.options.isRunning()) {
      return;
    }
    if (this.options.isNetplayEnabled()) {
      this.options.setOverlayVisible(false);
      return;
    }
    this.options.onResumeSingleplayer();
  }
}
