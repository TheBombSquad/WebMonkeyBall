import type { Game } from '../../game.js';
import type { ReplayData } from '../../replay.js';
import { GAME_SOURCES, type GameSource } from '../../shared/constants/index.js';
import { getStageNameForSource } from '../../stage_names.js';
import { formatGameSourceLabel, titleCaseLabel } from '../netplay/presence_format.js';

export type ReplaySummary = {
  sourceLabel: string;
  courseLabel: string;
  stageLabel: string;
  timeFrames: number;
  score: number;
};

function formatTimer(frames: number): string {
  const clampedFrames = Math.max(0, Math.floor(frames));
  const totalSeconds = Math.floor(clampedFrames / 60);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const frameRemainder = clampedFrames % 60;
  const centis = Math.floor((frameRemainder * 100) / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}

function getCourseLabel(gameSource: GameSource, game?: Game | null): string {
  const course = game?.course as any;
  if (!course) {
    return gameSource === GAME_SOURCES.SMB1 ? 'Beginner' : 'Story';
  }
  if (gameSource === GAME_SOURCES.SMB1) {
    return titleCaseLabel(String(course.difficulty ?? 'beginner')) || 'Beginner';
  }
  const mode = String(course.mode ?? '').toLowerCase();
  if (mode === 'story') {
    return 'Story';
  }
  const difficulty = String(course.difficultyLabel ?? course.difficulty ?? '').trim();
  if (!difficulty) {
    return 'Challenge';
  }
  return `Challenge ${titleCaseLabel(difficulty)}`.trim();
}

function getStageLabel(gameSource: GameSource, stageId: number): string {
  const stageName = getStageNameForSource(gameSource, stageId);
  if (stageName) {
    return stageName;
  }
  return `Stage ${String(Math.max(0, Math.trunc(stageId))).padStart(3, '0')}`;
}

export function formatReplayName(summary: ReplaySummary): string {
  return `${summary.sourceLabel} | ${summary.courseLabel} | ${summary.stageLabel} | ${formatTimer(summary.timeFrames)} | ${summary.score}`;
}

export function formatReplaySubtitle(summary: ReplaySummary): string {
  return `${summary.courseLabel} • ${summary.stageLabel} • ${formatTimer(summary.timeFrames)} • ${summary.score}`;
}

export function buildReplaySummaryFromGame(game: Game, replay: ReplayData): ReplaySummary {
  const source = replay.gameSource;
  return {
    sourceLabel: formatGameSourceLabel(source),
    courseLabel: getCourseLabel(source, game),
    stageLabel: getStageLabel(source, replay.stageId),
    timeFrames: Math.max(0, Math.trunc(game.stageTimerFrames ?? replay.ticks ?? replay.inputs.length ?? 0)),
    score: Math.max(0, Math.trunc(game.score ?? 0)),
  };
}

export function buildReplaySummaryFromReplay(replay: ReplayData): ReplaySummary {
  const source = replay.gameSource;
  return {
    sourceLabel: formatGameSourceLabel(source),
    courseLabel: getCourseLabel(source, null),
    stageLabel: getStageLabel(source, replay.stageId),
    timeFrames: Math.max(0, Math.trunc(replay.ticks ?? replay.inputs.length ?? 0)),
    score: 0,
  };
}
