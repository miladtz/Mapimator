import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MapLibreMap,
} from 'maplibre-gl';
import { imageFitModeOf, imageMercatorCoordinates, imageRenderSurfaceState } from './imageLayers';
import { mapMotionWorldToLngLat } from './openFreeMapAdapter';
import type { Layer } from './project';

export const ONLINE_PROJECT_IMAGE_RENDER_LAYER_ID = 'mapmotion-project-images';

type PreparedImage = { image: HTMLImageElement; width: number; height: number };
type RenderEntry = {
  id: string;
  layer: Layer;
  url: string;
  geometrySignature?: string;
  vertices?: Float32Array;
  buffer?: WebGLBuffer;
};

const decodedImages = new Map<string, Promise<PreparedImage>>();
let decodeCount = 0;

const decodeImage = (url: string) => {
  let pending = decodedImages.get(url);
  if (!pending) {
    pending = new Promise<PreparedImage>((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => {
        decodeCount += 1;
        resolve({ image, width: Math.max(1, image.naturalWidth), height: Math.max(1, image.naturalHeight) });
      };
      image.onerror = () => reject(new Error('Unable to decode the project Image asset.'));
      image.src = url;
    });
    decodedImages.set(url, pending);
    if (decodedImages.size > 16) decodedImages.delete(decodedImages.keys().next().value!);
  }
  return pending;
};

const compileShader = (gl: WebGLRenderingContext | WebGL2RenderingContext, type: number, source: string) => {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(shader) ?? 'Image shader failed.');
  return shader;
};

