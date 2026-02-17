import { RenderContext } from "./Render.js";
import { BgObjectInst } from "./BgObject.js";
import { ModelInst, RenderParams, RenderSort } from "./Model.js";
import { mat4, vec3 } from "gl-matrix";
import { Vec3NegZ, Vec3Zero, transformVec3Mat4w0, transformVec3Mat4w1 } from "../MathHelpers.js";
import { getMat4RotY, S16_TO_RADIANS } from "./Utils.js";
import { Lighting } from "./Lighting.js";
import { BgNightModelID, BgStormModelID } from "./ModelInfo.js";
import { GmaSrc, ModelCache } from "./ModelCache.js";
import { Gma } from "./Gma.js";
import { assertExists, nArray } from "../util.js";
import { WorldState } from "./World.js";
import {
    GfxBlendFactor,
    GfxBlendMode,
    GfxChannelWriteMask,
    GfxCompareMode,
    GfxCullMode,
    GfxMipFilterMode,
    type GfxProgram,
    GfxTexFilterMode,
} from "../gfx/platform/GfxPlatform.js";
import { makeMegaState, setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers.js";
import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary.js";
import { preprocessProgram_GLSL } from "../gfx/shaderc/GfxShaderCompiler.js";
import { fillMatrix4x4, fillVec4 } from "../gfx/helpers/UniformBufferHelpers.js";
import { GXTextureMapping, fillSceneParamsDataOnTemplate, gxBindingLayouts, translateWrapModeGfx } from "../gx/gx_render.js";
import * as GX from "../gx/gx_enum.js";

export interface Background {
    update(state: WorldState): void;
    prepareToRender(state: WorldState, ctx: RenderContext): void;
}

export interface BackgroundConstructor {
    new (state: WorldState, bgObjects: BgObjectInst[]): Background;
}

const scratchMat4a = mat4.create();
const scratchRenderParams = new RenderParams();
const scratchBonusMat4a = mat4.create();
const scratchBonusVec3a = vec3.create();
const scratchBonusVec3b = vec3.create();
const BONUS_MAX_STARPOINTS = 64;
const BONUS_MAIN_OBJECT = "BNS_MAIN";
const BONUS_STARPOINT_PREFIX = "STARPOINT";
const BONUS_STARLIGHT_PREFIX = "STARLIGHT_";
const BONUS_STAR_MIN_Z = -30.0;
const BONUS_STAR_PROJ_OFFSET = 26.0;
const BONUS_STAR_PULSE_SCALE = 0.75;
const BONUS_STAR_PHASE_STEP = (2 * Math.PI) / 180;
const OVERLAY_VIEW_Z = 100.0;
const OVERLAY_MODEL_HALF_SIZE = 5.0;
const POT_PROXIMITY_OBJECT_NAMES = new Set(["POD_POD_A", "POD_KAMADO_A"]);

const LAVA_OVERLAY_MEGASTATE = makeMegaState(
    setAttachmentStateSimple(
        {
            depthCompare: GfxCompareMode.Always,
            depthWrite: false,
            cullMode: GfxCullMode.None,
        },
        {
            blendMode: GfxBlendMode.Add,
            blendSrcFactor: GfxBlendFactor.One,
            blendDstFactor: GfxBlendFactor.One,
            channelWriteMask: GfxChannelWriteMask.RGB,
        }
    )
);

const POT_OVERLAY_MEGASTATE = makeMegaState(
    setAttachmentStateSimple(
        {
            depthCompare: GfxCompareMode.Always,
            depthWrite: false,
            cullMode: GfxCullMode.None,
        },
        {
            blendMode: GfxBlendMode.Add,
            blendSrcFactor: GfxBlendFactor.SrcAlpha,
            blendDstFactor: GfxBlendFactor.One,
            channelWriteMask: GfxChannelWriteMask.RGB,
        }
    )
);

const LAVA_OVERLAY_UBO_INDEX = 1;
const LAVA_OVERLAY_UBO_WORDS = 36;
const POT_OVERLAY_UBO_INDEX = 1;
const POT_OVERLAY_UBO_WORDS = 60;

function createLavaOverlayProgram(ctx: RenderContext): GfxProgram {
    const vert = `
${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    vec4 u_Misc0;
};

layout(std140) uniform ub_OverlayParams {
    Mat4x4 u_ViewFromModel;
    Mat4x4 u_TexMtx;
    vec4 u_Color;
};

layout(location = 0) in vec4 a_Position;
layout(location = 8) in vec4 a_Tex01;

out vec2 v_TexCoord;
out vec3 v_Color;

void main() {
    mat4 viewFromModel = UnpackMatrix(u_ViewFromModel);
    vec4 posView = viewFromModel * vec4(a_Position.xyz, 1.0);
    gl_Position = UnpackMatrix(u_Projection) * posView;
    vec2 baseUV = vec2((a_Position.x + 5.0) * 0.1, (5.0 - a_Position.y) * 0.1);
    vec4 texCoord = UnpackMatrix(u_TexMtx) * vec4(baseUV, 0.0, 1.0);
    v_TexCoord = texCoord.xy;
    v_Color = u_Color.rgb;
}
`;

    const frag = `
precision highp float;

uniform sampler2D u_Texture;

in vec2 v_TexCoord;
in vec3 v_Color;

out vec4 o_Color;

void main() {
    vec4 tex = texture(u_Texture, v_TexCoord);
    o_Color = vec4(tex.rgb * v_Color, 1.0);
}
`;

    const program = preprocessProgram_GLSL(ctx.device.queryVendorInfo(), vert, frag);
    return ctx.renderInstManager.gfxRenderCache.createProgramSimple(program);
}

function createPotOverlayProgram(ctx: RenderContext): GfxProgram {
    const vert = `
${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    vec4 u_Misc0;
};

layout(std140) uniform ub_OverlayParams {
    Mat4x4 u_ViewFromModel;
    Mat4x4 u_TexMtx0;
    Mat4x4 u_TexMtx1;
    vec4 u_IndTexMtx0;
    vec4 u_IndTexMtx1;
    vec4 u_AlphaCorners;
};

layout(location = 0) in vec4 a_Position;
layout(location = 8) in vec4 a_Tex01;

out vec2 v_UV;

void main() {
    mat4 viewFromModel = UnpackMatrix(u_ViewFromModel);
    vec4 posView = viewFromModel * vec4(a_Position.xyz, 1.0);
    gl_Position = UnpackMatrix(u_Projection) * posView;
    v_UV = vec2((a_Position.x + 5.0) * 0.1, (5.0 - a_Position.y) * 0.1);
}
`;

    const frag = `
${GfxShaderLibrary.MatrixLibrary}

precision highp float;

layout(std140) uniform ub_OverlayParams {
    Mat4x4 u_ViewFromModel;
    Mat4x4 u_TexMtx0;
    Mat4x4 u_TexMtx1;
    vec4 u_IndTexMtx0;
    vec4 u_IndTexMtx1;
    vec4 u_AlphaCorners;
};

uniform sampler2D u_Texture0;
uniform sampler2D u_Texture1;

in vec2 v_UV;

out vec4 o_Color;

float getAlpha(vec2 uv) {
    float a00 = u_AlphaCorners.x;
    float a10 = u_AlphaCorners.y;
    float a11 = u_AlphaCorners.z;
    float a01 = u_AlphaCorners.w;
    float a0 = mix(a00, a10, uv.x);
    float a1 = mix(a01, a11, uv.x);
    return mix(a0, a1, uv.y);
}

void main() {
    vec2 texSize = vec2(textureSize(u_Texture0, 0));
    vec2 baseUV = (UnpackMatrix(u_TexMtx0) * vec4(v_UV, 0.0, 1.0)).xy;
    vec2 indUV = (UnpackMatrix(u_TexMtx1) * vec4(v_UV, 0.0, 1.0)).xy;
    vec3 indCoord = 255.0 * texture(u_Texture1, indUV).abg + vec3(-128.0);
    vec2 indOffset = vec2(
        dot(u_IndTexMtx0.xyz, indCoord),
        dot(u_IndTexMtx1.xyz, indCoord)
    );
    vec2 finalUV = (baseUV * texSize + indOffset) / texSize;
    vec3 tex = texture(u_Texture0, finalUV).rgb;
    o_Color = vec4(tex, getAlpha(v_UV));
}
`;

    const program = preprocessProgram_GLSL(ctx.device.queryVendorInfo(), vert, frag);
    return ctx.renderInstManager.gfxRenderCache.createProgramSimple(program);
}

function ensureOverlayTextureMapping(
    state: WorldState,
    ctx: RenderContext,
    overlayModel: ModelInst,
    mapping: GXTextureMapping,
): boolean {
    if (mapping.gfxTexture && mapping.gfxSampler) {
        return true;
    }

    const tevLayer = overlayModel.modelData.tevLayers[0];
    if (!tevLayer) {
        return false;
    }
    state.modelCache.fillTextureMappingFromGxTexture(tevLayer.gxTexture, mapping);

    const wrapS = ((tevLayer.flags >> 2) & 0x03) as GX.WrapMode;
    const wrapT = ((tevLayer.flags >> 4) & 0x03) as GX.WrapMode;
    const width = tevLayer.gxTexture.width;
    const height = tevLayer.gxTexture.height;
    let maxLod = (tevLayer.flags >> 7) & 0x0f;
    if (width !== height) {
        maxLod = 0;
    } else if (maxLod === 15) {
        const minDim = Math.min(width, height);
        maxLod = Math.max(0, Math.log2(minDim) - 4);
    }

    mapping.gfxSampler = ctx.renderInstManager.gfxRenderCache.createSampler({
        wrapS: translateWrapModeGfx(wrapS),
        wrapT: translateWrapModeGfx(wrapT),
        minFilter: GfxTexFilterMode.Bilinear,
        magFilter: GfxTexFilterMode.Bilinear,
        mipFilter: maxLod === 0 ? GfxMipFilterMode.Nearest : GfxMipFilterMode.Linear,
        minLOD: 0,
        maxLOD: maxLod,
    });
    return !!mapping.gfxTexture && !!mapping.gfxSampler;
}

function toGXByteNorm(value: number): number {
    const byte = ((Math.trunc(value) % 256) + 256) % 256;
    return byte / 255;
}

type OverlayFrustumQuad = {
    centerX: number;
    centerY: number;
    scaleX: number;
    scaleY: number;
};

function getOverlayFrustumQuad(camera: any, viewZ: number): OverlayFrustumQuad {
    const proj = camera?.projectionMatrix as mat4 | undefined;
    if (proj && !camera?.isOrthographic && Math.abs(proj[0]) > 1e-6 && Math.abs(proj[5]) > 1e-6) {
        const left = viewZ * (-1.0 + proj[8]) / proj[0];
        const right = viewZ * (1.0 + proj[8]) / proj[0];
        const bottom = viewZ * (-1.0 + proj[9]) / proj[5];
        const top = viewZ * (1.0 + proj[9]) / proj[5];
        return {
            centerX: (left + right) * 0.5,
            centerY: (bottom + top) * 0.5,
            scaleX: (right - left) / (OVERLAY_MODEL_HALF_SIZE * 2.0),
            scaleY: (top - bottom) / (OVERLAY_MODEL_HALF_SIZE * 2.0),
        };
    }
    if (camera?.isOrthographic) {
        const halfHeight = camera.top ?? 1;
        const halfWidth = halfHeight * (camera.aspect ?? 1);
        return {
            centerX: 0.0,
            centerY: 0.0,
            scaleX: halfWidth / OVERLAY_MODEL_HALF_SIZE,
            scaleY: halfHeight / OVERLAY_MODEL_HALF_SIZE,
        };
    }
    const fovY = camera?.fovY ?? Math.PI / 3;
    const aspect = camera?.aspect ?? 1;
    const halfHeight = Math.tan(fovY * 0.5) * viewZ;
    return {
        centerX: 0.0,
        centerY: 0.0,
        scaleX: (halfHeight * aspect) / OVERLAY_MODEL_HALF_SIZE,
        scaleY: halfHeight / OVERLAY_MODEL_HALF_SIZE,
    };
}

type LavaOverlayState = {
    glow0: number;
    glow0Vel: number;
    glow1: number;
    glow1Vel: number;
    texPhase: number;
    texVel: number;
    texDir: vec3;
    texScale: number;
    wavePhase: number;
    waveStep: number;
};

type PotOverlayState = {
    texX: number;
    texY: number;
    texZ: number;
    velX: number;
    velY: number;
    velZ: number;
    indScaleX: number;
    indScaleY: number;
    driftX: number;
    driftY: number;
    scaleX: number;
    scaleY: number;
    alphaTopLeft: number;
    alphaTopRight: number;
    alphaBottomRight: number;
    alphaBottomLeft: number;
};

type PotWindState = {
    toggle: number;
    timer: number;
    current: vec3;
    velocity: vec3;
    target: vec3;
    baseDir: vec3;
};

function randomRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

function randomSign(): number {
    return Math.random() < 0.5 ? -1 : 1;
}

function createLavaOverlayState(): LavaOverlayState {
    const texDir = vec3.create();
    mat4.identity(scratchMat4a);
    mat4.rotateY(scratchMat4a, scratchMat4a, ((Math.random() * 0x8000) | 0) * S16_TO_RADIANS);
    mat4.rotateX(scratchMat4a, scratchMat4a, ((Math.random() * 0x8000) | 0) * S16_TO_RADIANS);
    transformVec3Mat4w0(texDir, scratchMat4a, Vec3NegZ);
    return {
        glow0: 1,
        glow0Vel: 0,
        glow1: 1,
        glow1Vel: 0,
        texPhase: Math.random(),
        texVel: randomRange(0, 1) * 0.0016666667,
        texDir,
        texScale: 1,
        wavePhase: ((Math.random() * 0x7fff) | 0) * S16_TO_RADIANS,
        waveStep: ((Math.random() * 0x020f) | 0) * S16_TO_RADIANS,
    };
}

function createPotOverlayState(): PotOverlayState {
    return {
        texX: Math.random(),
        texY: Math.random(),
        texZ: Math.random(),
        velX: 0,
        velY: 0.025,
        velZ: 0,
        indScaleX: randomSign() * (Math.random() * 0.2 + 0.2),
        indScaleY: randomSign() * (Math.random() * 0.2 + 0.2),
        driftX: -randomRange(0.4, 0.65),
        driftY: -randomRange(0.4, 0.65),
        scaleX: randomRange(1.0, 1.2),
        scaleY: randomRange(1.0, 1.2),
        alphaTopLeft: 255,
        alphaTopRight: 255,
        alphaBottomRight: 255,
        alphaBottomLeft: 255,
    };
}

function createPotWindState(): PotWindState {
    const baseDir = vec3.create();
    mat4.identity(scratchMat4a);
    mat4.rotateY(scratchMat4a, scratchMat4a, ((Math.random() * 0x8000) | 0) * S16_TO_RADIANS);
    mat4.rotateX(scratchMat4a, scratchMat4a, ((((Math.random() * 0x200) | 0) - 0x100) * S16_TO_RADIANS));
    transformVec3Mat4w0(baseDir, scratchMat4a, Vec3NegZ);
    return {
        toggle: (Math.random() * 2) | 0,
        timer: (Math.random() * 240) | 0,
        current: vec3.fromValues(
            (Math.random() - 0.5) * 2.0,
            (Math.random() - 0.5) * 0.1,
            (Math.random() - 0.5) * 2.0,
        ),
        velocity: vec3.create(),
        target: vec3.create(),
        baseDir,
    };
}

const scratchOverlayForward = vec3.create();
const scratchOverlayCameraPos = vec3.create();
const scratchOverlayVecA = vec3.create();
const scratchOverlayVecB = vec3.create();
const scratchOverlayMat4 = mat4.create();
const scratchOverlayObjMat4 = mat4.create();
const scratchOverlayObjCenter = vec3.create();

function getCameraForwardFromView(out: vec3, viewMatrix: mat4 | undefined): boolean {
    if (!viewMatrix || !mat4.invert(scratchOverlayMat4, viewMatrix)) {
        return false;
    }
    transformVec3Mat4w0(out, scratchOverlayMat4, Vec3NegZ);
    const len = vec3.len(out);
    if (len < 1e-5) {
        return false;
    }
    vec3.scale(out, out, 1 / len);
    return true;
}

function getCameraPositionFromView(out: vec3, viewMatrix: mat4 | undefined): boolean {
    if (!viewMatrix || !mat4.invert(scratchOverlayMat4, viewMatrix)) {
        return false;
    }
    mat4.getTranslation(out, scratchOverlayMat4);
    return true;
}

function getCameraForward(out: vec3, camera: any): vec3 {
    if (getCameraForwardFromView(out, camera?.viewMatrix as mat4 | undefined)) {
        return out;
    } else if (camera?.worldMatrix) {
        vec3.set(out, -camera.worldMatrix[8], -camera.worldMatrix[9], -camera.worldMatrix[10]);
    } else {
        vec3.set(out, 0, 0, -1);
    }
    const len = vec3.len(out);
    if (len < 1e-5) {
        vec3.set(out, 0, 0, -1);
        return out;
    }
    vec3.scale(out, out, 1 / len);
    return out;
}

function getCameraPosition(out: vec3, camera: any): vec3 {
    if (getCameraPositionFromView(out, camera?.viewMatrix as mat4 | undefined)) {
        return out;
    }
    if (camera?.worldMatrix) {
        mat4.getTranslation(out, camera.worldMatrix);
        return out;
    }
    vec3.set(out, 0, 0, 0);
    return out;
}

export class BgDummy implements Background {
    private bgObjects: BgObjectInst[] = [];

    constructor(state: WorldState, bgObjects: BgObjectInst[]) {
        this.bgObjects = bgObjects;
    }

    public update(state: WorldState): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].update(state);
        }
    }

    public prepareToRender(state: WorldState, ctx: RenderContext): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].prepareToRender(state, ctx);
        }
    }
}

