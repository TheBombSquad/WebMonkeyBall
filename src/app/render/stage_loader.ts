import ArrayBufferSlice from '../../noclip/ArrayBufferSlice.js';
import { parseAVTpl } from '../../noclip/SuperMonkeyBall/AVTpl.js';
import { decompressLZ } from '../../noclip/SuperMonkeyBall/AVLZ.js';
import * as Nl from '../../noclip/SuperMonkeyBall/NaomiLib.js';
import * as Gma from '../../noclip/SuperMonkeyBall/Gma.js';
import { parseStagedefLz } from '../../noclip/SuperMonkeyBall/Stagedef.js';
import { StageId, STAGE_INFO_MAP } from '../../noclip/SuperMonkeyBall/StageInfo.js';
import type { StageData } from '../../noclip/SuperMonkeyBall/World.js';
import { GAME_SOURCES, STAGE_BASE_PATHS, type GameSource } from '../../shared/constants/index.js';
import { convertSmb2StageDef, getMb2wsStageInfo, getSmb2StageInfo } from '../../smb2_render.js';

type StageLoaderOptions = {
  fetchSlice: (path: string) => Promise<ArrayBufferSlice>;
  getStageBasePath: (gameSource: GameSource) => string;
  isNaomiStage: (stageId: number) => boolean;
};

export class StageLoader {
  private readonly fetchSlice: StageLoaderOptions['fetchSlice'];
  private readonly getStageBasePath: StageLoaderOptions['getStageBasePath'];
  private readonly isNaomiStage: StageLoaderOptions['isNaomiStage'];
  private smb1BallCommonGmaPromise: Promise<Gma.Gma | null> | null = null;

  constructor(options: StageLoaderOptions) {
    this.fetchSlice = options.fetchSlice;
    this.getStageBasePath = options.getStageBasePath;
    this.isNaomiStage = options.isNaomiStage;
  }

  private loadSmb1BallCommonGma(): Promise<Gma.Gma | null> {
    if (this.smb1BallCommonGmaPromise) {
      return this.smb1BallCommonGmaPromise;
    }
    const smb1BasePath = this.getStageBasePath(GAME_SOURCES.SMB1) ?? STAGE_BASE_PATHS[GAME_SOURCES.SMB1];
    this.smb1BallCommonGmaPromise = (async () => {
      if (!smb1BasePath) {
        return null;
      }
      try {
        const [ballGmaBuf, ballTplBuf] = await Promise.all([
          this.fetchSlice(`${smb1BasePath}/init/common.gma`),
          this.fetchSlice(`${smb1BasePath}/init/common.tpl`),
        ]);
        return Gma.parseGma(ballGmaBuf, parseAVTpl(ballTplBuf, 'smb1-common-ball'));
      } catch {
        return null;
      }
    })();
    return this.smb1BallCommonGmaPromise;
  }

  async loadSmb1(stageId: number): Promise<StageData> {
    const stageIdStr = String(stageId).padStart(3, '0');
    const stageInfo = STAGE_INFO_MAP.get(stageId as StageId);
    if (!stageInfo) {
      throw new Error(`Missing StageInfo for stage ${stageId}`);
    }

    const stageBasePath = this.getStageBasePath(GAME_SOURCES.SMB1);
    const stagedefPath = `${stageBasePath}/st${stageIdStr}/STAGE${stageIdStr}.lz`;
    const stageGmaPath = `${stageBasePath}/st${stageIdStr}/st${stageIdStr}.gma`;
    const stageTplPath = `${stageBasePath}/st${stageIdStr}/st${stageIdStr}.tpl`;

    const commonGmaPath = `${stageBasePath}/init/common.gma`;
    const commonTplPath = `${stageBasePath}/init/common.tpl`;
    const commonNlPath = `${stageBasePath}/init/common_p.lz`;
    const commonNlTplPath = `${stageBasePath}/init/common.lz`;

    const bgName = stageInfo.bgInfo.fileName;
    const bgGmaPath = `${stageBasePath}/bg/${bgName}.gma`;
    const bgTplPath = `${stageBasePath}/bg/${bgName}.tpl`;
    const isNaomi = this.isNaomiStage(stageId);
    const stageNlObjPath = isNaomi ? `${stageBasePath}/st${stageIdStr}/st${stageIdStr}_p.lz` : null;
    const stageNlTplPath = isNaomi ? `${stageBasePath}/st${stageIdStr}/st${stageIdStr}.lz` : null;
    const smb2BasePath = this.getStageBasePath(GAME_SOURCES.SMB2);
    const goalTimerGmaPromise: Promise<Gma.Gma | null> =
      (async () => {
        if (!smb2BasePath) {
          return null;
        }
        try {
          const [timerGmaBuf, timerTplBuf] = await Promise.all([
            this.fetchSlice(`${smb2BasePath}/init/common.gma`),
            this.fetchSlice(`${smb2BasePath}/init/common.tpl`),
          ]);
          return Gma.parseGma(timerGmaBuf, parseAVTpl(timerTplBuf, 'smb2-common-timer'));
        } catch {
          return null;
        }
      })();

    const [
      stagedefBuf,
      stageGmaBuf,
      stageTplBuf,
      commonGmaBuf,
      commonTplBuf,
      commonNlBuf,
      commonNlTplBuf,
      bgGmaBuf,
      bgTplBuf,
      stageNlObjBuf,
      stageNlTplBuf,
      goalTimerGma,
    ] =
      await Promise.all([
        this.fetchSlice(stagedefPath),
        this.fetchSlice(stageGmaPath),
        this.fetchSlice(stageTplPath),
        this.fetchSlice(commonGmaPath),
        this.fetchSlice(commonTplPath),
        this.fetchSlice(commonNlPath),
        this.fetchSlice(commonNlTplPath),
        this.fetchSlice(bgGmaPath),
        this.fetchSlice(bgTplPath),
        stageNlObjPath ? this.fetchSlice(stageNlObjPath) : Promise.resolve(null),
        stageNlTplPath ? this.fetchSlice(stageNlTplPath) : Promise.resolve(null),
        goalTimerGmaPromise,
      ]);

    const stagedef = parseStagedefLz(stagedefBuf);
    const stageTpl = parseAVTpl(stageTplBuf, `st${stageIdStr}`);
    const stageGma = Gma.parseGma(stageGmaBuf, stageTpl);

    const commonTpl = parseAVTpl(commonTplBuf, 'common');
    const commonGma = Gma.parseGma(commonGmaBuf, commonTpl);
    const commonNlTpl = parseAVTpl(decompressLZ(commonNlTplBuf), 'common-nl');
    const nlObj = Nl.parseObj(decompressLZ(commonNlBuf), commonNlTpl);

    const bgTpl = parseAVTpl(bgTplBuf, bgName);
    const bgGma = Gma.parseGma(bgGmaBuf, bgTpl);
    let stageNlObj: Nl.Obj | null = null;
    let stageNlObjNameMap: Map<string, number> | null = null;
    if (stageNlObjBuf && stageNlTplBuf) {
      const nlTpl = parseAVTpl(decompressLZ(stageNlTplBuf), `st${stageIdStr}-nl`);
      const nlObjBuffer = decompressLZ(stageNlObjBuf);
      stageNlObj = Nl.parseObj(nlObjBuffer, nlTpl);
      stageNlObjNameMap = Nl.buildObjNameMap(nlObjBuffer);
    }

    return {
      stageInfo,
      stagedef,
      stageGma,
      bgGma,
      commonGma,
      ballCommonGma: commonGma,
      goalTimerGma,
      nlObj,
      stageNlObj,
      stageNlObjNameMap,
      gameSource: GAME_SOURCES.SMB1,
    };
  }

