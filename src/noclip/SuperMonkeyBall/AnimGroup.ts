import { mat4, vec3 } from "gl-matrix";
import { MathConstants, setMatrixTranslation, transformVec3Mat4w0, transformVec3Mat4w1 } from "../MathHelpers.js";
import { assertExists } from "../util.js";
import { interpolateKeyframes, loopWrap } from "./Anim.js";
import { ModelInst, RenderParams, RenderSort } from "./Model.js";
import { GmaSrc, ModelCache } from "./ModelCache.js";
import { CommonModelID } from "./ModelInfo.js";
import { RenderContext } from "./Render.js";
import type {
    BananaRenderState,
    GoalBagRenderState,
    GoalTapeRenderState,
    JamabarRenderState,
    SwitchRenderState,
} from "./Render.js";
import { StageId } from "./StageInfo.js";
import * as SD from "./Stagedef.js";
import { S16_TO_RADIANS } from "./Utils.js";
import { GoalBagModels, GoalTimerDigits, ModelInterface, StageData, WorldState } from "./World.js";
import { DynamicModelInst } from "./NaomiLib.js";
import { MatrixStack, atan2S16, sqrt, sumSq2 } from "../../math.js";
import * as GX from "../gx/gx_enum.js";
import type { GfxRenderInst } from "../gfx/render/GfxRenderInstManager.js";
import { BONUS_WAVE_MODEL_NAME, createBonusWaveMaterialHacks } from "./BonusWave.js";

type AnimGroupModelInstance = ModelInterface & {
    prepareToRenderCustom?: (
        ctx: RenderContext,
        renderParams: RenderParams,
        configureRenderInst: (renderInst: GfxRenderInst, renderParams: RenderParams) => void
    ) => void;
};

type AnimGroupModelEntry = {
    model: AnimGroupModelInstance;
    flags: number;
};

type StageModelResolver = (name: string) => AnimGroupModel | null;

export type AnimGroupRenderPerfStats = {
    enabled: boolean;
    groups: number;
    modelsMs: number;
    stageModelsMs: number;
    bananasMs: number;
    goalsMs: number;
    goalTapesMs: number;
    bumpersMs: number;
    jamabarsMs: number;
    wormholesMs: number;
    goalBagsMs: number;
    switchesMs: number;
    blurBridgeMs: number;
    modelsCount: number;
    stageModelsCount: number;
    bananasCount: number;
    goalsCount: number;
    goalTapesCount: number;
    bumpersCount: number;
    jamabarsCount: number;
    wormholesCount: number;
    goalBagsCount: number;
    switchesCount: number;
};

const scratchRenderParams = new RenderParams();
const scratchShadowParams = new RenderParams();

const scratchVec3a = vec3.create();
const scratchVec3b = vec3.create();
const scratchVec3c = vec3.create();
const scratchVec3d = vec3.create();
const scratchVec3e = vec3.create();
const scratchMat4a = mat4.create();
const scratchMat4b = mat4.create();
const scratchMat4c = mat4.create();
const goalTapeStack = new MatrixStack();
const goalTapeOffset = { x: 0, y: 0, z: 0 };

const scratchStageModelParams = new RenderParams();
const SMB2_STAGE_MODEL_VISIBILITY_MASK = 1;
const SWITCH_MODEL_NAMES = [
    "BUTTON_P",
    "BUTTON_S",
    "BUTTON_R",
    "BUTTON_FF",
    "BUTTON_FR",
];
const WORMHOLE_NEAR_FADE_INNER_RADIUS_SCALE = 0.8;
const WORMHOLE_NEAR_FADE_OUTER_RADIUS_SCALE = 2.0;
const WORMHOLE_FADE_SIDE_NORMAL_LOCAL = vec3.fromValues(0, 0, -1);
const animPerfNowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

class StageModelInst {
    private worldFromModel: mat4 = mat4.create();
    public readonly modelName: string;

    constructor(private model: ModelInst, instance: SD.StageModelInstance) {
        this.modelName = model.modelData.name;
        const rotRadians = scratchVec3a;
        vec3.scale(rotRadians, instance.rot, S16_TO_RADIANS);
        mat4.fromTranslation(this.worldFromModel, instance.pos);
        mat4.rotateZ(this.worldFromModel, this.worldFromModel, rotRadians[2]);
        mat4.rotateY(this.worldFromModel, this.worldFromModel, rotRadians[1]);
        mat4.rotateX(this.worldFromModel, this.worldFromModel, rotRadians[0]);
        mat4.scale(this.worldFromModel, this.worldFromModel, instance.scale);
    }

    public prepareToRender(state: WorldState, ctx: RenderContext, viewFromParent: mat4): void {
        const rp = scratchStageModelParams;
        rp.reset();
        rp.sort = RenderSort.None;
        rp.lighting = state.lighting;
        mat4.mul(rp.viewFromModel, viewFromParent, this.worldFromModel);
        this.model.prepareToRender(ctx, rp);
    }

    public prepareToRenderShadow(
        ctx: RenderContext,
        viewFromParent: mat4,
        renderParams: RenderParams,
        configureRenderInst: (renderInst: GfxRenderInst, renderParams: RenderParams) => void
    ): void {
        mat4.mul(renderParams.viewFromModel, viewFromParent, this.worldFromModel);
        this.model.prepareToRenderCustom(ctx, renderParams, configureRenderInst);
    }
}