export class BgJungle implements Background {
    private bgObjects: BgObjectInst[] = [];

    constructor(state: WorldState, bgObjects: BgObjectInst[]) {
        this.bgObjects = bgObjects;
    }

    public update(state: WorldState): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].update(state);
        }
    }

    public prepareToRender(state: WorldState, ctx: RenderContext): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].prepareToRender(state, ctx);
        }
    }
}

export class BgWater implements Background {
    private bgObjects: BgObjectInst[] = [];

    constructor(state: WorldState, bgObjects: BgObjectInst[]) {
        this.bgObjects = bgObjects;
    }

    public update(state: WorldState): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].update(state);
        }
    }

    public prepareToRender(state: WorldState, ctx: RenderContext): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].prepareToRender(state, ctx);
        }
    }
}

export class BgLava2 implements Background {
    private bgObjects: BgObjectInst[] = [];
    private overlayModel: ModelInst | null;
    private overlayState: LavaOverlayState;
    private overlayProgram: GfxProgram | null = null;
    private overlayTextureMapping = new GXTextureMapping();
    private lastOverlayTickFrame = -1;

    constructor(state: WorldState, bgObjects: BgObjectInst[]) {
        this.bgObjects = bgObjects;
        this.overlayModel = state.modelCache.getModel("LAV_YOUGAN_LIGHT_A", GmaSrc.Bg);
        this.overlayState = createLavaOverlayState();
    }

