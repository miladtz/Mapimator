import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MapLibreMap,
} from 'maplibre-gl';
import {
  animatedMediaFrameAtTime,
  animatedMediaScreenOffsets,
  animatedWebPBytesFromDataUrl,
  animatedWebPCanvasSize,
  type AnimatedWebPInfo,
} from './animatedMedia';
import { mapMotionWorldToLngLat } from './openFreeMapAdapter';
import type { Layer } from './project';

export const ONLINE_ANIMATED_MEDIA_LAYER_ID = 'mapmotion-project-animated-media';
export const onlineAnimatedMediaLayerId = (projectLayerId: string) =>
  `${ONLINE_ANIMATED_MEDIA_LAYER_ID}-${projectLayerId}`;
const MAX_CPU_FRAMES = 4;

interface ImageDecoderLike {
  tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number; repetitionCount?: number } | null };
  decode(options: { frameIndex: number; completeFramesOnly?: boolean }): Promise<{ image: VideoFrame }>;
  close(): void;
}
interface ImageDecoderConstructor {
  new (options: { data: BufferSource; type: string; preferAnimation?: boolean }): ImageDecoderLike;
}
interface CachedFrame {
  bitmap: ImageBitmap;
  used: number;
}
interface DecodedAsset {
  decoder: ImageDecoderLike;
  info: AnimatedWebPInfo;
  frames: Map<number, CachedFrame>;
  pending: Map<number, Promise<ImageBitmap>>;
}
interface Entry {
  layer: Layer;
  url: string;
  buffer?: WebGLBuffer;
  texture?: WebGLTexture;
  uploadedFrame?: number;
}

const assets = new Map<string, Promise<DecodedAsset>>();
let cacheClock = 0;

const decoderConstructor = () =>
  (globalThis as typeof globalThis & { ImageDecoder?: ImageDecoderConstructor }).ImageDecoder;

export const decodeAnimatedWebP = async (url: string): Promise<DecodedAsset> => {
  let pending = assets.get(url);
  if (!pending) {
    pending = (async () => {
      const Decoder = decoderConstructor();
      if (!Decoder)
        throw new Error('Animated WebP requires the WebCodecs ImageDecoder available in WebView2.');
      const bytes = animatedWebPBytesFromDataUrl(url);
      const canvas = animatedWebPCanvasSize(bytes);
      const decoder = new Decoder({ data: bytes, type: 'image/webp', preferAnimation: true });
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack;
      if (!track || track.frameCount < 2)
        throw new Error('This WebP does not contain multiple animation frames.');
      const frames = [];
      let startMs = 0;
      for (let index = 0; index < track.frameCount; index += 1) {
        const result = await decoder.decode({ frameIndex: index, completeFramesOnly: true });
        const durationMs = Math.max(1, (result.image.duration ?? 100_000) / 1000);
        frames.push({ index, startMs, durationMs });
        startMs += durationMs;
        result.image.close();
      }
      return {
        decoder,
        info: {
          frameCount: track.frameCount,
          cycleDurationMs: startMs,
          repetitionCount: track.repetitionCount ?? 0,
          canvasWidth: canvas.width,
          canvasHeight: canvas.height,
          frames,
        },
        frames: new Map(),
        pending: new Map(),
      };
    })();
    assets.set(url, pending as Promise<DecodedAsset>);
  }
  try {
    return await pending!;
  } catch (error) {
    assets.delete(url);
    throw error;
  }
};

const frameBitmap = async (asset: DecodedAsset, index: number) => {
  const cached = asset.frames.get(index);
  if (cached) {
    cached.used = ++cacheClock;
    return cached.bitmap;
  }
  let pending = asset.pending.get(index);
  if (!pending) {
    pending = asset.decoder
      .decode({ frameIndex: index, completeFramesOnly: true })
      .then(async ({ image }) => {
        const decoded = await createImageBitmap(image);
        image.close();
        const canvas = new OffscreenCanvas(asset.info.canvasWidth, asset.info.canvasHeight);
        const context = canvas.getContext('2d');
        if (!context) {
          decoded.close();
          throw new Error('Animated Media frame compositor is unavailable.');
        }
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(decoded, 0, 0, canvas.width, canvas.height);
        decoded.close();
        const bitmap = await createImageBitmap(canvas);
        asset.frames.set(index, { bitmap, used: ++cacheClock });
        asset.pending.delete(index);
        while (asset.frames.size > MAX_CPU_FRAMES) {
          const oldest = [...asset.frames].sort((a, b) => a[1].used - b[1].used)[0];
          oldest[1].bitmap.close();
          asset.frames.delete(oldest[0]);
        }
        return bitmap;
      });
    asset.pending.set(index, pending);
  }
  return pending;
};