export class AnimGroup {
    private models: AnimGroupModelEntry[];
    private stageModels: StageModelInst[] = [];
    private mirrorModels: ModelInst[] = [];
    private blurBridgeAccordionModel: ModelInst | null = null;
    private worldFromAg: mat4;
    private originFromAg: mat4;
    private agFromOrigin: mat4;
    private useExternalTransform = false;
    private agData: SD.AnimGroup;
    private bananas: Banana[];
    private bananaCollected: boolean[] | null = null;
    private goals: Goal[];
    private bumpers: Bumper[];
    private wormholes: Wormhole[];
    private goalBagModels: GoalBagModels;
    private goalTapeModel: DynamicModelInst | null;
    private bananaModelSingle: ModelInst | null = null;
    private bananaModelBunch: ModelInst | null = null;
    private jamabarModel: ModelInst | null = null;
    private switchModels: (ModelInst | null)[] = [];
    private switchModelFallback: ModelInst | null = null;

    // Current translation, needed directly for blur bridge
    private translation = vec3.create();
    private loopedTimeSeconds = 0;

    constructor(
        modelCache: ModelCache,
        private stageData: StageData,
        private animGroupIdx: number,
        goalTimerDigits: GoalTimerDigits | null,
        goalBagModels: GoalBagModels,
        goalTapeModel: DynamicModelInst | null,
        private resolveStageModel: StageModelResolver | null = null
    ) {
        this.agData = stageData.stagedef.animGroups[animGroupIdx];
        this.models = [];
        for (let i = 0; i < this.agData.animGroupModels.length; i++) {
            const entry = this.agData.animGroupModels[i];
            const name = entry.modelName;
            const modelInst = modelCache.getModel(name, GmaSrc.StageAndBg);
            if (modelInst !== null) {
                if (stageData.stageInfo.id === StageId.St092_Bonus_Wave && name === BONUS_WAVE_MODEL_NAME) {
                    modelInst.setMaterialHacks(createBonusWaveMaterialHacks());
                }
                this.models.push({ model: modelInst, flags: entry.flags });
                continue;
            }
            if (this.resolveStageModel) {
                const stageModel = this.resolveStageModel(name);
                if (stageModel) {
                    if (stageData.stageInfo.id === StageId.St092_Bonus_Wave && name === BONUS_WAVE_MODEL_NAME) {
                        stageModel.setMaterialHacks(createBonusWaveMaterialHacks());
                    }
                    this.models.push({ model: stageModel, flags: entry.flags });
                }
            }
        }
        if (this.agData.stageModelInstances && this.agData.stageModelInstances.length > 0) {
            const visibilityMask = this.stageData.gameSource === "smb2" ? SMB2_STAGE_MODEL_VISIBILITY_MASK : 0;
            for (const instance of this.agData.stageModelInstances) {
                if (visibilityMask !== 0 && ((instance.flags ?? 0) & visibilityMask) !== 0) {
                    continue;
                }
                if (!instance.modelName) {
                    continue;
                }
                const modelInst = modelCache.getModel(instance.modelName, GmaSrc.StageAndBg);
                if (modelInst !== null) {
                    this.stageModels.push(new StageModelInst(modelInst, instance));
                }
            }
        }
        if (this.agData.mirrorModelNames && this.agData.mirrorModelNames.length > 0) {
            for (const name of this.agData.mirrorModelNames) {
                const modelInst = modelCache.getModel(name, GmaSrc.StageAndBg);
                if (modelInst !== null) {
                    this.mirrorModels.push(modelInst);
                }
            }
        }

        this.worldFromAg = mat4.create();
        this.originFromAg = mat4.create();
        this.agFromOrigin = mat4.create();

        if (animGroupIdx > 0) {
            // Not in world space, animate
            mat4.fromXRotation(this.originFromAg, -this.agData.originRot[0] * S16_TO_RADIANS);
            mat4.rotateY(this.originFromAg, this.originFromAg, -this.agData.originRot[1] * S16_TO_RADIANS);
            mat4.rotateZ(this.originFromAg, this.originFromAg, -this.agData.originRot[2] * S16_TO_RADIANS);
            const negOrigin = scratchVec3a;
            vec3.negate(negOrigin, this.agData.originPos);
            mat4.translate(this.originFromAg, this.originFromAg, negOrigin);
        } else {
            // In world space
            mat4.identity(this.originFromAg);
            mat4.identity(this.worldFromAg);
        }
        if (!mat4.invert(this.agFromOrigin, this.originFromAg)) {
            mat4.identity(this.agFromOrigin);
        }

        this.bananas = this.agData.bananas.map((ban) => new Banana(modelCache, stageData, ban));
        this.goals = this.agData.goals.map((goal) => new Goal(modelCache, goal, goalTimerDigits));
        this.bumpers = this.agData.bumpers.map((bumper) => new Bumper(modelCache, bumper));
        this.wormholes = this.agData.wormholes.map((wormhole) => new Wormhole(modelCache, wormhole));
        this.jamabarModel = modelCache.getJamabarModel();

        const usesSmb2Models = stageData.gameSource === "smb2" || stageData.gameSource === "mb2ws";
        const singleName = "OBJ_BANANA_01_LOD150";
        const bunchName = "OBJ_BANANA_02_LOD100";
        this.bananaModelSingle =
            (usesSmb2Models ? modelCache.getModel(singleName, GmaSrc.Common) : null) ??
            modelCache.getModel(CommonModelID.OBJ_BANANA_01_LOD150, GmaSrc.Common);
        this.bananaModelBunch =
            (usesSmb2Models ? modelCache.getModel(bunchName, GmaSrc.Common) : null) ??
            modelCache.getModel(CommonModelID.OBJ_BANANA_02_LOD100, GmaSrc.Common);

        if (stageData.gameSource === "smb2" || stageData.gameSource === "mb2ws") {
            this.switchModels = SWITCH_MODEL_NAMES.map((name) => modelCache.getModel(name, GmaSrc.Stage));
            for (let i = 0; i < this.switchModels.length; i++) {
                if (this.switchModels[i]) {
                    this.switchModelFallback = this.switchModels[i];
                    break;
                }
            }
        }
        this.goalBagModels = goalBagModels;
        this.goalTapeModel = goalTapeModel;

        if (stageData.stageInfo.id === StageId.St101_Blur_Bridge) {
            this.blurBridgeAccordionModel = assertExists(modelCache.getModel("MOT_STAGE101_BLUR", GmaSrc.StageAndBg));
        }
    }

