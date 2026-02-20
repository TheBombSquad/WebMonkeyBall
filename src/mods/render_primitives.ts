import type { Vec3 } from '../shared/types.js';

export type RibbonRenderPrimitive = {
  kind: 'ribbon';
  id: number;
  points: Vec3[];
  width: number;
  alpha: number;
  alphaClip?: boolean;
  colorR?: number;
  colorG?: number;
  colorB?: number;
  textureName?: string;
  uScale?: number;
  depthTest?: boolean;
  additiveBlend?: boolean;
};

export type QuadRenderPrimitive = {
  kind: 'quad';
  corners: [Vec3, Vec3, Vec3, Vec3];
  alpha: number;
  alphaClip?: boolean;
  colorR?: number;
  colorG?: number;
  colorB?: number;
  textureName?: string;
  depthTest?: boolean;
  additiveBlend?: boolean;
  uMin?: number;
  uMax?: number;
  vMin?: number;
  vMax?: number;
};

export type ModRenderPrimitive = RibbonRenderPrimitive | QuadRenderPrimitive;