const shader = (gl: WebGLRenderingContext | WebGL2RenderingContext, type: number, source: string) => {
  const value = gl.createShader(type)!;
  gl.shaderSource(value, source);
  gl.compileShader(value);
  if (!gl.getShaderParameter(value, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(value) ?? 'Animated Media shader failed.');
  return value;
};

export class OnlineAnimatedMediaLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;
  private map?: MapLibreMap;
  private gl?: WebGLRenderingContext | WebGL2RenderingContext;
  private program?: WebGLProgram;
  private entries: Entry[] = [];
  private prepared = new Map<string, DecodedAsset>();
  readonly diagnostics = { decodes: 0, textureUploads: 0, drawCalls: 0, cachedFrames: 0 };

  constructor(projectLayerId: string) {
    this.id = onlineAnimatedMediaLayerId(projectLayerId);
  }

  async prepare(layers: readonly Layer[], urls: Readonly<Record<string, string>>) {
    for (const layer of layers) {
      if (layer.type !== 'animated-media' || !layer.assetId || !urls[layer.assetId]) continue;
      const url = urls[layer.assetId];
      const asset = await decodeAnimatedWebP(url);
      if (!this.prepared.has(url)) {
        this.prepared.set(url, asset);
        this.diagnostics.decodes += 1;
      }
      const index = animatedMediaFrameAtTime(asset.info, layer.animatedMediaTimeMs ?? 0, 'loop');
      await frameBitmap(asset, index);
    }
    this.diagnostics.cachedFrames = [...this.prepared.values()].reduce(
      (sum, asset) => sum + asset.frames.size,
      0,
    );
    this.map?.triggerRepaint();
  }

  update(layers: readonly Layer[], urls: Readonly<Record<string, string>>) {
    const old = new Map(this.entries.map((entry) => [entry.layer.id, entry]));
    this.entries = layers.flatMap((layer) => {
      if (layer.type !== 'animated-media' || !layer.visible || !layer.assetId || !urls[layer.assetId])
        return [];
      const prior = old.get(layer.id);
      if (prior) {
        prior.layer = layer;
        prior.url = urls[layer.assetId];
        old.delete(layer.id);
        return [prior];
      }
      return [{ layer, url: urls[layer.assetId] }];
    });
    for (const entry of old.values()) {
      if (entry.buffer) this.gl?.deleteBuffer(entry.buffer);
      if (entry.texture) this.gl?.deleteTexture(entry.texture);
    }
    void this.prepare(layers, urls);
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;
    const vs = shader(
      gl,
      gl.VERTEX_SHADER,
      'attribute vec2 a_pos;attribute vec2 a_px;attribute vec2 a_uv;uniform mat4 u_matrix;uniform vec2 u_viewport;varying vec2 v_uv;void main(){vec4 p=u_matrix*vec4(a_pos,0.,1.);p.xy+=vec2(2.*a_px.x/u_viewport.x,-2.*a_px.y/u_viewport.y)*p.w;gl_Position=p;v_uv=a_uv;}',
    );
    const fs = shader(
      gl,
      gl.FRAGMENT_SHADER,
      'precision mediump float;uniform sampler2D u_image;uniform float u_opacity;varying vec2 v_uv;void main(){vec4 c=texture2D(u_image,v_uv);gl_FragColor=vec4(c.rgb*c.a*u_opacity,c.a*u_opacity);}',
    );
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(this.program) ?? 'Animated Media program failed.');
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput) {
    if (!this.program) return;
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.uniformMatrix4fv(
      gl.getUniformLocation(this.program, 'u_matrix'),
      false,
      options.defaultProjectionData.mainMatrix as Float32List,
    );
    const canvas = this.map?.getCanvas();
    gl.uniform2f(
      gl.getUniformLocation(this.program, 'u_viewport'),
      canvas?.clientWidth ?? 1,
      canvas?.clientHeight ?? 1,
    );
    for (const entry of this.entries) {
      const asset = this.prepared.get(entry.url);
      if (!asset) continue;
      const index = animatedMediaFrameAtTime(asset.info, entry.layer.animatedMediaTimeMs ?? 0, 'loop');
      const frame = asset.frames.get(index)?.bitmap;
      if (!frame) {
        void frameBitmap(asset, index).then(() => this.map?.triggerRepaint());
        continue;
      }
      if (!entry.texture) {
        entry.texture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, entry.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      } else gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      if (entry.uploadedFrame !== index) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        entry.uploadedFrame = index;
        this.diagnostics.textureUploads += 1;
      }
      const width = entry.layer.width ?? 160,
        height = entry.layer.height ?? 90;
      const anchor = MercatorCoordinate.fromLngLat(
        mapMotionWorldToLngLat(entry.layer.x + width / 2, entry.layer.y + height / 2),
      );
      const corners = animatedMediaScreenOffsets(entry.layer);
      const uv = [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        order = [0, 1, 2, 0, 2, 3],
        values: number[] = [];
      for (const i of order) {
        const [x, y] = corners[i];
        values.push(anchor.x, anchor.y, x, y, ...uv[i]);
      }
      if (!entry.buffer) entry.buffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(values), gl.DYNAMIC_DRAW);
      for (const [name, offset] of [
        ['a_pos', 0],
        ['a_px', 8],
        ['a_uv', 16],
      ] as const) {
        const loc = gl.getAttribLocation(this.program, name);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 24, offset);
      }
      gl.uniform1f(gl.getUniformLocation(this.program, 'u_opacity'), entry.layer.opacity);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.diagnostics.drawCalls += 1;
    }
  }
  onRemove(_map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    for (const e of this.entries) {
      if (e.buffer) gl.deleteBuffer(e.buffer);
      if (e.texture) gl.deleteTexture(e.texture);
    }
    if (this.program) gl.deleteProgram(this.program);
    this.entries = [];
    this.gl = undefined;
  }
}