    public setBananaCollected(collectedByIndex: boolean[]): void {
        this.bananaCollected = collectedByIndex;
    }

    public update(state: WorldState): void {
        if (this.animGroupIdx > 0) {
            const loopStart = this.agData.loopStartSeconds ?? this.stageData.stagedef.loopStartSeconds;
            const loopEnd = this.agData.loopEndSeconds ?? this.stageData.stagedef.loopEndSeconds;
            if (loopEnd > loopStart) {
                this.loopedTimeSeconds = loopWrap(
                    state.time.getAnimTimeSeconds(),
                    loopStart,
                    loopEnd
                );
            } else {
                this.loopedTimeSeconds = state.time.getAnimTimeSeconds();
            }

            // Use initial values if there are no corresponding keyframes
            vec3.copy(this.translation, this.agData.originPos);
            const rotRadians = scratchVec3b;
            vec3.scale(rotRadians, this.agData.originRot, S16_TO_RADIANS);
            const anim = this.agData.anim;

            if (anim !== null) {
                if (anim.posXKeyframes.length !== 0) {
                    this.translation[0] = interpolateKeyframes(this.loopedTimeSeconds, anim.posXKeyframes);
                }
                if (anim.posYKeyframes.length !== 0) {
                    this.translation[1] = interpolateKeyframes(this.loopedTimeSeconds, anim.posYKeyframes);
                }
                if (anim.posZKeyframes.length !== 0) {
                    this.translation[2] = interpolateKeyframes(this.loopedTimeSeconds, anim.posZKeyframes);
                }
                if (anim.rotXKeyframes.length !== 0) {
                    rotRadians[0] =
                        interpolateKeyframes(this.loopedTimeSeconds, anim.rotXKeyframes) * MathConstants.DEG_TO_RAD;
                }
                if (anim.rotYKeyframes.length !== 0) {
                    rotRadians[1] =
                        interpolateKeyframes(this.loopedTimeSeconds, anim.rotYKeyframes) * MathConstants.DEG_TO_RAD;
                }
                if (anim.rotZKeyframes.length !== 0) {
                    rotRadians[2] =
                        interpolateKeyframes(this.loopedTimeSeconds, anim.rotZKeyframes) * MathConstants.DEG_TO_RAD;
                }
            }

            if (!this.useExternalTransform) {
                mat4.fromTranslation(this.worldFromAg, this.translation);
                mat4.rotateZ(this.worldFromAg, this.worldFromAg, rotRadians[2]);
                mat4.rotateY(this.worldFromAg, this.worldFromAg, rotRadians[1]);
                mat4.rotateX(this.worldFromAg, this.worldFromAg, rotRadians[0]);
                mat4.mul(this.worldFromAg, this.worldFromAg, this.originFromAg);
            }
        }

        for (let i = 0; i < this.bananas.length; i++) {
            this.bananas[i].update(state);
        }
        for (let i = 0; i < this.bumpers.length; i++) {
            this.bumpers[i].update(state);
        }
    }

    public setExternalTransform(src: Float32Array | null): void {
        if (src === null) {
            this.useExternalTransform = false;
            return;
        }
        mat4.set(this.worldFromAg,
            src[0], src[4], src[8], 0,
            src[1], src[5], src[9], 0,
            src[2], src[6], src[10], 0,
            src[3], src[7], src[11], 1
        );
        this.useExternalTransform = true;
    }

    private drawBlurBridgeAccordion(state: WorldState, ctx: RenderContext, viewFromWorld: mat4): void {
        if (
            this.blurBridgeAccordionModel === null ||
            this.animGroupIdx === 0 ||
            this.agData.animGroupModels.length === 0 ||
            this.agData.anim === null
        ) {
            return;
        }

        const rp = scratchRenderParams;
        rp.reset();
        rp.lighting = state.lighting;

        const accordionPos = scratchVec3a;
        vec3.copy(accordionPos, this.translation);

        const prevX = interpolateKeyframes(this.loopedTimeSeconds - 0.5, this.agData.anim.posXKeyframes);
        const flip = prevX >= accordionPos[0];
        const deltaX = Math.abs(prevX - accordionPos[0]);
        accordionPos[0] = (accordionPos[0] + prevX) / 2 + (flip ? 1 : -1);

        mat4.translate(rp.viewFromModel, viewFromWorld, accordionPos);
        if (flip) {
            mat4.rotateY(rp.viewFromModel, rp.viewFromModel, Math.PI);
        }

        const scale = scratchVec3a;
        vec3.set(scale, deltaX / 2, 1, 1);
        mat4.scale(rp.viewFromModel, rp.viewFromModel, scale);

        this.blurBridgeAccordionModel.prepareToRender(ctx, rp);
    }

