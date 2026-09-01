import earcut from 'earcut';
import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MapLibreMap,
} from 'maplibre-gl';
import type { Layer, RegionGeometry } from './project';
import { resolveFlagCode } from './regions';
import { regionPresentation } from './regions';

export const ONLINE_GEOGRAPHIC_REGION_FILL_LAYER_ID = 'mapmotion-geographic-region-fills';
const imagePromises = new Map<string, Promise<HTMLCanvasElement>>();
const resolvedImages = new Map<string, HTMLCanvasElement>();
let imageDecodeCount = 0;
export const loadGeographicRegionImage = (url: string) => {
  let promise = imagePromises.get(url);
  if (!promise) {
    promise = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Region image failed: HTTP ${response.status}`);
      const objectUrl = URL.createObjectURL(await response.blob());
      try {
        const image = new Image();
        image.src = objectUrl;
        await image.decode();
        imageDecodeCount += 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, image.naturalWidth);
        canvas.height = Math.max(1, image.naturalHeight);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Unable to create durable Region texture.');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolvedImages.set(url, canvas);
        return canvas;
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    })();
    imagePromises.set(url, promise);
  }
  return promise;
};

type Entry = {
  key: string;
  staticSignature: string;
  url: string;
  vertices: Float32Array;
  buffer?: WebGLBuffer;
  opacity: number;
  mode: 'tile' | 'cover' | 'fit';
};
export interface GeographicRegionFillDiagnostics {
  imageDecodes: number;
  triangulations: number;
  meshBuilds: number;
  bufferUploads: number;
  textureUploads: number;
  updateCalls: number;
  drawCalls: number;
}
let triangulationCount = 0;
let meshBuildCount = 0;
let nextGeometryIdentity = 1;
const geometryIdentities = new WeakMap<RegionGeometry, number>();
const geometryIdentity = (geometry: RegionGeometry) => {
  let identity = geometryIdentities.get(geometry);
  if (!identity) {
    identity = nextGeometryIdentity++;
    geometryIdentities.set(geometry, identity);
  }
  return identity;
};
const polygonsOf = (geometry: RegionGeometry): number[][][][] =>
  geometry.type === 'Polygon'
    ? [geometry.coordinates as number[][][]]
    : (geometry.coordinates as number[][][][]);
export const regionGeometryBounds = (geometry: RegionGeometry) => {
  const points = (
    geometry.type === 'Polygon' ? geometry.coordinates.flat(1) : geometry.coordinates.flat(2)
  ) as number[][];
  return points.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point[0]),
      minY: Math.min(bounds.minY, point[1]),
      maxX: Math.max(bounds.maxX, point[0]),
      maxY: Math.max(bounds.maxY, point[1]),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
};

export interface WrappedRegionBounds extends ReturnType<typeof regionGeometryBounds> {
  rawMinX: number;
  rawMaxX: number;
  wrapsAntimeridian: boolean;
}

/** Smallest deterministic longitude interval containing the complete Region. */
export const minimalWrappedRegionBounds = (geometry: RegionGeometry): WrappedRegionBounds => {
  const raw = regionGeometryBounds(geometry);
  const points = (
    geometry.type === 'Polygon' ? geometry.coordinates.flat(1) : geometry.coordinates.flat(2)
  ) as number[][];
  const longitudes = points.map((point) => ((point[0] % 360) + 360) % 360).sort((a, b) => a - b);
  if (longitudes.length < 2)
    return { ...raw, rawMinX: raw.minX, rawMaxX: raw.maxX, wrapsAntimeridian: false };
  let largestGap = -1;
  let intervalStart = longitudes[0];
  for (let index = 0; index < longitudes.length; index += 1) {
    const current = longitudes[index];
    const next = index + 1 < longitudes.length ? longitudes[index + 1] : longitudes[0] + 360;
    const gap = next - current;
    if (gap > largestGap) {
      largestGap = gap;
      intervalStart = next % 360;
    }
  }
  const span = Math.max(0, 360 - largestGap);
  const rawSpan = raw.maxX - raw.minX;
  if (span >= rawSpan - 1e-9)
    return { ...raw, rawMinX: raw.minX, rawMaxX: raw.maxX, wrapsAntimeridian: false };
  return {
    minX: intervalStart,
    maxX: intervalStart + span,
    minY: raw.minY,
    maxY: raw.maxY,
    rawMinX: raw.minX,
    rawMaxX: raw.maxX,
    wrapsAntimeridian: true,
  };
};

const longitudeInBounds = (longitude: number, bounds: WrappedRegionBounds) => {
  if (!bounds.wrapsAntimeridian) return longitude;
  let value = ((longitude % 360) + 360) % 360;
  if (value < bounds.minX) value += 360;
  return value;
};

export const regionTextureUv = (
  longitude: number,
  latitude: number,
  geometry: RegionGeometry,
  imageAspect: number,
  mode: 'tile' | 'cover' | 'fit',
  tileCount: number,
) => {
  const bounds = minimalWrappedRegionBounds(geometry);
  return regionTextureUvForBounds(longitude, latitude, bounds, imageAspect, mode, tileCount);
};

const regionTextureUvForBounds = (
  longitude: number,
  latitude: number,
  bounds: WrappedRegionBounds,
  imageAspect: number,
  mode: 'tile' | 'cover' | 'fit',
  tileCount: number,
) => {
  const width = Math.max(1e-9, bounds.maxX - bounds.minX),
    height = Math.max(1e-9, bounds.maxY - bounds.minY);
  let u = (longitudeInBounds(longitude, bounds) - bounds.minX) / width,
    v = (bounds.maxY - latitude) / height;
  const boundsAspect = width / height;
  if (mode === 'tile') {
    const count = Math.max(1, Math.min(20, Math.round(tileCount)));
    if (boundsAspect >= 1) {
      u *= count;
      v *= (count * imageAspect) / boundsAspect;
    } else {
      v *= count;
      u *= (count * boundsAspect) / imageAspect;
    }
  } else if (mode === 'cover') {
    if (imageAspect > boundsAspect) u = 0.5 + (u - 0.5) * (boundsAspect / imageAspect);
    else v = 0.5 + (v - 0.5) * (imageAspect / boundsAspect);
  } else if (imageAspect > boundsAspect) {
    const occupied = boundsAspect / imageAspect;
    v = (v - (1 - occupied) / 2) / occupied;
  } else {
    const occupied = imageAspect / boundsAspect;
    u = (u - (1 - occupied) / 2) / occupied;
  }
  return [u, v] as const;
};

type TriangulatedGeometry = {
  triangles: Float64Array;
  polygonCount: number;
  ringCount: number;
  vertexCount: number;
};
const triangulationCache = new WeakMap<RegionGeometry, TriangulatedGeometry>();
const triangulateGeometry = (geometry: RegionGeometry) => {
  const cached = triangulationCache.get(geometry);
  if (cached) return cached;
  const triangles: number[] = [];
  let ringCount = 0;
  let vertexCount = 0;
  const polygons = polygonsOf(geometry);
  for (const polygon of polygons) {
    const flat: number[] = [],
      holes: number[] = [];
    polygon.forEach((ring, ringIndex) => {
      ringCount += 1;
      if (ringIndex > 0) holes.push(flat.length / 2);
      const points =
        ring.length > 1 && ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1]
          ? ring.slice(0, -1)
          : ring;
      vertexCount += points.length;
      for (const point of points) flat.push(point[0], point[1]);
    });
    for (const index of earcut(flat, holes, 2)) {
      triangles.push(flat[index * 2], flat[index * 2 + 1]);
    }
  }
  triangulationCount += 1;
  const result = {
    triangles: new Float64Array(triangles),
    polygonCount: polygons.length,
    ringCount,
    vertexCount,
  };
  triangulationCache.set(geometry, result);
  return result;
};

const meshCache = new WeakMap<RegionGeometry, Map<string, Float32Array>>();
export const meshFor = (
  geometry: RegionGeometry,
  imageAspect: number,
  mode: 'tile' | 'cover' | 'fit',
  tileCount: number,
) => {
  let variants = meshCache.get(geometry);
  if (!variants) {
    variants = new Map();
    meshCache.set(geometry, variants);
  }
  const variant = `${imageAspect.toFixed(8)}:${mode}:${Math.max(1, Math.min(20, Math.round(tileCount)))}`;
  const cached = variants.get(variant);
  if (cached) return cached;
  const output: number[] = [];
  const topology = triangulateGeometry(geometry);
  const bounds = minimalWrappedRegionBounds(geometry);
  for (let index = 0; index < topology.triangles.length; index += 2) {
    const longitude = topology.triangles[index],
      latitude = topology.triangles[index + 1];
    const mercator = MercatorCoordinate.fromLngLat([longitude, latitude]);
    const [u, v] = regionTextureUvForBounds(longitude, latitude, bounds, imageAspect, mode, tileCount);
    output.push(mercator.x, mercator.y, u, v);
  }
  meshBuildCount += 1;
  const result = new Float32Array(output);
  variants.set(variant, result);
  return result;
};

export const regionGeometryStatistics = (geometry: RegionGeometry) => {
  const topology = triangulateGeometry(geometry);
  return { ...topology, triangles: topology.triangles.length / 6 };
};

const compileShader = (gl: WebGLRenderingContext | WebGL2RenderingContext, type: number, source: string) => {
  const result = gl.createShader(type)!;
  gl.shaderSource(result, source);
  gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(result) ?? 'Region shader failed.');
  return result;
};

export class GeographicRegionFillLayer implements CustomLayerInterface {
  id = ONLINE_GEOGRAPHIC_REGION_FILL_LAYER_ID;
  type = 'custom' as const;
  renderingMode = '2d' as const;
  private map?: MapLibreMap;
  private program?: WebGLProgram;
  private vertexArray?: WebGLVertexArrayObject;
  private vertexShader?: WebGLShader;
  private fragmentShader?: WebGLShader;
  private entries: Entry[] = [];
  private textures = new Map<string, WebGLTexture>();
  private images = new Map<string, HTMLCanvasElement>();
  private desired = new Map<string, string>();
  private gl?: WebGLRenderingContext | WebGL2RenderingContext;
  private diagnostics = { bufferUploads: 0, textureUploads: 0, updateCalls: 0, drawCalls: 0 };
  getDiagnostics(): GeographicRegionFillDiagnostics {
    return {
      imageDecodes: imageDecodeCount,
      triangulations: triangulationCount,
      meshBuilds: meshBuildCount,
      ...this.diagnostics,
    };
  }
  private releaseEntry(entry: Entry) {
    if (entry.buffer && this.gl) this.gl.deleteBuffer(entry.buffer);
  }
  update(
    layers: readonly Layer[],
    assetUrls: Readonly<Record<string, string>>,
    flagUrl: (code?: string) => string | undefined,
  ) {
    this.diagnostics.updateCalls += 1;
    const nextKeys = new Set<string>();
    for (const layer of layers) {
      if (
        layer.type !== 'region' ||
        !layer.visible ||
        !layer.regionGeometry ||
        (layer.regionFillMode !== 'flag' && layer.regionFillMode !== 'image')
      )
        continue;
      const code = resolveFlagCode(layer.regionCountryCode, layer.regionCountryCode2);
      const url =
        layer.regionFillMode === 'flag'
          ? flagUrl(code)
          : layer.regionImageAssetId
            ? assetUrls[layer.regionImageAssetId]
            : undefined;
      if (!url) continue;
      nextKeys.add(layer.id);
      const mode = layer.regionImageMode ?? 'cover';
      const tileCount = layer.regionTileCount ?? 4;
      const existing = this.entries.find((entry) => entry.key === layer.id);
      const dynamicOpacity =
        layer.opacity * (layer.regionFillOpacity ?? 0.35) * regionPresentation(layer).fillFactor;
      const pendingSignature = `${geometryIdentity(layer.regionGeometry)}:${url}:${mode}:${tileCount}`;
      this.desired.set(layer.id, pendingSignature);
      if (existing && existing.staticSignature.startsWith(`${pendingSignature}:`)) {
        existing.opacity = dynamicOpacity;
        continue;
      }
      const install = (image: HTMLCanvasElement) => {
        if (this.desired.get(layer.id) !== pendingSignature) return;
        this.images.set(url, image);
        const aspect = image.width / Math.max(1, image.height);
        const staticSignature = `${pendingSignature}:${aspect.toFixed(8)}`;
        const entry: Entry = {
          key: layer.id,
          staticSignature,
          url,
          vertices: meshFor(layer.regionGeometry!, aspect, mode, tileCount),
          opacity: dynamicOpacity,
          mode,
        };
        const index = this.entries.findIndex((item) => item.key === layer.id);
        if (index >= 0) {
          this.releaseEntry(this.entries[index]);
          this.entries[index] = entry;
        } else this.entries.push(entry);
        this.map?.triggerRepaint();
      };
      const ready = this.images.get(url) ?? resolvedImages.get(url);
      if (ready) install(ready);
      else void loadGeographicRegionImage(url).then(install);
    }
    this.entries = this.entries.filter((entry) => {
      const keep = nextKeys.has(entry.key);
      if (!keep) this.releaseEntry(entry);
      return keep;
    });
    for (const key of this.desired.keys()) if (!nextKeys.has(key)) this.desired.delete(key);
    const usedUrls = new Set(this.entries.map((entry) => entry.url));
    for (const [url, texture] of this.textures) {
      if (usedUrls.has(url)) continue;
      this.gl?.deleteTexture(texture);
      this.textures.delete(url);
      this.images.delete(url);
    }
  }
  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;
    const program = gl.createProgram()!;
    const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const vertexSource = webgl2
      ? '#version 300 es\nin vec2 a_pos;in vec2 a_uv;uniform mat4 u_matrix;out vec2 v_uv;void main(){v_uv=a_uv;gl_Position=u_matrix*vec4(a_pos,0.0,1.0);}'
      : 'attribute vec2 a_pos;attribute vec2 a_uv;uniform mat4 u_matrix;varying vec2 v_uv;void main(){v_uv=a_uv;gl_Position=u_matrix*vec4(a_pos,0.0,1.0);}';
    const fragmentSource = webgl2
      ? '#version 300 es\nprecision mediump float;uniform sampler2D u_image;uniform float u_opacity;uniform float u_fit;in vec2 v_uv;out vec4 outColor;void main(){if(u_fit>.5&&(v_uv.x<0.||v_uv.x>1.||v_uv.y<0.||v_uv.y>1.))discard;vec4 c=texture(u_image,v_uv);outColor=vec4(c.rgb*c.a*u_opacity,c.a*u_opacity);}'
      : 'precision mediump float;uniform sampler2D u_image;uniform float u_opacity;uniform float u_fit;varying vec2 v_uv;void main(){if(u_fit>.5&&(v_uv.x<0.||v_uv.x>1.||v_uv.y<0.||v_uv.y>1.))discard;vec4 c=texture2D(u_image,v_uv);gl_FragColor=vec4(c.rgb*c.a*u_opacity,c.a*u_opacity);}';
    this.vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    this.fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, this.vertexShader);
    gl.attachShader(program, this.fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) ?? 'Region program failed.');
    this.program = program;
    if (webgl2) this.vertexArray = gl.createVertexArray() ?? undefined;
  }
  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput) {
    if (!this.program) return;
    const gl2 =
      typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? gl : undefined;
    if (gl2) gl2.bindVertexArray(this.vertexArray ?? null);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(
      gl.getUniformLocation(this.program, 'u_matrix'),
      false,
      options.defaultProjectionData.mainMatrix as Float32List,
    );
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_image'), 0);
    const pos = gl.getAttribLocation(this.program, 'a_pos'),
      uv = gl.getAttribLocation(this.program, 'a_uv');
    gl.enableVertexAttribArray(pos);
    gl.enableVertexAttribArray(uv);
    for (const entry of this.entries) {
      const image = this.images.get(entry.url);
      if (!image || !entry.vertices.length) continue;
      let texture = this.textures.get(entry.url);
      if (!texture) {
        texture = gl.createTexture()!;
        this.textures.set(entry.url, texture);
        this.diagnostics.textureUploads += 1;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      } else gl.bindTexture(gl.TEXTURE_2D, texture);
      const wrap = entry.mode === 'tile' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      if (!entry.buffer) {
        entry.buffer = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, entry.vertices, gl.STATIC_DRAW);
        this.diagnostics.bufferUploads += 1;
      } else gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
      gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 16, 0);
      gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
      gl.uniform1f(gl.getUniformLocation(this.program, 'u_opacity'), entry.opacity);
      gl.uniform1f(gl.getUniformLocation(this.program, 'u_fit'), entry.mode === 'fit' ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, entry.vertices.length / 4);
      this.diagnostics.drawCalls += 1;
    }
    if (gl2) gl2.bindVertexArray(null);
  }
  onRemove(_map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    for (const texture of this.textures.values()) gl.deleteTexture(texture);
    for (const entry of this.entries) if (entry.buffer) gl.deleteBuffer(entry.buffer);
    if (this.vertexArray && gl instanceof WebGL2RenderingContext) gl.deleteVertexArray(this.vertexArray);
    if (this.program) gl.deleteProgram(this.program);
    if (this.vertexShader) gl.deleteShader(this.vertexShader);
    if (this.fragmentShader) gl.deleteShader(this.fragmentShader);
    this.textures.clear();
    this.entries = [];
    this.map = undefined;
    this.gl = undefined;
  }
}