    public update(state: WorldState): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].update(state);
        }
    }

    private updateOverlayState(
        state: WorldState,
        camera: any,
        viewFromWorldTilted: mat4 | undefined,
        viewFromWorldNoTilt: mat4 | undefined,
    ): void {
        const overlayState = this.overlayState;
        if (!getCameraPositionFromView(scratchOverlayCameraPos, viewFromWorldTilted)) {
            getCameraPosition(scratchOverlayCameraPos, camera);
        }
        if (!getCameraForwardFromView(scratchOverlayForward, viewFromWorldNoTilt)) {
            getCameraForward(scratchOverlayForward, camera);
        }

        let glowTargetA = 0.75;
        let glowTargetB = -0.025;
        const raycastY = state.raycastStageDown?.(scratchOverlayCameraPos);
        if (raycastY !== undefined && raycastY !== null) {
            const floorFactor = (scratchOverlayCameraPos[1] - raycastY) * 0.041666668;
            if (floorFactor <= 1.0) {
                if (floorFactor >= 0.0) {
                    glowTargetA = floorFactor * 0.75;
                    glowTargetB = floorFactor * -0.525 + 0.5;
                } else {
                    glowTargetA = 0.0;
                    glowTargetB = 0.5;
                }
            }
        }
        const cameraY = scratchOverlayForward[1];
        const targetA = glowTargetA * (2.0 - (cameraY + 1.0) * 0.5 * 1.5);
        const targetB = glowTargetB * (1.0 - Math.abs(cameraY) * 0.75);

        overlayState.glow0Vel += ((targetA - overlayState.glow0) * 0.3 - overlayState.glow0Vel) * 0.2;
        overlayState.glow0Vel *= 0.995;
        overlayState.glow0 += overlayState.glow0Vel;

        overlayState.glow1Vel += ((targetB - overlayState.glow1) * 0.05 - overlayState.glow1Vel) * 0.05;
        overlayState.glow1Vel *= 0.995;
        overlayState.glow1 += overlayState.glow1Vel;

        const texTarget =
            (overlayState.texDir[2] * scratchOverlayForward[2] +
                overlayState.texDir[1] * scratchOverlayForward[1] +
                overlayState.texDir[0] * scratchOverlayForward[0]) *
            0.0016666667;
        overlayState.texVel += (texTarget - overlayState.texVel) * 0.025;
        overlayState.texPhase += overlayState.texVel;
        overlayState.wavePhase += overlayState.waveStep;
        overlayState.texScale = Math.sin(overlayState.wavePhase) * 0.1 + 1.0;
    }

    public prepareToRender(state: WorldState, ctx: RenderContext): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].prepareToRender(state, ctx);
        }

        if (!this.overlayModel || ctx.mirrorCapture || ctx.wormholeCapture) {
            return;
        }

        const camera = ctx.viewerInput.camera;
        const viewFromWorldTilted = (ctx.viewFromWorld as mat4 | undefined) ?? (camera?.viewMatrix as mat4 | undefined);
        const viewFromWorldNoTilt =
            (ctx.viewFromWorldNoTilt as mat4 | undefined) ?? (camera?.viewMatrix as mat4 | undefined);
        const tickFrame = Math.floor(state.time.getAnimTimeFrames());
        if (tickFrame !== this.lastOverlayTickFrame) {
            let steps = 1;
            if (this.lastOverlayTickFrame >= 0 && tickFrame > this.lastOverlayTickFrame) {
                steps = Math.min(8, tickFrame - this.lastOverlayTickFrame);
            }
            for (let i = 0; i < steps; i++) {
                this.updateOverlayState(state, camera, viewFromWorldTilted, viewFromWorldNoTilt);
            }
            this.lastOverlayTickFrame = tickFrame;
        }
        const overlayState = this.overlayState;

        const overlayQuad = getOverlayFrustumQuad(camera, OVERLAY_VIEW_Z);

        if (!this.overlayProgram) {
            this.overlayProgram = createLavaOverlayProgram(ctx);
        }
        if (!ensureOverlayTextureMapping(state, ctx, this.overlayModel, this.overlayTextureMapping)) {
            return;
        }

        const drawPass = (glow: number, flipV: boolean): void => {
            const glow255 = glow * 255.0;
            const colorR = toGXByteNorm(glow255 * 1.2);
            const colorG = toGXByteNorm(glow255 * 1.15);
            const colorB = toGXByteNorm(glow255);

            const rp = scratchRenderParams;
            rp.reset();
            rp.sort = RenderSort.All;
            mat4.identity(rp.viewFromModel);
            mat4.translate(
                rp.viewFromModel,
                rp.viewFromModel,
                [overlayQuad.centerX, overlayQuad.centerY, -OVERLAY_VIEW_Z],
            );
            mat4.scale(rp.viewFromModel, rp.viewFromModel, [overlayQuad.scaleX, overlayQuad.scaleY, 1]);
            mat4.identity(rp.texMtx);
            mat4.translate(rp.texMtx, rp.texMtx, [overlayState.texPhase + 0.5, 1.0, 0.0]);
            mat4.scale(rp.texMtx, rp.texMtx, [overlayState.texScale, 1.0 / overlayState.texScale, 1.0]);
            mat4.translate(rp.texMtx, rp.texMtx, [-0.5, -1.0, 0.0]);
            if (flipV) {
                mat4.translate(rp.texMtx, rp.texMtx, [0.0, 1.0, 0.0]);
                mat4.scale(rp.texMtx, rp.texMtx, [1.0, -1.0, 1.0]);
            }

            this.overlayModel.prepareToRenderCustom(ctx, rp, (renderInst, renderParams): void => {
                renderInst.setBindingLayouts(gxBindingLayouts);
                fillSceneParamsDataOnTemplate(renderInst, ctx.viewerInput, 0, state.time.getAnimTimeFrames());
                renderInst.setGfxProgram(assertExists(this.overlayProgram));
                renderInst.setMegaStateFlags(LAVA_OVERLAY_MEGASTATE);
                renderInst.setSamplerBindingsFromTextureMappings([this.overlayTextureMapping]);
                const d = renderInst.allocateUniformBufferF32(LAVA_OVERLAY_UBO_INDEX, LAVA_OVERLAY_UBO_WORDS);
                fillMatrix4x4(d, 0, renderParams.viewFromModel);
                fillMatrix4x4(d, 16, renderParams.texMtx);
                fillVec4(d, 32, colorR, colorG, colorB, 1.0);
            });
        };

        drawPass(overlayState.glow0, false);
        if (overlayState.glow1 > 0.0) {
            drawPass(overlayState.glow1, true);
        }
    }
}