    public prepareToRender(
        state: WorldState,
        ctx: RenderContext,
        bananas?: BananaRenderState[],
        jamabars?: JamabarRenderState[],
        goalBags?: GoalBagRenderState[],
        goalTapes?: GoalTapeRenderState[],
        switches?: SwitchRenderState[],
        viewFromWorld: mat4 = ctx.viewerInput.camera.viewMatrix,
        viewFromWorldBase: mat4 = viewFromWorld,
        tiltParams: { rotX: number; rotZ: number; pivot: vec3 } | null = null,
        skipModelNames?: Set<string>,
        perfStats?: AnimGroupRenderPerfStats
    ) {
        const perf = perfStats;
        const perfEnabled = !!perf?.enabled;
        let perfPhaseStart = perfEnabled ? animPerfNowMs() : 0;

        const rp = scratchRenderParams;
        rp.reset();
        rp.lighting = state.lighting;
        const textureScroll = this.agData.textureScroll;
        if (textureScroll && (this.stageData.gameSource === "smb2" || this.stageData.gameSource === "mb2ws")) {
            const timeSeconds = state.time.getAnimTimeSeconds();
            vec3.set(scratchVec3b, textureScroll.speed[0] * timeSeconds, textureScroll.speed[1] * timeSeconds, 0);
            mat4.fromTranslation(rp.texMtx, scratchVec3b);
        }

        const viewFromAnimGroup = scratchMat4a;
        mat4.mul(viewFromAnimGroup, viewFromWorld, this.worldFromAg);
        mat4.copy(rp.viewFromModel, viewFromAnimGroup);

        for (let i = 0; i < this.models.length; i++) {
            const entry = this.models[i];
            const model = entry.model;
            if (ctx.mirrorCapture && (entry.flags & (1 << 2)) === 0) {
                continue;
            }
            if (skipModelNames && model instanceof ModelInst && skipModelNames.has(model.modelData.name)) {
                continue;
            }
            model.prepareToRender(ctx, rp);
        }
        if (perfEnabled && perf) {
            const nowMs = animPerfNowMs();
            perf.modelsMs += nowMs - perfPhaseStart;
            perf.modelsCount += this.models.length;
            perfPhaseStart = nowMs;
        }
        let stageModelsCount = 0;
        for (let i = 0; i < this.stageModels.length; i++) {
            if (skipModelNames && skipModelNames.has(this.stageModels[i].modelName)) {
                continue;
            }
            this.stageModels[i].prepareToRender(state, ctx, viewFromAnimGroup);
            stageModelsCount += 1;
        }
        if (perfEnabled && perf) {
            const nowMs = animPerfNowMs();
            perf.stageModelsMs += nowMs - perfPhaseStart;
            perf.stageModelsCount += stageModelsCount;
            perfPhaseStart = nowMs;
        }
        let bananasCount = 0;
        if (bananas) {
            bananasCount = bananas.length;
            this.drawBananas(state, ctx, viewFromAnimGroup, bananas, viewFromWorldBase, tiltParams);
        } else {
            for (let i = 0; i < this.bananas.length; i++) {
                if (this.bananaCollected?.[i]) continue;
                this.bananas[i].prepareToRender(state, ctx, viewFromAnimGroup, viewFromWorld);
                bananasCount += 1;
            }
        }
        if (perfEnabled && perf) {
            const nowMs = animPerfNowMs();
            perf.bananasMs += nowMs - perfPhaseStart;
            perf.bananasCount += bananasCount;
            perfPhaseStart = nowMs;
        }
        for (let i = 0; i < this.goals.length; i++) {
            this.goals[i].prepareToRender(state, ctx, viewFromAnimGroup);
        }
        if (perfEnabled && perf) {
            const nowMs = animPerfNowMs();
            perf.goalsMs += nowMs - perfPhaseStart;
            perf.goalsCount += this.goals.length;
            perfPhaseStart = nowMs;
        }
        this.drawGoalTapes(state, ctx, viewFromAnimGroup, goalTapes);
        if (perfEnabled && perf) {
            const nowMs = animPerfNowMs();
            perf.goalTapesMs += nowMs - perfPhaseStart;
            perf.goalTapesCount += goalTapes?.length ?? 0;
            perfPhaseStart = nowMs;
        }
        for (let i = 0; i < this.bumpers.length; i++) {
            this.bumpers[i].prepareToRender(state, ctx, viewFromAnimGroup);
        }
        if (perfEnabled && perf) {
            const nowMs = animPerfNowMs();
            perf.bumpersMs += nowMs - perfPhaseStart;
            perf.bumpersCount += this.bumpers.length;
            perfPhaseStart = nowMs;
        }
        this.drawJamabars(state, ctx, viewFromAnimGroup, jamabars);
        if (perfEnabled && perf) {
            const nowMs = animPerfNowMs();
            perf.jamabarsMs += nowMs - perfPhaseStart;
            perf.jamabarsCount += jamabars?.length ?? 0;
            perfPhaseStart = nowMs;
        }
        for (let i = 0; i < this.wormholes.length; i++) {
            this.wormholes[i].prepareToRender(state, ctx, viewFromAnimGroup);
        }
        if (perfEnabled && perf) {
            const nowMs = animPerfNowMs();
            perf.wormholesMs += nowMs - perfPhaseStart;
            perf.wormholesCount += this.wormholes.length;
            perfPhaseStart = nowMs;
        }
        this.drawGoalBags(state, ctx, viewFromAnimGroup, goalBags);
        if (perfEnabled && perf) {
            const nowMs = animPerfNowMs();
            perf.goalBagsMs += nowMs - perfPhaseStart;
            perf.goalBagsCount += goalBags?.length ?? 0;
            perfPhaseStart = nowMs;
        }
        this.drawSwitches(state, ctx, viewFromAnimGroup, switches);
        if (perfEnabled && perf) {
            const nowMs = animPerfNowMs();
            perf.switchesMs += nowMs - perfPhaseStart;
            perf.switchesCount += switches?.length ?? 0;
            perfPhaseStart = nowMs;
        }
        this.drawBlurBridgeAccordion(state, ctx, viewFromWorld);
        if (perfEnabled && perf) {
            const nowMs = animPerfNowMs();
            perf.blurBridgeMs += nowMs - perfPhaseStart;
            perf.groups += 1;
        }
    }

