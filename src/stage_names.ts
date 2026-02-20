import { getStageListForDifficulty } from './course.js';
import { getMb2wsStageName } from './mb2ws_stage_names.js';
import { GAME_SOURCES, type GameSource } from './shared/constants/index.js';
import { getSmb2StageName } from './smb2_stage_names.js';

const SMB1_DIFFICULTIES = [
  'beginner',
  'advanced',
  'expert',
  'beginner-extra',
  'advanced-extra',
  'expert-extra',
  'master',
] as const;

const SMB1_STAGE_NAMES = new Map<number, string>();

for (const difficulty of SMB1_DIFFICULTIES) {
  const stages = getStageListForDifficulty(difficulty);
  for (const stage of stages) {
    if (!SMB1_STAGE_NAMES.has(stage.id) && typeof stage.label === 'string' && stage.label.length > 0) {
      SMB1_STAGE_NAMES.set(stage.id, stage.label);
    }
  }
}

function normalizeStageName(name: string | null) {
  if (typeof name !== 'string') {
    return null;
  }
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getStageNameForSource(gameSource: GameSource, stageId: number): string | null {
  if (!Number.isFinite(stageId)) {
    return null;
  }
  const id = Math.max(0, Math.trunc(stageId));
  if (gameSource === GAME_SOURCES.SMB1) {
    return normalizeStageName(SMB1_STAGE_NAMES.get(id) ?? null);
  }
  if (gameSource === GAME_SOURCES.MB2WS) {
    return normalizeStageName(getMb2wsStageName(id));
  }
  return normalizeStageName(getSmb2StageName(id));
}

export function formatStageOptionLabel(gameSource: GameSource, stageId: number, stageNumber: number) {
  const name = getStageNameForSource(gameSource, stageId);
  if (!name) {
    return `Stage ${stageNumber}`;
  }
  return `Stage ${stageNumber} - ${name}`;
}