export class BgPot2 implements Background {
    private bgObjects: BgObjectInst[] = [];
    private overlayModel: ModelInst | null;
    private proximityModel: ModelInst | null;
    private proximityObjects: BgObjectInst[] = [];
    private overlayState: PotOverlayState;
    private windState: PotWindState;
    private overlayProgram: GfxProgram | null = null;
    private overlayTextureMapping = new GXTextureMapping();
    private hasPrevViewMatrix = false;
    private prevViewMatrix = mat4.create();

    constructor(state: WorldState, bgObjects: BgObjectInst[]) {
        this.bgObjects = bgObjects;
        this.overlayModel = state.modelCache.getModel("POD_YUGE_A", GmaSrc.Bg);
        this.proximityModel = state.modelCache.getModel("POD_RENZ_FREA_A", GmaSrc.Bg) ?? this.overlayModel;
        this.proximityObjects = this.bgObjects.filter((bgObject) =>
            POT_PROXIMITY_OBJECT_NAMES.has(bgObject.bgObjectData.modelName),
        );
        if (this.proximityObjects.length === 0) {
            this.proximityObjects = this.bgObjects;
        }
        this.overlayState = createPotOverlayState();
        this.windState = createPotWindState();
    }

    private updateWindState(): void {
        const wind = this.windState;
        wind.timer--;
        if (wind.timer < 0) {
            wind.timer = (Math.random() * 240.0) | 0;
            wind.toggle ^= 1;
            if (wind.toggle === 0) {
                vec3.set(wind.target, 0.0, 0.0, 0.0);
            } else {
                const scale = Math.random() * 0.75 + 0.25;
                wind.target[0] = scale * (wind.baseDir[0] + (Math.random() * 0.2 - 0.1));
                wind.target[1] = scale * (wind.baseDir[1] + (Math.random() * 0.2 - 0.1));
                wind.target[2] = scale * (wind.baseDir[2] + (Math.random() * 0.2 - 0.1));
            }
        }

        wind.velocity[0] += ((wind.target[0] - wind.current[0]) * 0.1 - wind.velocity[0]) * 0.01;
        wind.velocity[1] += ((wind.target[1] - wind.current[1]) * 0.1 - wind.velocity[1]) * 0.01;
        wind.velocity[2] += ((wind.target[2] - wind.current[2]) * 0.1 - wind.velocity[2]) * 0.01;
        wind.current[0] += wind.velocity[0];
        wind.current[1] += wind.velocity[1];
        wind.current[2] += wind.velocity[2];
    }