    public prepareToRenderMirrors(
        state: WorldState,
        ctx: RenderContext,
        viewFromWorld: mat4,
        configureRenderInst: (renderInst: GfxRenderInst, renderParams: RenderParams) => void
    ): void {
        if (this.mirrorModels.length === 0) {
            return;
        }
        const rp = scratchRenderParams;
        rp.reset();
        rp.sort = RenderSort.None;
        rp.lighting = state.lighting;

        const viewFromAnimGroup = scratchMat4a;
        mat4.mul(viewFromAnimGroup, viewFromWorld, this.worldFromAg);
        mat4.copy(rp.viewFromModel, viewFromAnimGroup);

        for (let i = 0; i < this.mirrorModels.length; i++) {
            this.mirrorModels[i].prepareToRenderCustom?.(ctx, rp, configureRenderInst);
        }
    }

    public getWorldFromAg(): mat4 {
        return this.worldFromAg;
    }

    public getWorldFromAgNoOrigin(out: mat4): mat4 {
        mat4.mul(out, this.worldFromAg, this.agFromOrigin);
        return out;
    }

    public prepareToRenderShadow(
        ctx: RenderContext,
        viewFromWorld: mat4,
        configureRenderInst: (renderInst: GfxRenderInst, renderParams: RenderParams) => void
    ): void {
        const rp = scratchShadowParams;
        rp.reset();
        rp.sort = RenderSort.Translucent;
        rp.depthOffset = 10000;

        const viewFromAnimGroup = scratchMat4a;
        mat4.mul(viewFromAnimGroup, viewFromWorld, this.worldFromAg);
        mat4.copy(rp.viewFromModel, viewFromAnimGroup);

        for (let i = 0; i < this.models.length; i++) {
            const entry = this.models[i];
            const model = entry.model;
            if (model.prepareToRenderCustom) {
                model.prepareToRenderCustom(ctx, rp, configureRenderInst);
            }
        }
        for (let i = 0; i < this.stageModels.length; i++) {
            this.stageModels[i].prepareToRenderShadow(ctx, viewFromAnimGroup, rp, configureRenderInst);
        }
    }

    private drawBananas(
        state: WorldState,
        ctx: RenderContext,
        viewFromAnimGroup: mat4,
        bananas: BananaRenderState[],
        viewFromWorldBase: mat4,
        tiltParams: { rotX: number; rotZ: number; pivot: vec3 } | null
    ): void {
        if (bananas.length === 0) {
            return;
        }
        const rp = scratchRenderParams;
        for (const banana of bananas) {
            if (!banana.visible) {
                continue;
            }
            const model = (banana.type & 1) === 1 ? this.bananaModelBunch : this.bananaModelSingle;
            if (!model) {
                continue;
            }
            let viewFromAg = viewFromAnimGroup;
            const tiltFactor = banana.tiltFactor ?? 1;
            if (tiltParams && tiltFactor < 1) {
                const rotX = tiltParams.rotX * tiltFactor;
                const rotZ = tiltParams.rotZ * tiltFactor;
                mat4.copy(scratchMat4b, viewFromWorldBase);
                if (rotX !== 0 || rotZ !== 0) {
                    mat4.translate(scratchMat4b, scratchMat4b, tiltParams.pivot);
                    mat4.rotateX(scratchMat4b, scratchMat4b, rotX);
                    mat4.rotateZ(scratchMat4b, scratchMat4b, rotZ);
                    vec3.negate(scratchVec3b, tiltParams.pivot);
                    mat4.translate(scratchMat4b, scratchMat4b, scratchVec3b);
                }
                mat4.mul(scratchMat4c, scratchMat4b, this.worldFromAg);
                viewFromAg = scratchMat4c;
            } else if (tiltFactor >= 1) {
                viewFromAg = viewFromAnimGroup;
            } else {
                mat4.mul(scratchMat4c, viewFromWorldBase, this.worldFromAg);
                viewFromAg = scratchMat4c;
            }
            rp.reset();
            rp.sort = RenderSort.None;
            rp.lighting = state.lighting;
            vec3.set(scratchVec3d, banana.pos.x, banana.pos.y, banana.pos.z);
            mat4.translate(rp.viewFromModel, viewFromAg, scratchVec3d);
            mat4.rotateY(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * banana.rotY);
            mat4.rotateX(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * banana.rotX);
            mat4.rotateZ(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * banana.rotZ);
            if (banana.scale !== 1) {
                vec3.set(scratchVec3e, banana.scale, banana.scale, banana.scale);
                mat4.scale(rp.viewFromModel, rp.viewFromModel, scratchVec3e);
            }
            model.prepareToRender(ctx, rp);
        }
    }

