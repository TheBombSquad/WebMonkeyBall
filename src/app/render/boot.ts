import { Camera } from '../../noclip/Camera.js';
import {
  GfxDevice,
  GfxFormat,
  GfxTextureUsage,
  makeTextureDescriptor2D,
  type GfxTexture,
} from '../../noclip/gfx/platform/GfxPlatform.js';
import {
  GfxPlatformWebGL2Config,
  createSwapChainForWebGL2,
} from '../../noclip/gfx/platform/GfxPlatformWebGL2.js';
import { AntialiasingMode } from '../../noclip/gfx/helpers/RenderGraphHelpers.js';
import { Renderer } from '../../noclip/Render.js';

type PrewarmTargetState = {
  device: GfxDevice | null;
  texture: GfxTexture | null;
  width: number;
  height: number;
};

// Keep prewarm draws off-screen so stage instantiation cannot flash on the visible canvas.
const prewarmTargetState: PrewarmTargetState = {
  device: null,
  texture: null,
  width: 0,
  height: 0,
};

function getPrewarmTargetTexture(device: GfxDevice, width: number, height: number): GfxTexture {
  if (
    prewarmTargetState.texture
    && prewarmTargetState.device === device
    && prewarmTargetState.width === width
    && prewarmTargetState.height === height
  ) {
    return prewarmTargetState.texture;
  }
  if (prewarmTargetState.texture && prewarmTargetState.device) {
    prewarmTargetState.device.destroyTexture(prewarmTargetState.texture);
  }
  const desc = makeTextureDescriptor2D(GfxFormat.U8_RGBA_RT, width, height, 1);
  desc.usage = GfxTextureUsage.RenderTarget | GfxTextureUsage.Sampled;
  const texture = device.createTexture(desc);
  prewarmTargetState.device = device;
  prewarmTargetState.texture = texture;
  prewarmTargetState.width = width;
  prewarmTargetState.height = height;
  return texture;
}

export type ViewerInputState = {
  camera: Camera;
  time: number;
  deltaTime: number;
  backbufferWidth: number;
  backbufferHeight: number;
  onscreenTexture: unknown;
  antialiasingMode: AntialiasingMode;
  mouseLocation: { mouseX: number; mouseY: number };
  debugConsole: { addInfoLine: (line: string) => void };
};

export function initRendererGfx(canvas: HTMLCanvasElement): {
  swapChain: ReturnType<typeof createSwapChainForWebGL2>;
  gfxDevice: GfxDevice;
  camera: Camera;
  viewerInput: ViewerInputState;
} {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    preserveDrawingBuffer: false,
    depth: false,
    stencil: false,
  });
  if (!gl) {
    throw new Error('WebGL2 is required.');
  }

  const config = new GfxPlatformWebGL2Config();
  config.trackResources = false;
  config.shaderDebug = false;

  const swapChain = createSwapChainForWebGL2(gl, config);
  const gfxDevice = swapChain.getDevice();
  const camera = new Camera();
  camera.clipSpaceNearZ = gfxDevice.queryVendorInfo().clipSpaceNearZ;
  const viewerInput: ViewerInputState = {
    camera,
    time: 0,
    deltaTime: 0,
    backbufferWidth: canvas.width,
    backbufferHeight: canvas.height,
    onscreenTexture: null,
    antialiasingMode: AntialiasingMode.None,
    mouseLocation: { mouseX: 0, mouseY: 0 },
    debugConsole: { addInfoLine: () => {} },
  };

  canvas.addEventListener('mousemove', (event) => {
    viewerInput.mouseLocation.mouseX = event.clientX * window.devicePixelRatio;
    viewerInput.mouseLocation.mouseY = event.clientY * window.devicePixelRatio;
  });

  return { swapChain, gfxDevice, camera, viewerInput };
}

export function prewarmConfettiRenderer(
  canvas: HTMLCanvasElement,
  renderer: Renderer | null,
  gfxDevice: GfxDevice | null,
  swapChain: ReturnType<typeof createSwapChainForWebGL2> | null,
  viewerInput: ViewerInputState | null,
  resizeCanvasToDisplaySize: (canvasElem: HTMLCanvasElement) => void,
) {
  if (!renderer || !gfxDevice || !swapChain || !viewerInput) {
    return;
  }
  resizeCanvasToDisplaySize(canvas);
  const renderWidth = Math.max(1, canvas.width);
  const renderHeight = Math.max(1, canvas.height);
  viewerInput.backbufferWidth = renderWidth;
  viewerInput.backbufferHeight = renderHeight;
  swapChain.configureSwapChain(renderWidth, renderHeight);
  const prewarmTarget = getPrewarmTargetTexture(gfxDevice, renderWidth, renderHeight);
  const prevOnscreenTexture = viewerInput.onscreenTexture;
  gfxDevice.beginFrame();
  try {
    viewerInput.onscreenTexture = prewarmTarget;
    renderer.prewarmConfetti(gfxDevice, viewerInput);
  } finally {
    viewerInput.onscreenTexture = prevOnscreenTexture;
    gfxDevice.endFrame();
  }
}