    public update(state: WorldState): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].update(state);
        }
    }

    public prepareToRender(state: WorldState, ctx: RenderContext): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].prepareToRender(state, ctx);
        }

        if (!this.overlayModel || ctx.mirrorCapture || ctx.wormholeCapture) {
            return;
        }

        const camera = ctx.viewerInput.camera;
        const viewMatrix = (ctx.viewFromWorld as mat4 | undefined) ?? (camera?.viewMatrix as mat4 | undefined);
        if (!viewMatrix) {
            return;
        }
        const prevViewMatrix = (ctx.viewFromWorldPrev as mat4 | undefined) ?? this.prevViewMatrix;
        if (!ctx.viewFromWorldPrev && !this.hasPrevViewMatrix) {
            mat4.copy(this.prevViewMatrix, viewMatrix);
            this.hasPrevViewMatrix = true;
        }
        const overlayState = this.overlayState;
        if (!getCameraPositionFromView(scratchOverlayCameraPos, viewMatrix)) {
            getCameraPosition(scratchOverlayCameraPos, camera);
        }

        let proximity = 0.0;
        let nearestNormDist = -1.0;
        const proximityBoundModel = this.proximityModel ?? this.overlayModel;
        const proximityBoundCenter = proximityBoundModel.modelData.boundSphereCenter;
        const proximityBoundRadius = Math.max(1e-4, proximityBoundModel.modelData.boundSphereRadius);
        for (let i = 0; i < this.proximityObjects.length; i++) {
            this.proximityObjects[i].copyWorldFromModel(scratchOverlayObjMat4);
            transformVec3Mat4w1(scratchOverlayObjCenter, scratchOverlayObjMat4, proximityBoundCenter);
            const dx = scratchOverlayObjCenter[0] - scratchOverlayCameraPos[0];
            const dz = scratchOverlayObjCenter[2] - scratchOverlayCameraPos[2];
            const dist = Math.hypot(dx, dz);
            const scaleX = Math.hypot(
                scratchOverlayObjMat4[0],
                scratchOverlayObjMat4[1],
                scratchOverlayObjMat4[2],
            );
            const normDist = dist / Math.max(1e-4, proximityBoundRadius * scaleX);
            if (nearestNormDist < 0.0 || normDist < nearestNormDist) {
                nearestNormDist = normDist;
            }
        }
        if (nearestNormDist >= 0.0) {
            if (nearestNormDist < 1.0) {
                proximity = 1.0;
            } else if (nearestNormDist < 1.5) {
                proximity = 1.0 - (nearestNormDist - 1.0) * 2.0;
            }
        }

        const cameraDrift = scratchOverlayForward;
        if (mat4.invert(scratchOverlayMat4, prevViewMatrix)) {
            transformVec3Mat4w0(cameraDrift, scratchOverlayMat4, Vec3NegZ);
            transformVec3Mat4w0(cameraDrift, viewMatrix, cameraDrift);
        } else {
            vec3.set(cameraDrift, 0.0, 0.0, -1.0);
        }

        this.updateWindState();

        const raycastY = state.raycastStageDown?.(scratchOverlayCameraPos);
        let floorFactor = 1.0;
        let targetVelY = 0.025;
        if (raycastY !== undefined && raycastY !== null) {
            floorFactor = (scratchOverlayCameraPos[1] - raycastY) * 0.05;
            if (floorFactor > 1.0) {
                floorFactor = 1.0;
            }
            targetVelY = floorFactor * 0.02500000037252903 + (1.0 - floorFactor) * 0.0025000002;
        }
        overlayState.velY += (targetVelY - overlayState.velY) * 0.08;

        const windVec = scratchOverlayVecA;
        transformVec3Mat4w0(windVec, viewMatrix, this.windState.current);
        vec3.scale(windVec, windVec, 0.0020833334);

        const scrollVec = scratchOverlayVecB;
        vec3.set(scrollVec, overlayState.velX, overlayState.velY, overlayState.velZ);
        transformVec3Mat4w0(scrollVec, viewMatrix, scrollVec);
        const scrollLen = vec3.length(scrollVec);
        scrollVec[2] = 0.0;
        if (scrollVec[0] !== 0.0 || scrollVec[1] !== 0.0) {
            const xyLen = Math.hypot(scrollVec[0], scrollVec[1]);
            if (xyLen > 0.0) {
                const scale = scrollLen / xyLen;
                scrollVec[0] *= scale;
                scrollVec[1] *= scale;
            }
        } else {
            scrollVec[1] = scrollLen;
        }
        scrollVec[0] += windVec[0] + cameraDrift[0];
        scrollVec[1] += windVec[1] + cameraDrift[1];
        overlayState.texX += scrollVec[0];
        overlayState.texY += scrollVec[1];

        if (proximity <= 0.0) {
            overlayState.alphaTopLeft += -overlayState.alphaTopLeft * 0.05;
            overlayState.alphaTopRight += -overlayState.alphaTopRight * 0.04;
            overlayState.alphaBottomLeft += -overlayState.alphaBottomLeft * 0.02;
            overlayState.alphaBottomRight += -overlayState.alphaBottomRight * 0.03;
        } else {
            const topTarget = (floorFactor * 95.0 + 160.0) * proximity;
            const bottomTarget = floorFactor * 96.0 * proximity;
            overlayState.alphaTopLeft += (topTarget - overlayState.alphaTopLeft) * 0.05;
            overlayState.alphaTopRight += (topTarget - overlayState.alphaTopRight) * 0.04;
            overlayState.alphaBottomLeft += (bottomTarget - overlayState.alphaBottomLeft) * 0.02;
            overlayState.alphaBottomRight += (bottomTarget - overlayState.alphaBottomRight) * 0.03;
        }
        if (!ctx.viewFromWorldPrev) {
            mat4.copy(this.prevViewMatrix, viewMatrix);
            this.hasPrevViewMatrix = true;
        }

        if (
            overlayState.alphaTopLeft <= 1.0 &&
            overlayState.alphaTopRight <= 1.0 &&
            overlayState.alphaBottomLeft <= 1.0 &&
            overlayState.alphaBottomRight <= 1.0
        ) {
            return;
        }

        if (!this.overlayProgram) {
            this.overlayProgram = createPotOverlayProgram(ctx);
        }
        if (!ensureOverlayTextureMapping(state, ctx, this.overlayModel, this.overlayTextureMapping)) {
            return;
        }

        const overlayQuad = getOverlayFrustumQuad(camera, OVERLAY_VIEW_Z);
        const rp = scratchRenderParams;
        rp.reset();
        rp.sort = RenderSort.All;
        mat4.identity(rp.viewFromModel);
        mat4.translate(
            rp.viewFromModel,
            rp.viewFromModel,
            [overlayQuad.centerX, overlayQuad.centerY, -OVERLAY_VIEW_Z],
        );
        mat4.scale(rp.viewFromModel, rp.viewFromModel, [overlayQuad.scaleX, overlayQuad.scaleY, 1]);
        mat4.identity(rp.texMtx);
        mat4.translate(rp.texMtx, rp.texMtx, [overlayState.texX, overlayState.texY, overlayState.texZ]);
        mat4.identity(rp.texMtx2);
        mat4.translate(
            rp.texMtx2,
            rp.texMtx2,
            [
                overlayState.driftX * (overlayState.texX + overlayState.texY * 0.2),
                overlayState.driftY * (overlayState.texY + overlayState.texX * 0.2),
                0.0,
            ],
        );
        mat4.scale(rp.texMtx2, rp.texMtx2, [overlayState.scaleX, overlayState.scaleY, 1.0]);

        const indMtx0Y = overlayState.indScaleX;
        const indMtx1Z = overlayState.indScaleY;
        const alpha00 = toGXByteNorm(overlayState.alphaTopLeft);
        const alpha10 = toGXByteNorm(overlayState.alphaTopRight);
        const alpha11 = toGXByteNorm(overlayState.alphaBottomRight);
        const alpha01 = toGXByteNorm(overlayState.alphaBottomLeft);

        this.overlayModel.prepareToRenderCustom(ctx, rp, (renderInst, renderParams): void => {
            renderInst.setBindingLayouts(gxBindingLayouts);
            fillSceneParamsDataOnTemplate(renderInst, ctx.viewerInput, 0, state.time.getAnimTimeFrames());
            renderInst.setGfxProgram(assertExists(this.overlayProgram));
            renderInst.setMegaStateFlags(POT_OVERLAY_MEGASTATE);
            renderInst.setSamplerBindingsFromTextureMappings([
                this.overlayTextureMapping,
                this.overlayTextureMapping,
            ]);
            const d = renderInst.allocateUniformBufferF32(POT_OVERLAY_UBO_INDEX, POT_OVERLAY_UBO_WORDS);
            fillMatrix4x4(d, 0, renderParams.viewFromModel);
            fillMatrix4x4(d, 16, renderParams.texMtx);
            fillMatrix4x4(d, 32, renderParams.texMtx2);
            fillVec4(d, 48, 0.0, indMtx0Y, 0.0, 0.0);
            fillVec4(d, 52, 0.0, 0.0, indMtx1Z, 0.0);
            fillVec4(d, 56, alpha00, alpha10, alpha11, alpha01);
        });
    }
}