    private drawGoalBags(
        state: WorldState,
        ctx: RenderContext,
        viewFromAnimGroup: mat4,
        goalBags: GoalBagRenderState[] | undefined
    ): void {
        if (!goalBags || goalBags.length === 0) {
            return;
        }
        const closedModel = this.goalBagModels.closed;
        const openModelA = this.goalBagModels.openA;
        const openModelB = this.goalBagModels.openB;
        if (!closedModel && !openModelA && !openModelB) {
            return;
        }

        const rp = scratchRenderParams;
        for (const bag of goalBags) {
            rp.reset();
            rp.sort = RenderSort.All;
            rp.lighting = state.lighting;

            vec3.set(scratchVec3d, bag.uSomePos.x, bag.uSomePos.y, bag.uSomePos.z);
            mat4.translate(rp.viewFromModel, viewFromAnimGroup, scratchVec3d);
            mat4.rotateY(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * bag.rotY);
            mat4.rotateX(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * bag.rotX);
            mat4.rotateZ(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * bag.rotZ);

            if (bag.openness <= 0 || !openModelA || !openModelB) {
                closedModel?.prepareToRender(ctx, rp);
                continue;
            }

            const base = scratchMat4c;
            mat4.copy(base, rp.viewFromModel);
            vec3.set(scratchVec3e, 0, -0.5 * bag.openness, 0);
            mat4.translate(base, base, scratchVec3e);

            const rotZ = 9102 * bag.openness;
            mat4.copy(rp.viewFromModel, base);
            mat4.rotateZ(rp.viewFromModel, rp.viewFromModel, -S16_TO_RADIANS * rotZ);
            openModelA.prepareToRender(ctx, rp);

            mat4.copy(rp.viewFromModel, base);
            mat4.rotateZ(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * rotZ);
            openModelB.prepareToRender(ctx, rp);
        }
    }

    private drawGoalTapes(
        state: WorldState,
        ctx: RenderContext,
        viewFromAnimGroup: mat4,
        goalTapes: GoalTapeRenderState[] | undefined
    ): void {
        if (!goalTapes || goalTapes.length === 0 || !this.goalTapeModel) {
            return;
        }
        const rp = scratchRenderParams;
        for (const tape of goalTapes) {
            rp.reset();
            rp.sort = RenderSort.None;
            rp.lighting = state.lighting;

            const base = scratchMat4b;
            vec3.set(scratchVec3d, tape.pos.x, tape.pos.y, tape.pos.z);
            mat4.translate(base, viewFromAnimGroup, scratchVec3d);
            mat4.rotateZ(base, base, S16_TO_RADIANS * tape.rot.z);
            mat4.rotateY(base, base, S16_TO_RADIANS * tape.rot.y);
            mat4.rotateX(base, base, S16_TO_RADIANS * tape.rot.x);
            mat4.copy(rp.viewFromModel, base);

            this.goalTapeModel.draw(ctx, rp, (ddraw, kind) => {
                const points = tape.points;
                let idx = 0;
                while (idx < points.length) {
                    let end = idx;
                    while (end < points.length - 1 && (points[end].flags & 4) !== 0) {
                        end += 1;
                    }
                    if (end > idx) {
                        ddraw.begin(GX.Command.DRAW_TRIANGLE_STRIP);
                        for (let i = idx; i <= end; i += 1) {
                            const point = points[i];
                            const rotY = atan2S16(point.normal.x, point.normal.z) - 0x8000;
                            const rotX = atan2S16(point.normal.y, sqrt(sumSq2(point.normal.x, point.normal.z)));
                            goalTapeStack.fromRotateY(rotY);
                            goalTapeStack.rotateX(rotX);
                            goalTapeOffset.x = 0;
                            goalTapeOffset.y = 0.125;
                            goalTapeOffset.z = 0;
                            goalTapeStack.tfVec(goalTapeOffset, goalTapeOffset);

                            const nx = point.normal.x;
                            const ny = point.normal.y;
                            const nz = point.normal.z;
                            const s = point.t;
                            const px = point.pos.x;
                            const py = point.pos.y;
                            const pz = point.pos.z;

                            ddraw.position3f32(px + goalTapeOffset.x, py + goalTapeOffset.y, pz + goalTapeOffset.z);
                            if (kind === "A") {
                                ddraw.color4rgba8(GX.Attr.CLR0, 255, 255, 255, 255);
                            } else {
                                ddraw.normal3f32(nx, ny, nz);
                            }
                            ddraw.texCoord2f32(GX.Attr.TEX0, s, 1.0);

                            ddraw.position3f32(px - goalTapeOffset.x, py - goalTapeOffset.y, pz - goalTapeOffset.z);
                            if (kind === "A") {
                                ddraw.color4rgba8(GX.Attr.CLR0, 255, 255, 255, 255);
                            } else {
                                ddraw.normal3f32(nx, ny, nz);
                            }
                            ddraw.texCoord2f32(GX.Attr.TEX0, s, 0.0);
                        }
                        ddraw.end();
                    }
                    idx = end + 1;
                }
            }, tape.index ?? 0);
        }
    }

    private drawSwitches(
        state: WorldState,
        ctx: RenderContext,
        viewFromAnimGroup: mat4,
        switches: SwitchRenderState[] | undefined
    ): void {
        if (!switches || switches.length === 0 || this.switchModels.length === 0) {
            return;
        }
        const rp = scratchRenderParams;
        for (const sw of switches) {
            const model = this.switchModels[sw.type & 7] ?? this.switchModelFallback;
            if (!model) {
                continue;
            }
            rp.reset();
            rp.lighting = state.lighting;
            vec3.set(scratchVec3d, sw.pos.x, sw.pos.y, sw.pos.z);
            mat4.translate(rp.viewFromModel, viewFromAnimGroup, scratchVec3d);
            mat4.rotateZ(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * sw.rotZ);
            mat4.rotateY(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * sw.rotY);
            mat4.rotateX(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * sw.rotX);
            model.prepareToRender(ctx, rp);
        }
    }