/** Pure renderer-boundary state. Large pixel resources never participate here. */
export const onlineImageRenderParameters = (
  layer: Layer,
  intrinsicWidth: number,
  intrinsicHeight: number,
) => {
  const surface = imageRenderSurfaceState(layer);
  const rendered = surface.geometry;
  const targetWidth = Math.max(1, rendered.width ?? 160);
  const targetHeight = Math.max(1, rendered.height ?? 90);
  const targetAspect = targetWidth / targetHeight;
  const imageAspect = Math.max(0.0001, intrinsicWidth / Math.max(1, intrinsicHeight));
  let width = targetWidth;
  let height = targetHeight;
  let u0 = 0;
  let v0 = 0;
  let u1 = 1;
  let v1 = 1;
  if (imageFitModeOf(layer) === 'contain') {
    if (imageAspect > targetAspect) height = width / imageAspect;
    else width = height * imageAspect;
  } else if (imageAspect > targetAspect) {
    const occupied = targetAspect / imageAspect;
    u0 = (1 - occupied) / 2;
    u1 = 1 - u0;
  } else {
    const occupied = imageAspect / targetAspect;
    v0 = (1 - occupied) / 2;
    v1 = 1 - v0;
  }
  const centerX = rendered.x + targetWidth / 2;
  const centerY = rendered.y + targetHeight / 2;
  const radians = ((layer.imageRotation ?? 0) * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const offsets = [
    [-width / 2, -height / 2],
    [width / 2, -height / 2],
    [width / 2, height / 2],
    [-width / 2, height / 2],
  ].map(([x, y]) => [x * cosine - y * sine, x * sine + y * cosine] as const);
  return {
    anchor: [centerX, centerY] as const,
    offsets,
    worldCorners: offsets.map(([x, y]) => [centerX + x, centerY + y] as const),
    uvs: [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ] as const,
    opacity: surface.opacity,
    wipe: surface.visibleFraction,
    orientation: surface.orientation,
  } as const;
};

export interface OnlineImageLayerDiagnostics {
  decodes: number;
  textureUploads: number;
  updateCalls: number;
  drawCalls: number;
  dynamicVertexUploads: number;
}

export class OnlineImageLayer implements CustomLayerInterface {
  readonly id = ONLINE_PROJECT_IMAGE_RENDER_LAYER_ID;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;
  private map?: MapLibreMap;
  private gl?: WebGLRenderingContext | WebGL2RenderingContext;
  private program?: WebGLProgram;
  private vertexShader?: WebGLShader;
  private fragmentShader?: WebGLShader;
  private vertexArray?: WebGLVertexArrayObject;
  private entries: RenderEntry[] = [];
  private prepared = new Map<string, PreparedImage>();
  private textures = new Map<string, WebGLTexture>();
  readonly diagnostics: OnlineImageLayerDiagnostics = {
    decodes: 0,
    textureUploads: 0,
    updateCalls: 0,
    drawCalls: 0,
    dynamicVertexUploads: 0,
  };

  async prepare(layers: readonly Layer[], assetUrls: Readonly<Record<string, string>>) {
    const urls = new Set(
      layers
        .filter((layer) => layer.type === 'image' && layer.assetId && assetUrls[layer.assetId])
        .map((layer) => assetUrls[layer.assetId!]),
    );
    await Promise.all(
      [...urls].map(async (url) => {
        if (this.prepared.has(url)) return;
        const prepared = await decodeImage(url);
        this.prepared.set(url, prepared);
        this.diagnostics.decodes += 1;
      }),
    );
    this.map?.triggerRepaint();
  }

  update(layers: readonly Layer[], assetUrls: Readonly<Record<string, string>>) {
    this.diagnostics.updateCalls += 1;
    // A zero-opacity Appear frame marks the layer invisible, but it still owns
    // its immutable asset. Retain that resource so the next frame is purely
    // synchronous and cannot race an async re-decode.
    const resourceUrls = new Set(
      layers.flatMap((layer) =>
        layer.type === 'image' && layer.assetId && assetUrls[layer.assetId] ? [assetUrls[layer.assetId]] : [],
      ),
    );
    const previous = new Map(this.entries.map((entry) => [entry.id, entry]));
    const next = layers.flatMap((layer) => {
      if (layer.type !== 'image' || !layer.visible || !layer.assetId) return [];
      const url = assetUrls[layer.assetId];
      if (!url) return [];
      const retained = previous.get(layer.id);
      if (retained && retained.url === url) {
        retained.layer = layer;
        previous.delete(layer.id);
        return [retained];
      }
      return [{ id: layer.id, layer, url } as RenderEntry];
    });
    for (const entry of previous.values()) if (entry.buffer) this.gl?.deleteBuffer(entry.buffer);
    this.entries = next;
    for (const [url, texture] of this.textures) {
      if (resourceUrls.has(url)) continue;
      this.gl?.deleteTexture(texture);
      this.textures.delete(url);
      this.prepared.delete(url);
    }
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;
    const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const vertexSource = webgl2
      ? '#version 300 es\nin vec2 a_pos;in vec2 a_offset;in vec2 a_uv;uniform mat4 u_matrix;uniform vec2 u_viewport;uniform float u_face;out vec2 v_uv;void main(){vec4 p=u_matrix*vec4(a_pos,0.,1.);if(u_face>.5)p.xy+=vec2(2.*a_offset.x/u_viewport.x,-2.*a_offset.y/u_viewport.y)*p.w;gl_Position=p;v_uv=a_uv;}'
      : 'attribute vec2 a_pos;attribute vec2 a_offset;attribute vec2 a_uv;uniform mat4 u_matrix;uniform vec2 u_viewport;uniform float u_face;varying vec2 v_uv;void main(){vec4 p=u_matrix*vec4(a_pos,0.,1.);if(u_face>.5)p.xy+=vec2(2.*a_offset.x/u_viewport.x,-2.*a_offset.y/u_viewport.y)*p.w;gl_Position=p;v_uv=a_uv;}';
    const fragmentSource = webgl2
      ? '#version 300 es\nprecision mediump float;uniform sampler2D u_image;uniform float u_opacity;uniform float u_wipe_edge;in vec2 v_uv;out vec4 outColor;void main(){if(v_uv.x>u_wipe_edge)discard;vec4 c=texture(u_image,v_uv);outColor=vec4(c.rgb*c.a*u_opacity,c.a*u_opacity);}'
      : 'precision mediump float;uniform sampler2D u_image;uniform float u_opacity;uniform float u_wipe_edge;varying vec2 v_uv;void main(){if(v_uv.x>u_wipe_edge)discard;vec4 c=texture2D(u_image,v_uv);gl_FragColor=vec4(c.rgb*c.a*u_opacity,c.a*u_opacity);}';
    const program = gl.createProgram()!;
    this.vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    this.fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, this.vertexShader);
    gl.attachShader(program, this.fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) ?? 'Image program failed.');
    this.program = program;
    if (webgl2) this.vertexArray = gl.createVertexArray() ?? undefined;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput) {
    if (!this.program) return;
    const gl2 =
      typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? gl : undefined;
    if (gl2) gl2.bindVertexArray(this.vertexArray ?? null);
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_image'), 0);
    gl.uniformMatrix4fv(
      gl.getUniformLocation(this.program, 'u_matrix'),
      false,
      options.defaultProjectionData.mainMatrix as Float32List,
    );
    const canvas = this.map?.getCanvas();
    gl.uniform2f(
      gl.getUniformLocation(this.program, 'u_viewport'),
      Math.max(1, canvas?.clientWidth ?? gl.drawingBufferWidth),
      Math.max(1, canvas?.clientHeight ?? gl.drawingBufferHeight),
    );
    const stride = 24;
    const indices = [0, 1, 2, 0, 2, 3];
    for (const entry of this.entries) {
      const prepared = this.prepared.get(entry.url);
      if (!prepared) continue;
      let texture = this.textures.get(entry.url);
      if (!texture) {
        texture = gl.createTexture()!;
        this.textures.set(entry.url, texture);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, prepared.image);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.diagnostics.textureUploads += 1;
      } else gl.bindTexture(gl.TEXTURE_2D, texture);
      const parameters = onlineImageRenderParameters(entry.layer, prepared.width, prepared.height);
      const face = parameters.orientation === 'face-camera';
      const geometrySignature = [
        face,
        parameters.anchor,
        parameters.offsets,
        parameters.worldCorners,
        parameters.uvs,
      ].join(':');
      const geometryChanged = entry.geometrySignature !== geometrySignature || !entry.vertices;
      if (geometryChanged) {
        const anchorLngLat = mapMotionWorldToLngLat(parameters.anchor[0], parameters.anchor[1]);
        const anchor = MercatorCoordinate.fromLngLat(anchorLngLat);
        const mercatorCorners = face ? [] : imageMercatorCoordinates(parameters.anchor, parameters.offsets);
        const vertices: number[] = [];
        for (const index of indices) {
          const coordinate = face ? anchor : mercatorCorners[index];
          const offset = face ? parameters.offsets[index] : [0, 0];
          vertices.push(coordinate.x, coordinate.y, offset[0], offset[1], ...parameters.uvs[index]);
        }
        entry.vertices = new Float32Array(vertices);
        entry.geometrySignature = geometrySignature;
      }
      if (!entry.buffer) {
        entry.buffer = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, entry.vertices!, gl.DYNAMIC_DRAW);
        this.diagnostics.dynamicVertexUploads += 1;
      } else {
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
        if (geometryChanged) {
          gl.bufferData(gl.ARRAY_BUFFER, entry.vertices!, gl.DYNAMIC_DRAW);
          this.diagnostics.dynamicVertexUploads += 1;
        }
      }
      for (const attribute of [
        ['a_pos', 0],
        ['a_offset', 8],
        ['a_uv', 16],
      ] as const) {
        const location = gl.getAttribLocation(this.program, attribute[0]);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, 2, gl.FLOAT, false, stride, attribute[1]);
      }
      gl.uniform1f(gl.getUniformLocation(this.program, 'u_face'), face ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(this.program, 'u_opacity'), parameters.opacity);
      gl.uniform1f(
        gl.getUniformLocation(this.program, 'u_wipe_edge'),
        parameters.uvs[0][0] + (parameters.uvs[1][0] - parameters.uvs[0][0]) * parameters.wipe,
      );
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.diagnostics.drawCalls += 1;
    }
    if (gl2) gl2.bindVertexArray(null);
  }

  onRemove(_map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    for (const texture of this.textures.values()) gl.deleteTexture(texture);
    this.textures.clear();
    for (const entry of this.entries)
      if (entry.buffer) {
        gl.deleteBuffer(entry.buffer);
        entry.buffer = undefined;
      }
    if (this.vertexArray && gl instanceof WebGL2RenderingContext) gl.deleteVertexArray(this.vertexArray);
    if (this.program) gl.deleteProgram(this.program);
    if (this.vertexShader) gl.deleteShader(this.vertexShader);
    if (this.fragmentShader) gl.deleteShader(this.fragmentShader);
    this.program = undefined;
    this.gl = undefined;
  }
}

const imageLayers = new WeakMap<MapLibreMap, OnlineImageLayer>();
export const onlineImageLayerForMap = (map: MapLibreMap) => {
  let renderer = imageLayers.get(map);
  if (!renderer) {
    renderer = new OnlineImageLayer();
    imageLayers.set(map, renderer);
  }
  return renderer;
};

export const prepareOnlineImageLayer = (
  map: MapLibreMap,
  layers: readonly Layer[],
  assetUrls: Readonly<Record<string, string>>,
) => onlineImageLayerForMap(map).prepare(layers, assetUrls);

export const ensureOnlineImageLayer = (
  map: MapLibreMap,
  layers: readonly Layer[],
  assetUrls: Readonly<Record<string, string>>,
) => {
  const renderer = onlineImageLayerForMap(map);
  renderer.update(layers, assetUrls);
  if (
    !map.getLayer(renderer.id) &&
    layers.some((layer) => layer.type === 'image' && layer.assetId && assetUrls[layer.assetId])
  )
    map.addLayer(renderer);
  return renderer;
};

export const onlineImageGlobalDiagnostics = () => ({
  decodes: decodeCount,
  cachedAssets: decodedImages.size,
});