  async loadSmb2Like(stageId: number, stage: any, gameSource: GameSource): Promise<StageData> {
    if (!stage || stage.format !== 'smb2') {
      throw new Error('Missing SMB2 stage data.');
    }
    const stageIdStr = String(stageId).padStart(3, '0');
    const stageInfo =
      gameSource === GAME_SOURCES.MB2WS ? getMb2wsStageInfo(stageId) : getSmb2StageInfo(stageId);
    const stagedef = convertSmb2StageDef(stage);

    const stageBasePath = this.getStageBasePath(gameSource) ?? STAGE_BASE_PATHS[GAME_SOURCES.SMB2];
    const stageGmaPath = `${stageBasePath}/st${stageIdStr}/st${stageIdStr}.gma`;
    const stageTplPath = `${stageBasePath}/st${stageIdStr}/st${stageIdStr}.tpl`;

    const commonGmaPath = `${stageBasePath}/init/common.gma`;
    const commonTplPath = `${stageBasePath}/init/common.tpl`;
    const commonNlPath = `${stageBasePath}/init/common_p.lz`;
    const commonNlTplPath = `${stageBasePath}/init/common.lz`;

    const bgName = stageInfo.bgInfo.fileName;
    const bgGmaPath = bgName ? `${stageBasePath}/bg/${bgName}.gma` : '';
    const bgTplPath = bgName ? `${stageBasePath}/bg/${bgName}.tpl` : '';
    const ballCommonGmaPromise = this.loadSmb1BallCommonGma();

    const [
      stageGmaBuf,
      stageTplBuf,
      commonGmaBuf,
      commonTplBuf,
      commonNlBuf,
      commonNlTplBuf,
      bgGmaBuf,
      bgTplBuf,
      ballCommonGma,
    ] =
      await Promise.all([
        this.fetchSlice(stageGmaPath),
        this.fetchSlice(stageTplPath),
        this.fetchSlice(commonGmaPath),
        this.fetchSlice(commonTplPath),
        this.fetchSlice(commonNlPath),
        this.fetchSlice(commonNlTplPath),
        bgName ? this.fetchSlice(bgGmaPath) : Promise.resolve(new ArrayBufferSlice(new ArrayBuffer(0))),
        bgName ? this.fetchSlice(bgTplPath) : Promise.resolve(new ArrayBufferSlice(new ArrayBuffer(0))),
        ballCommonGmaPromise,
      ]);

    const stageTpl = parseAVTpl(stageTplBuf, `st${stageIdStr}`);
    const stageGma = Gma.parseGma(stageGmaBuf, stageTpl);
    const commonTpl = parseAVTpl(commonTplBuf, 'common');
    const commonGma = Gma.parseGma(commonGmaBuf, commonTpl);
    const commonNlTpl = parseAVTpl(decompressLZ(commonNlTplBuf), 'common-nl');
    const nlObj = Nl.parseObj(decompressLZ(commonNlBuf), commonNlTpl);

    const bgGma = bgName
      ? Gma.parseGma(bgGmaBuf, parseAVTpl(bgTplBuf, bgName))
      : { nameMap: new Map(), idMap: new Map() };

    return {
      stageInfo,
      stagedef,
      stageGma,
      bgGma,
      commonGma,
      ballCommonGma: ballCommonGma ?? commonGma,
      nlObj,
      stageNlObj: null,
      stageNlObjNameMap: null,
      gameSource,
    };
  }
}