    private drawJamabars(
        state: WorldState,
        ctx: RenderContext,
        viewFromAnimGroup: mat4,
        jamabars: JamabarRenderState[] | undefined
    ) {
        if (!jamabars || jamabars.length === 0 || !this.jamabarModel) {
            return;
        }
        const rp = scratchRenderParams;
        for (const jamabar of jamabars) {
            rp.reset();
            rp.lighting = state.lighting;
            vec3.set(scratchVec3d, jamabar.pos.x, jamabar.pos.y, jamabar.pos.z);
            mat4.translate(rp.viewFromModel, viewFromAnimGroup, scratchVec3d);
            mat4.rotateZ(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * jamabar.rot.z);
            mat4.rotateY(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * jamabar.rot.y);
            mat4.rotateX(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * jamabar.rot.x);
            vec3.set(scratchVec3e, jamabar.scale.x, jamabar.scale.y, jamabar.scale.z);
            mat4.scale(rp.viewFromModel, rp.viewFromModel, scratchVec3e);
            this.jamabarModel.prepareToRender(ctx, rp);
        }
    }
}


class Banana {
    private model: ModelInst;
    private yRotRadians: number = 0;

    constructor(modelCache: ModelCache, stageData: StageData, private bananaData: SD.Banana) {
        const modelId =
            bananaData.type === SD.BananaType.Single
                ? CommonModelID.OBJ_BANANA_01_LOD150
                : CommonModelID.OBJ_BANANA_02_LOD100;
        const usesSmb2Models = stageData.gameSource === 'smb2' || stageData.gameSource === 'mb2ws';
        const modelName =
            bananaData.type === SD.BananaType.Single ? "OBJ_BANANA_01_LOD150" : "OBJ_BANANA_02_LOD100";
        const model =
            (usesSmb2Models ? modelCache.getModel(modelName, GmaSrc.Common) : null) ??
            modelCache.getModel(modelId, GmaSrc.Common);
        this.model = assertExists(model);
    }

    public update(state: WorldState): void {
        const incRadians = S16_TO_RADIANS * (this.bananaData.type === SD.BananaType.Single ? 1024 : 768);
        this.yRotRadians += incRadians * state.time.getDeltaTimeFrames();
        this.yRotRadians %= 2 * Math.PI;
    }

    public prepareToRender(
        state: WorldState,
        ctx: RenderContext,
        viewFromAnimGroup: mat4,
        viewFromWorld: mat4
    ): void {
        const rp = scratchRenderParams;
        rp.reset();
        rp.sort = RenderSort.None;
        rp.lighting = state.lighting;

        // Bananas' positions are parented to their anim group, but they have a global rotation in
        // world space
        mat4.rotateY(rp.viewFromModel, viewFromWorld, this.yRotRadians);
        const posViewSpace = scratchVec3c;
        transformVec3Mat4w1(posViewSpace, viewFromAnimGroup, this.bananaData.pos);
        setMatrixTranslation(rp.viewFromModel, posViewSpace);

        this.model.prepareToRender(ctx, rp);
    }
}

class Goal {
    private model: ModelInst;
    private timerDigits: GoalTimerDigits | null;

    constructor(modelCache: ModelCache, private goalData: SD.Goal, goalTimerDigits: GoalTimerDigits | null) {
        if (goalData.type === SD.GoalType.Blue) {
            this.model = assertExists(modelCache.getBlueGoalModel());
        } else if (goalData.type === SD.GoalType.Green) {
            this.model = assertExists(modelCache.getGreenGoalModel());
        } else {
            // Red goal
            this.model = assertExists(modelCache.getRedGoalModel());
        }
        this.timerDigits = goalTimerDigits;
    }

    public prepareToRender(state: WorldState, ctx: RenderContext, viewFromAnimGroup: mat4): void {
        const rp = scratchRenderParams;
        rp.reset();
        rp.lighting = state.lighting;

        mat4.translate(rp.viewFromModel, viewFromAnimGroup, this.goalData.pos);
        mat4.rotateZ(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * this.goalData.rot[2]);
        mat4.rotateY(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * this.goalData.rot[1]);
        mat4.rotateX(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * this.goalData.rot[0]);

        this.model.prepareToRender(ctx, rp);
        this.drawTimer(state, ctx, viewFromAnimGroup);
    }

    private drawTimer(state: WorldState, ctx: RenderContext, viewFromAnimGroup: mat4): void {
        if (!this.timerDigits) {
            return;
        }
        const stageTimeFrames = state.time.getStageTimeFrames();
        let time = Math.floor((stageTimeFrames * 100) / 60);
        if (time < 0) {
            time = 0;
        }

        const base = scratchMat4b;
        mat4.translate(base, viewFromAnimGroup, this.goalData.pos);
        mat4.rotateZ(base, base, S16_TO_RADIANS * this.goalData.rot[2]);
        mat4.rotateY(base, base, S16_TO_RADIANS * this.goalData.rot[1]);
        mat4.rotateX(base, base, S16_TO_RADIANS * this.goalData.rot[0]);

        const rp = scratchRenderParams;
        rp.reset();
        rp.sort = RenderSort.None;
        rp.lighting = state.lighting;

        const smallOffsetX = -0.45;
        const largeOffsetX = -0.6666;

        let digit = time % 10;
        time = Math.floor(time / 10);
        this.drawTimerDigit(ctx, rp, base, this.timerDigits.small[digit], 0);

        digit = time % 10;
        time = Math.floor(time / 10);
        this.drawTimerDigit(ctx, rp, base, this.timerDigits.small[digit], smallOffsetX);

        for (let i = 0; i < 3; i++) {
            digit = time % 10;
            time = Math.floor(time / 10);
            this.drawTimerDigit(ctx, rp, base, this.timerDigits.large[digit], largeOffsetX * i);
        }
    }