// Dancing monkey flipbook animations in windows in Night bg
// "mado" is "window" in Japanese

const NIGHT_WINDOW_A_MODELS = [
    BgNightModelID.NIG_MADO_A_PT00,
    BgNightModelID.NIG_MADO_A_PT01,
    BgNightModelID.NIG_MADO_A_PT02,
    BgNightModelID.NIG_MADO_A_PT03,
    BgNightModelID.NIG_MADO_A_PT04,
    BgNightModelID.NIG_MADO_A_PT05,
    BgNightModelID.NIG_MADO_A_PT06,
    BgNightModelID.NIG_MADO_A_PT07,
    BgNightModelID.NIG_MADO_A_PT08,
    BgNightModelID.NIG_MADO_A_PT09,
    BgNightModelID.NIG_MADO_A_PT10,
    BgNightModelID.NIG_MADO_A_PT11,
    BgNightModelID.NIG_MADO_A_PT12,
    BgNightModelID.NIG_MADO_A_PT13,
];

const NIGHT_WINDOW_B_MODELS = [
    BgNightModelID.NIG_MADO_B_PT00,
    BgNightModelID.NIG_MADO_B_PT01,
    BgNightModelID.NIG_MADO_B_PT02,
    BgNightModelID.NIG_MADO_B_PT03,
    BgNightModelID.NIG_MADO_B_PT04,
    BgNightModelID.NIG_MADO_B_PT05,
    BgNightModelID.NIG_MADO_B_PT06,
    BgNightModelID.NIG_MADO_B_PT07,
    BgNightModelID.NIG_MADO_B_PT08,
    BgNightModelID.NIG_MADO_B_PT09,
    BgNightModelID.NIG_MADO_B_PT10,
];

const NIGHT_WINDOW_C_MODELS = [
    BgNightModelID.NIG_MADO_C_PT00,
    BgNightModelID.NIG_MADO_C_PT01,
    BgNightModelID.NIG_MADO_C_PT02,
    BgNightModelID.NIG_MADO_C_PT03,
    BgNightModelID.NIG_MADO_C_PT04,
    BgNightModelID.NIG_MADO_C_PT05,
    BgNightModelID.NIG_MADO_C_PT06,
    BgNightModelID.NIG_MADO_C_PT07,
    BgNightModelID.NIG_MADO_C_PT08,
    BgNightModelID.NIG_MADO_C_PT09,
    BgNightModelID.NIG_MADO_C_PT10,
    BgNightModelID.NIG_MADO_C_PT11,
    BgNightModelID.NIG_MADO_C_PT12,
    BgNightModelID.NIG_MADO_C_PT13,
    BgNightModelID.NIG_MADO_C_PT14,
    BgNightModelID.NIG_MADO_C_PT15,
    BgNightModelID.NIG_MADO_C_PT16,
    BgNightModelID.NIG_MADO_C_PT17,
];

const NIGHT_WINDOW_D_MODELS = [
    BgNightModelID.NIG_MADO_D_PT00,
    BgNightModelID.NIG_MADO_D_PT01,
    BgNightModelID.NIG_MADO_D_PT02,
    BgNightModelID.NIG_MADO_D_PT03,
    BgNightModelID.NIG_MADO_D_PT04,
    BgNightModelID.NIG_MADO_D_PT05,
    BgNightModelID.NIG_MADO_D_PT06,
    BgNightModelID.NIG_MADO_D_PT07,
    BgNightModelID.NIG_MADO_D_PT08,
    BgNightModelID.NIG_MADO_D_PT09,
    BgNightModelID.NIG_MADO_D_PT10,
    BgNightModelID.NIG_MADO_D_PT11,
    BgNightModelID.NIG_MADO_D_PT12,
    BgNightModelID.NIG_MADO_D_PT13,
    BgNightModelID.NIG_MADO_D_PT14,
    BgNightModelID.NIG_MADO_D_PT15,
    BgNightModelID.NIG_MADO_D_PT16,
    BgNightModelID.NIG_MADO_D_PT17,
];

const NIGHT_WINDOW_E_MODELS = [
    BgNightModelID.NIG_MADO_E_PT00,
    BgNightModelID.NIG_MADO_E_PT01,
    BgNightModelID.NIG_MADO_E_PT02,
    BgNightModelID.NIG_MADO_E_PT03,
    BgNightModelID.NIG_MADO_E_PT04,
    BgNightModelID.NIG_MADO_E_PT05,
    BgNightModelID.NIG_MADO_E_PT06,
    BgNightModelID.NIG_MADO_E_PT07,
    BgNightModelID.NIG_MADO_E_PT08,
    BgNightModelID.NIG_MADO_E_PT09,
    BgNightModelID.NIG_MADO_E_PT10,
    BgNightModelID.NIG_MADO_E_PT11,
    BgNightModelID.NIG_MADO_E_PT12,
    BgNightModelID.NIG_MADO_E_PT13,
    BgNightModelID.NIG_MADO_E_PT14,
    BgNightModelID.NIG_MADO_E_PT15,
    BgNightModelID.NIG_MADO_E_PT16,
    BgNightModelID.NIG_MADO_E_PT17,
];

const NIGHT_WINDOW_F_MODELS = [
    BgNightModelID.NIG_MADO_F_PT00,
    BgNightModelID.NIG_MADO_F_PT01,
    BgNightModelID.NIG_MADO_F_PT02,
    BgNightModelID.NIG_MADO_F_PT03,
    BgNightModelID.NIG_MADO_F_PT04,
    BgNightModelID.NIG_MADO_F_PT05,
    BgNightModelID.NIG_MADO_F_PT06,
    BgNightModelID.NIG_MADO_F_PT07,
    BgNightModelID.NIG_MADO_F_PT08,
    BgNightModelID.NIG_MADO_F_PT09,
    BgNightModelID.NIG_MADO_F_PT10,
    BgNightModelID.NIG_MADO_F_PT11,
    BgNightModelID.NIG_MADO_F_PT12,
    BgNightModelID.NIG_MADO_F_PT13,
    BgNightModelID.NIG_MADO_F_PT14,
    BgNightModelID.NIG_MADO_F_PT15,
];

const NIGHT_WINDOW_G_MODELS = [
    BgNightModelID.NIG_MADO_G_PT00,
    BgNightModelID.NIG_MADO_G_PT01,
    BgNightModelID.NIG_MADO_G_PT02,
    BgNightModelID.NIG_MADO_G_PT03,
    BgNightModelID.NIG_MADO_G_PT04,
    BgNightModelID.NIG_MADO_G_PT05,
    BgNightModelID.NIG_MADO_G_PT06,
    BgNightModelID.NIG_MADO_G_PT07,
    BgNightModelID.NIG_MADO_G_PT08,
    BgNightModelID.NIG_MADO_G_PT09,
    BgNightModelID.NIG_MADO_G_PT10,
    BgNightModelID.NIG_MADO_G_PT11,
    BgNightModelID.NIG_MADO_G_PT12,
    BgNightModelID.NIG_MADO_G_PT13,
    BgNightModelID.NIG_MADO_G_PT14,
];

