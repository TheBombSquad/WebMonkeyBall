import { ModelInst } from "./Model.js";
import * as Gma from "./Gma.js";
import { calcMipChain, TextureInputGX } from "../gx/gx_texture.js";
import { GfxDevice, GfxTexture } from "../gfx/platform/GfxPlatform.js";
import { assertExists } from "../util.js";
import { GXTextureMapping, loadTextureFromMipChain } from "../gx/gx_render.js";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache.js";
import { StageData } from "./World.js";
import { CommonModelID } from "./ModelInfo.js";
import * as UI from "../ui.js";
import * as Viewer from "../viewer.js";
import { GXMaterialHacks } from "../gx/gx_material.js";

// Cache loaded models by name and textures by unique name. Not much advantage over loading
// everything at once but oh well.

export class TextureCache {
    private cache: Map<string, GfxTexture> = new Map();

    public getTexture(device: GfxDevice, gxTexture: TextureInputGX): GfxTexture {
        const loadedTex = this.cache.get(gxTexture.name);
        if (loadedTex === undefined) {
            const mipChain = calcMipChain(gxTexture, gxTexture.mipCount);
            const freshTex = loadTextureFromMipChain(device, mipChain);
            this.cache.set(gxTexture.name, freshTex.gfxTexture);
            return freshTex.gfxTexture;
        }
        return loadedTex;
    }

    public destroy(device: GfxDevice): void {
        for (const loadedTex of this.cache.values())
            device.destroyTexture(loadedTex);
    }
}

class CacheEntry {
    public modelCache: Map<string, ModelInst>;

    constructor(public gma: Gma.Gma) {
        this.modelCache = new Map();
    }
}

export enum GmaSrc {
    Stage,
    Bg,
    Common,
    StageAndBg,
}

export class ModelCache {
    // Earlier appearance in this list is higher search precedence
    private stageEntry: CacheEntry;
    private bgEntry: CacheEntry;
    private commonEntry: CacheEntry;
    private allEntries: CacheEntry[];

    private textureCache: TextureCache;
    private goalTimerEntry: CacheEntry | null = null;

    private blueGoalModel: ModelInst | null = null;
    private greenGoalModel: ModelInst | null = null;
    private redGoalModel: ModelInst | null = null;
    private bumperModel: ModelInst | null = null;
    private jamabarModel: ModelInst | null = null;
    private wormholeModel: ModelInst | null = null;
    private wormholeSurfaceModel: ModelInst | null = null;

    constructor(private device: GfxDevice, private renderCache: GfxRenderCache, stageData: StageData) {
        this.stageEntry = new CacheEntry(stageData.stageGma);
        this.bgEntry = new CacheEntry(stageData.bgGma);
        this.commonEntry = new CacheEntry(stageData.commonGma);
        this.goalTimerEntry = stageData.goalTimerGma ? new CacheEntry(stageData.goalTimerGma) : null;
        this.allEntries = [this.stageEntry, this.bgEntry, this.commonEntry];
        this.textureCache = new TextureCache();

        // TODO(complexplane): Don't do these in modelcache?
        // TODO(complexplane): The game seems to search blue goal using "GOAL" prefix instead of 2
        // different names here, but when I do that it picks green goal for blue on Labyrinth
        // because GOAL_G comes before GOAL in the GMA. How does the game actually do it?!?
        const usesSmb2Models = stageData.gameSource === "smb2" || stageData.gameSource === "mb2ws";
        if (usesSmb2Models) {
            this.blueGoalModel = this.findModelBySubstring(["GOAL_B", "GOAL"]);
            this.greenGoalModel = this.findModelBySubstring(["GOAL_G"]);
            this.redGoalModel = this.findModelBySubstring(["GOAL_R"]);
        } else {
            this.blueGoalModel = this.findBgSpecificModel("GOAL") || this.findBgSpecificModel("GOAL_B");
            this.greenGoalModel = this.findBgSpecificModel("GOAL_G");
            this.redGoalModel = this.findBgSpecificModel("GOAL_R");
        }
        this.bumperModel = this.findBgSpecificModel("BUMPER_L1");
        this.jamabarModel =
            this.findModelBySubstring(["JAMABAR"]) ?? this.getModel(CommonModelID.mb_jamabar, GmaSrc.Common);
        if (usesSmb2Models) {
            this.wormholeModel = this.findModelBySubstring(["WORMHOLE"]);
            this.wormholeSurfaceModel = this.findModelBySubstring(["WORM_SURFACE"]);
        }
    }

    public fillTextureMappingFromGxTexture(gxTexture: TextureInputGX, mapping: GXTextureMapping): void {
        mapping.gfxTexture = this.textureCache.getTexture(this.device, gxTexture);
        mapping.width = gxTexture.width;
        mapping.height = gxTexture.height;
        mapping.flipY = false;
    }