    private drawTimerDigit(
        ctx: RenderContext,
        rp: RenderParams,
        base: mat4,
        model: ModelInterface | null,
        offsetX: number
    ): void {
        if (!model) {
            return;
        }
        mat4.copy(rp.viewFromModel, base);
        if (offsetX !== 0) {
            vec3.set(scratchVec3e, offsetX, 0, 0);
            mat4.translate(rp.viewFromModel, rp.viewFromModel, scratchVec3e);
        }
        model.prepareToRender(ctx, rp);
    }
}

class Bumper {
    private model: ModelInst;
    private yRotRadians: number = 0;
    private baseFromBumper = mat4.create();

    constructor(modelCache: ModelCache, private bumperData: SD.Bumper) {
        this.model = assertExists(modelCache.getBumperModel());
        mat4.fromTranslation(this.baseFromBumper, this.bumperData.pos);
        mat4.rotateZ(this.baseFromBumper, this.baseFromBumper, S16_TO_RADIANS * this.bumperData.rot[2]);
        mat4.rotateY(this.baseFromBumper, this.baseFromBumper, S16_TO_RADIANS * this.bumperData.rot[1]);
        mat4.rotateX(this.baseFromBumper, this.baseFromBumper, S16_TO_RADIANS * this.bumperData.rot[0]);
        mat4.scale(this.baseFromBumper, this.baseFromBumper, this.bumperData.scale);
    }

    public update(state: WorldState): void {
        const incRadians = S16_TO_RADIANS * 0x100;
        this.yRotRadians += incRadians * state.time.getDeltaTimeFrames();
        this.yRotRadians %= 2 * Math.PI;
    }

    public prepareToRender(state: WorldState, ctx: RenderContext, viewFromAnimGroup: mat4): void {
        const rp = scratchRenderParams;
        rp.reset();
        rp.lighting = state.lighting;

        mat4.mul(rp.viewFromModel, viewFromAnimGroup, this.baseFromBumper);
        mat4.rotateY(rp.viewFromModel, rp.viewFromModel, this.yRotRadians);

        this.model.prepareToRender(ctx, rp);
    }
}

class Wormhole {
    private model: ModelInst | null;
    private surfaceModel: ModelInst | null;

    constructor(modelCache: ModelCache, private wormholeData: SD.Wormhole) {
        this.model = modelCache.getWormholeModel();
        this.surfaceModel = modelCache.getWormholeSurfaceModel();
    }

    private computeNearCameraAlpha(viewFromModel: mat4): number {
        const refModel = this.surfaceModel ?? this.model;
        if (!refModel) {
            return 1;
        }
        const centerView = scratchVec3a;
        const sideNormalView = scratchVec3b;
        transformVec3Mat4w1(centerView, viewFromModel, refModel.modelData.boundSphereCenter);
        transformVec3Mat4w0(sideNormalView, viewFromModel, WORMHOLE_FADE_SIDE_NORMAL_LOCAL);
        if (vec3.squaredLength(sideNormalView) > 1e-8) {
            vec3.normalize(sideNormalView, sideNormalView);
            const sideDot =
                -centerView[0] * sideNormalView[0] -
                centerView[1] * sideNormalView[1] -
                centerView[2] * sideNormalView[2];
            if (sideDot >= 0.0) {
                // Camera is on the portal's front side; keep it opaque.
                return 1;
            }
        }
        const dist = vec3.length(centerView);
        const radius = Math.max(refModel.modelData.boundSphereRadius, 1e-3);
        const fadeStart = radius * WORMHOLE_NEAR_FADE_INNER_RADIUS_SCALE;
        const fadeEnd = radius * WORMHOLE_NEAR_FADE_OUTER_RADIUS_SCALE;
        if (dist <= fadeStart) {
            return 0;
        }
        if (dist >= fadeEnd) {
            return 1;
        }
        return (dist - fadeStart) / Math.max(fadeEnd - fadeStart, 1e-6);
    }

    public prepareToRender(state: WorldState, ctx: RenderContext, viewFromAnimGroup: mat4): void {
        if (!this.model && !this.surfaceModel) {
            return;
        }
        const wormholeId = this.wormholeData.wormholeId;
        if (wormholeId !== undefined && ctx.skipWormholeIds?.has(wormholeId)) {
            return;
        }
        const rp = scratchRenderParams;
        rp.reset();
        rp.lighting = state.lighting;

        mat4.translate(rp.viewFromModel, viewFromAnimGroup, this.wormholeData.pos);
        mat4.rotateZ(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * this.wormholeData.rot[2]);
        mat4.rotateY(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * this.wormholeData.rot[1]);
        mat4.rotateX(rp.viewFromModel, rp.viewFromModel, S16_TO_RADIANS * this.wormholeData.rot[0]);

        const base = scratchMat4b;
        mat4.copy(base, rp.viewFromModel);
        const nearAlpha = this.computeNearCameraAlpha(base);
        const disableDepthWriteForFade = nearAlpha < 0.999;
        if (!ctx.wormholeCapture) {
            rp.alpha = nearAlpha;
            rp.megaStateFlags = disableDepthWriteForFade ? { depthWrite: false } : undefined;
            this.model?.prepareToRender(ctx, rp);
        }
        if (!ctx.skipWormholeSurfaces && this.surfaceModel) {
            mat4.copy(rp.viewFromModel, base);
            rp.alpha = nearAlpha;
            rp.megaStateFlags = disableDepthWriteForFade ? { depthWrite: false } : undefined;
            this.surfaceModel.prepareToRender(ctx, rp);
        }
    }
}