const NIGHT_WINDOW_MODEL_LISTS = [
    NIGHT_WINDOW_A_MODELS,
    NIGHT_WINDOW_B_MODELS,
    NIGHT_WINDOW_C_MODELS,
    NIGHT_WINDOW_D_MODELS,
    NIGHT_WINDOW_E_MODELS,
    NIGHT_WINDOW_F_MODELS,
    NIGHT_WINDOW_G_MODELS,
];

export class BgNight implements Background {
    private bgObjects: BgObjectInst[] = [];

    constructor(state: WorldState, bgObjects: BgObjectInst[]) {
        this.bgObjects = bgObjects;

        for (const modelList of NIGHT_WINDOW_MODEL_LISTS) {
            for (const id of modelList) {
                state.modelCache.getModel(id, GmaSrc.Bg);
            }
        }
    }

    public update(state: WorldState): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].update(state);
        }
    }

    public prepareToRender(state: WorldState, ctx: RenderContext): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].prepareToRender(state, ctx);

            const flipbookAnims = this.bgObjects[i].bgObjectData.flipbookAnims;
            if (flipbookAnims === null) continue;
            for (let j = 0; j < flipbookAnims.nightWindowAnims.length; j++) {
                const windowAnim = flipbookAnims.nightWindowAnims[j];
                const modelListIdx = windowAnim.id - 65;
                const modelList = NIGHT_WINDOW_MODEL_LISTS[modelListIdx] ?? NIGHT_WINDOW_A_MODELS;
                const animFrame = Math.floor(state.time.getAnimTimeFrames() / 2) % modelList.length;
                const windowModel = assertExists(state.modelCache.getModel(modelList[animFrame], GmaSrc.Bg));

                const renderParams = scratchRenderParams;
                renderParams.reset();
                renderParams.lighting = state.lighting;
                renderParams.sort = RenderSort.None;
                mat4.translate(renderParams.viewFromModel, ctx.viewerInput.camera.viewMatrix, windowAnim.pos);
                mat4.rotateZ(
                    renderParams.viewFromModel,
                    renderParams.viewFromModel,
                    S16_TO_RADIANS * windowAnim.rot[2]
                );
                mat4.rotateY(
                    renderParams.viewFromModel,
                    renderParams.viewFromModel,
                    S16_TO_RADIANS * windowAnim.rot[1]
                );
                mat4.rotateX(
                    renderParams.viewFromModel,
                    renderParams.viewFromModel,
                    S16_TO_RADIANS * windowAnim.rot[0]
                );
                windowModel.prepareToRender(ctx, renderParams);
            }
        }
    }
}

type SunsetModel = {
    bgObject: BgObjectInst;
    currTexTranslate: vec3;
    currTexVel: vec3;
    desiredTexVel: vec3;
};

enum BgSunsetMode {
    Default,
    HurryUp,
}

export class BgSunset implements Background {
    private bgObjects: BgObjectInst[] = [];
    private cloudModels: SunsetModel[] = []; // Models to apply texture scroll to
    private lastTimeFrames: number = 0;
    private mode = BgSunsetMode.Default;

    constructor(state: WorldState, bgObjects: BgObjectInst[]) {
        for (const bgObject of bgObjects) {
            const name = bgObject.bgObjectData.modelName;
            if (name === "SUN_GROUND" || name.startsWith("SUN_CLOUD_")) {
                const cloudModel: SunsetModel = {
                    bgObject: bgObject,
                    currTexTranslate: vec3.create(),
                    currTexVel: vec3.create(),
                    desiredTexVel: vec3.create(),
                };
                this.cloudModels.push(cloudModel);

                vec3.set(cloudModel.currTexTranslate, Math.random(), Math.random(), Math.random());
                vec3.set(cloudModel.desiredTexVel, 0, (Math.random() * 0.2 + 0.9) * 0.0015151514671742916, 0);
                vec3.rotateZ(cloudModel.desiredTexVel, cloudModel.desiredTexVel, Vec3Zero, Math.random() * Math.PI);
                vec3.copy(cloudModel.currTexVel, cloudModel.desiredTexVel);
            } else {
                this.bgObjects.push(bgObject);
            }
        }
    }

    public update(state: WorldState): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].update(state);
        }

        // At 11s remaining on the clock ("hurry up!"), change cloud scroll direction and speed up
        let speedUpClouds = false;
        if (this.mode === BgSunsetMode.Default && state.time.getStageTimeFrames() < 660) {
            this.mode = BgSunsetMode.HurryUp;
            speedUpClouds = true;
        }

        for (let i = 0; i < this.cloudModels.length; i++) {
            const cloudModel = this.cloudModels[i];
            cloudModel.bgObject.update(state);
            if (speedUpClouds) {
                vec3.set(cloudModel.desiredTexVel, 0, (Math.random() * 0.2 + 0.9) * 0.0030303029343485832, 0);
                vec3.rotateZ(cloudModel.desiredTexVel, cloudModel.desiredTexVel, Vec3Zero, Math.random() * Math.PI);
            }
            // Exponential interpolate desired tex vel towards current tex vel
            const lerp = Math.pow(0.95, state.time.getDeltaTimeFrames()); // Adjust lerp multipler for framerate
            vec3.lerp(cloudModel.currTexVel, cloudModel.desiredTexVel, cloudModel.currTexVel, lerp);
            vec3.scaleAndAdd(
                cloudModel.currTexTranslate,
                cloudModel.currTexTranslate,
                cloudModel.currTexVel,
                state.time.getDeltaTimeFrames()
            );
        }
    }

    public prepareToRender(state: WorldState, ctx: RenderContext): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].prepareToRender(state, ctx);
        }

        for (let i = 0; i < this.cloudModels.length; i++) {
            const cloudModel = this.cloudModels[i];
            const texMtx = scratchMat4a;
            mat4.fromTranslation(texMtx, cloudModel.currTexTranslate);
            cloudModel.bgObject.prepareToRender(state, ctx, texMtx);
        }
    }
}

export class BgSpace implements Background {
    private bgObjects: BgObjectInst[] = [];

    constructor(state: WorldState, bgObjects: BgObjectInst[]) {
        this.bgObjects = bgObjects;
    }

    public update(state: WorldState): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].update(state);
        }
    }

    public prepareToRender(state: WorldState, ctx: RenderContext): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].prepareToRender(state, ctx);
        }
    }
}

export class BgSand implements Background {
    private bgObjects: BgObjectInst[] = [];

    constructor(state: WorldState, bgObjects: BgObjectInst[]) {
        this.bgObjects = bgObjects;
    }

    public update(state: WorldState): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].update(state);
        }
    }

    public prepareToRender(state: WorldState, ctx: RenderContext): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].prepareToRender(state, ctx);
        }
    }
}

export class BgIce implements Background {
    private bgObjects: BgObjectInst[] = [];

    constructor(state: WorldState, bgObjects: BgObjectInst[]) {
        this.bgObjects = bgObjects;
    }

    public update(state: WorldState): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].update(state);
        }
    }

    public prepareToRender(state: WorldState, ctx: RenderContext): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].prepareToRender(state, ctx);
        }
    }
}