const renderers = new WeakMap<MapLibreMap, Map<string, OnlineAnimatedMediaLayer>>();
const renderersForMap = (map: MapLibreMap) => {
  let value = renderers.get(map);
  if (!value) {
    value = new Map();
    renderers.set(map, value);
  }
  return value;
};

const synchronizeRenderers = (
  map: MapLibreMap,
  layers: readonly Layer[],
  urls: Readonly<Record<string, string>>,
) => {
  const values = renderersForMap(map);
  const desired = new Set(
    layers
      .filter((layer) => layer.type === 'animated-media' && layer.assetId && urls[layer.assetId])
      .map((layer) => layer.id),
  );
  for (const [projectLayerId, renderer] of values) {
    if (desired.has(projectLayerId)) continue;
    if (map.getLayer(renderer.id)) map.removeLayer(renderer.id);
    values.delete(projectLayerId);
  }
  for (const layer of layers) {
    if (!desired.has(layer.id)) continue;
    let renderer = values.get(layer.id);
    if (!renderer) {
      renderer = new OnlineAnimatedMediaLayer(layer.id);
      values.set(layer.id, renderer);
    }
    renderer.update([layer], urls);
    if (!map.getLayer(renderer.id)) map.addLayer(renderer);
  }
  return values;
};

export const prepareOnlineAnimatedMediaLayer = (
  map: MapLibreMap,
  layers: readonly Layer[],
  urls: Readonly<Record<string, string>>,
) =>
  Promise.all(
    [...synchronizeRenderers(map, layers, urls).entries()].map(([projectLayerId, renderer]) => {
      const layer = layers.find((candidate) => candidate.id === projectLayerId);
      return layer ? renderer.prepare([layer], urls) : Promise.resolve();
    }),
  );
export const ensureOnlineAnimatedMediaLayer = (
  map: MapLibreMap,
  layers: readonly Layer[],
  urls: Readonly<Record<string, string>>,
) => {
  return synchronizeRenderers(map, layers, urls);
};

/** Reinsert each retained renderer at the canonical project-layer z position. */
export const orderOnlineAnimatedMediaLayers = (
  map: MapLibreMap,
  layers: readonly Layer[],
  representativeLayerId: (layer: Layer) => string | undefined,
) => {
  for (const [index, layer] of layers.entries()) {
    if (layer.type !== 'animated-media') continue;
    const id = onlineAnimatedMediaLayerId(layer.id);
    if (!map.getLayer(id)) continue;
    const before = layers
      .slice(index + 1)
      .map(representativeLayerId)
      .find((candidate): candidate is string => Boolean(candidate && map.getLayer(candidate)));
    map.moveLayer(id, before);
  }
};