    private findModelBySubstring(substrings: string[]): ModelInst | null {
        for (let i = 0; i < this.allEntries.length; i++) {
            const entry = this.allEntries[i];
            for (const gma of entry.gma.nameMap.values()) {
                if (substrings.some((substr) => gma.name.includes(substr))) {
                    return this.getModelFromEntry(gma.name, entry);
                }
            }
        }
        return null;
    }

    private findBgSpecificModel(postfix: string): ModelInst | null {
        for (let i = 0; i < this.allEntries.length; i++) {
            const entry = this.allEntries[i];
            for (const gma of entry.gma.idMap.values()) {
                if (gma.name.slice(4) === postfix) {
                    return this.getModelFromEntry(gma.name, entry);
                }
            }
        }
        return null;
    }

    private getModelFromEntry(model: string | number, entry: CacheEntry): ModelInst | null {
        let modelData: Gma.Model | undefined;
        if (typeof model === "number") {
            modelData = entry.gma.idMap.get(model);
        } else {
            modelData = entry.gma.nameMap.get(model);
        }
        if (modelData === undefined) {
            return null;
        }
        const modelInst = entry.modelCache.get(modelData.name);
        if (modelInst !== undefined) {
            return modelInst;
        }
        const freshModelInst = new ModelInst(this.device, this.renderCache, modelData, this.textureCache);
        entry.modelCache.set(modelData.name, freshModelInst);
        return freshModelInst;
    }

    public getModel(model: string | number, src: GmaSrc): ModelInst | null {
        switch (src) {
            case GmaSrc.Stage: {
                return this.getModelFromEntry(model, this.stageEntry);
            }
            case GmaSrc.Bg: {
                return this.getModelFromEntry(model, this.bgEntry);
            }
            case GmaSrc.Common: {
                return this.getModelFromEntry(model, this.commonEntry);
            }
            case GmaSrc.StageAndBg: {
                if (typeof model !== "string") {
                    throw new Error("Must request model by name when searching in multiple sources");
                }
                return this.getModelFromEntry(model, this.stageEntry) ?? this.getModelFromEntry(model, this.bgEntry);
            }
        }
    }

    private getEntriesForSrc(src: GmaSrc): CacheEntry[] {
        switch (src) {
            case GmaSrc.Stage:
                return [this.stageEntry];
            case GmaSrc.Bg:
                return [this.bgEntry];
            case GmaSrc.Common:
                return [this.commonEntry];
            case GmaSrc.StageAndBg:
                return [this.stageEntry, this.bgEntry];
            default:
                return [];
        }
    }

    public getModelNames(src: GmaSrc): string[] {
        const names: string[] = [];
        const seen = new Set<string>();
        for (const entry of this.getEntriesForSrc(src)) {
            for (const name of entry.gma.nameMap.keys()) {
                if (seen.has(name)) {
                    continue;
                }
                seen.add(name);
                names.push(name);
            }
        }
        return names;
    }

    // Screw it, don't make fancy generic prefix whatever lookup just for goals, just do it here

    public getBlueGoalModel(): ModelInst | null {
        return this.blueGoalModel;
    }

    public getGreenGoalModel(): ModelInst | null {
        return this.greenGoalModel;
    }

    public getRedGoalModel(): ModelInst | null {
        return this.redGoalModel;
    }

    public getBumperModel(): ModelInst | null {
        return this.bumperModel;
    }

    public getJamabarModel(): ModelInst | null {
        return this.jamabarModel;
    }

    public getGoalTimerDigitModel(size: "small" | "large", digit: number): ModelInst | null {
        const clampedDigit = Math.max(0, Math.min(9, digit | 0));
        const name = size === "small" ? `S_LCD_${clampedDigit}` : `L_LCD_${clampedDigit}`;
        const smb2IdBase = size === "small" ? 0x4e : 0x32;
        const id = smb2IdBase + clampedDigit;
        const goalTimerEntry = this.goalTimerEntry;
        if (goalTimerEntry) {
            return (
                this.getModelFromEntry(name, goalTimerEntry) ??
                this.getModelFromEntry(id, goalTimerEntry) ??
                this.getModel(name, GmaSrc.Common) ??
                this.getModel(id, GmaSrc.Common)
            );
        }
        return this.getModel(name, GmaSrc.Common) ?? this.getModel(id, GmaSrc.Common);
    }

    public getWormholeModel(): ModelInst | null {
        return this.wormholeModel;
    }

    public getWormholeSurfaceModel(): ModelInst | null {
        return this.wormholeSurfaceModel;
    }

    public setMaterialHacks(hacks: GXMaterialHacks): void {
        for (let i = 0; i < this.allEntries.length; i++) {
            for (const model of this.allEntries[i].modelCache.values()) {
                model.setMaterialHacks(hacks);
            }
        }
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.allEntries.length; i++) {
            this.allEntries[i].modelCache.forEach((model) => model.destroy(device));
        }
        this.goalTimerEntry?.modelCache.forEach((model) => model.destroy(device));
        this.textureCache.destroy(device);
    }
}