const STORM_FIRE_MODELS = [
    BgStormModelID.STM_FIRE00,
    BgStormModelID.STM_FIRE01,
    BgStormModelID.STM_FIRE02,
    BgStormModelID.STM_FIRE03,
    BgStormModelID.STM_FIRE04,
    BgStormModelID.STM_FIRE05,
    BgStormModelID.STM_FIRE06,
    BgStormModelID.STM_FIRE07,
    BgStormModelID.STM_FIRE08,
    BgStormModelID.STM_FIRE09,
    BgStormModelID.STM_FIRE10,
    BgStormModelID.STM_FIRE11,
    BgStormModelID.STM_FIRE12,
    BgStormModelID.STM_FIRE13,
    BgStormModelID.STM_FIRE14,
    BgStormModelID.STM_FIRE15,
    BgStormModelID.STM_FIRE16,
    BgStormModelID.STM_FIRE17,
    BgStormModelID.STM_FIRE18,
    BgStormModelID.STM_FIRE19,
    BgStormModelID.STM_FIRE20,
    BgStormModelID.STM_FIRE21,
    BgStormModelID.STM_FIRE22,
    BgStormModelID.STM_FIRE23,
    BgStormModelID.STM_FIRE24,
    BgStormModelID.STM_FIRE25,
    BgStormModelID.STM_FIRE26,
    BgStormModelID.STM_FIRE27,
    BgStormModelID.STM_FIRE28,
    BgStormModelID.STM_FIRE29,
    BgStormModelID.STM_FIRE30,
    BgStormModelID.STM_FIRE31,
];

export class BgStorm implements Background {
    private bgObjects: BgObjectInst[] = [];

    constructor(state: WorldState, bgObjects: BgObjectInst[]) {
        this.bgObjects = bgObjects;

        // Cache fire models
        for (const id of STORM_FIRE_MODELS) {
            state.modelCache.getModel(id, GmaSrc.Bg);
        }
    }

    public update(state: WorldState): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].update(state);
        }
    }

    public prepareToRender(state: WorldState, ctx: RenderContext): void {
        // Face fire towards camera on Y axis
        const cameraRotY = getMat4RotY(ctx.viewerInput.camera.worldMatrix);

        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].prepareToRender(state, ctx);

            const flipbookAnims = this.bgObjects[i].bgObjectData.flipbookAnims;
            if (flipbookAnims === null) continue;
            for (let j = 0; j < flipbookAnims.stormFireAnims.length; j++) {
                const fireAnim = flipbookAnims.stormFireAnims[j];
                const fireFrame =
                    (Math.floor(state.time.getAnimTimeFrames()) + 4 * fireAnim.frameOffset) % STORM_FIRE_MODELS.length;
                const fireModel = assertExists(state.modelCache.getModel(STORM_FIRE_MODELS[fireFrame], GmaSrc.Bg));

                const renderParams = scratchRenderParams;
                renderParams.reset();
                renderParams.lighting = state.lighting;
                mat4.translate(renderParams.viewFromModel, ctx.viewerInput.camera.viewMatrix, fireAnim.pos);
                mat4.rotateY(renderParams.viewFromModel, renderParams.viewFromModel, cameraRotY);
                fireModel.prepareToRender(ctx, renderParams);
            }
        }
    }
}

export class BgBonus implements Background {
    private bgObjects: BgObjectInst[] = [];
    private mainObject: BgObjectInst | null = null;
    private starlightModel: ModelInst | null = null;
    private starpoints: {
        pos: vec3;
        phase: number;
        phaseSpeed: number;
        red: number;
        green: number;
        blue: number;
    }[] = [];

    constructor(state: WorldState, bgObjects: BgObjectInst[]) {
        this.bgObjects = bgObjects;
        this.mainObject = bgObjects.find((bgObject) => bgObject.bgObjectData.modelName === BONUS_MAIN_OBJECT)
            ?? bgObjects[0]
            ?? null;

        const bgModelNames = state.modelCache.getModelNames(GmaSrc.Bg);
        const starlightName = bgModelNames.find((name) => name.startsWith(BONUS_STARLIGHT_PREFIX));
        if (starlightName) {
            this.starlightModel = state.modelCache.getModel(starlightName, GmaSrc.Bg);
        }
        const starpointNames = bgModelNames
            .filter((name) => name.startsWith(BONUS_STARPOINT_PREFIX))
            .slice(0, BONUS_MAX_STARPOINTS);
        for (const name of starpointNames) {
            const model = state.modelCache.getModel(name, GmaSrc.Bg);
            if (!model) {
                continue;
            }
            this.starpoints.push({
                pos: vec3.clone(model.modelData.boundSphereCenter),
                phase: Math.random() * Math.PI * 2,
                phaseSpeed: (1.0 + Math.random() * 0.5) * BONUS_STAR_PHASE_STEP,
                red: 1,
                green: 1,
                blue: 1,
            });
        }
    }

    public update(state: WorldState): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].update(state);
        }

        const deltaFrames = Math.max(0, state.time.getDeltaTimeFrames());
        for (const star of this.starpoints) {
            star.phase += star.phaseSpeed * deltaFrames;
            const intensity = (Math.sin(star.phase) + 1) * 0.25 + 0.5;
            star.red = Math.min(1, intensity * 1.1);
            star.green = Math.min(1, intensity * 1.05);
            star.blue = intensity;
        }
    }

    public prepareToRender(state: WorldState, ctx: RenderContext): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].prepareToRender(state, ctx);
        }

        if (!this.mainObject || !this.starlightModel || this.starpoints.length === 0) {
            return;
        }

        const worldFromMain = scratchBonusMat4a;
        this.mainObject.copyWorldFromModel(worldFromMain);

        const rp = scratchRenderParams;
        for (const star of this.starpoints) {
            const worldPos = scratchBonusVec3a;
            transformVec3Mat4w1(worldPos, worldFromMain, star.pos);
            const viewPos = scratchBonusVec3b;
            transformVec3Mat4w1(viewPos, ctx.viewerInput.camera.viewMatrix, worldPos);
            if (viewPos[2] >= BONUS_STAR_MIN_Z) {
                continue;
            }
            const f3 = (BONUS_STAR_PROJ_OFFSET + viewPos[2]) / viewPos[2];
            if (!(f3 > 0)) {
                continue;
            }
            const pulse = (star.red + star.green + star.blue) * BONUS_STAR_PULSE_SCALE;
            const drawScale = pulse * f3;
            if (!(drawScale > 0)) {
                continue;
            }

            const drawX = viewPos[0] * f3;
            const drawY = viewPos[1] * f3;
            const drawZ = viewPos[2] * f3;

            rp.reset();
            rp.alpha = 1;
            rp.sort = RenderSort.Translucent;
            rp.colorMul.r = star.red;
            rp.colorMul.g = star.green;
            rp.colorMul.b = star.blue;
            rp.colorMul.a = 1;
            rp.lighting = state.lighting;
            rp.megaStateFlags = { depthWrite: false };
            mat4.fromTranslation(rp.viewFromModel, [drawX, drawY, drawZ]);
            mat4.scale(rp.viewFromModel, rp.viewFromModel, [drawScale, drawScale, drawScale]);
            this.starlightModel.prepareToRender(ctx, rp);
        }
    }
}

export class BgMaster implements Background {
    private bgObjects: BgObjectInst[] = [];

    constructor(state: WorldState, bgObjects: BgObjectInst[]) {
        this.bgObjects = bgObjects;
    }

    public update(state: WorldState): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].update(state);
        }
    }

    public prepareToRender(state: WorldState, ctx: RenderContext): void {
        for (let i = 0; i < this.bgObjects.length; i++) {
            this.bgObjects[i].prepareToRender(state, ctx);
        }
    }
}
