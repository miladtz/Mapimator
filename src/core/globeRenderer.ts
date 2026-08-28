import { COASTLINE_PATH, COUNTRIES, COUNTRY_BORDER_PATH, LAKE_PATH, RIVER_PATHS } from '../data/worldMap';
import { globeCameraMatrices, type GlobeCameraMatrices } from './globeMath';
import type { CameraState, MapStylePreset } from './project';

const VERTEX_SHADER = `#version 300 es
in vec3 a_position;
in vec2 a_uv;
uniform mat4 u_viewProjection;
uniform vec4 u_orientation;
out vec2 v_uv;
vec3 rotateQuaternion(vec4 q, vec3 v){ return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main(){ v_uv=a_uv; gl_Position=u_viewProjection*vec4(rotateQuaternion(u_orientation,a_position),1.0); }`;
const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform sampler2D u_map;
in vec2 v_uv;
out vec4 outColor;
void main(){ outColor=texture(u_map,v_uv); }`;

const compileShader = (gl: WebGL2RenderingContext, type: number, source: string) => {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Unable to allocate Globe shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    throw new Error(`Globe shader compilation failed: ${gl.getShaderInfoLog(shader)}`);
  return shader;
};

const createProgram = (gl: WebGL2RenderingContext) => {
  const program = gl.createProgram();
  if (!program) throw new Error('Unable to allocate Globe shader program.');
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(`Globe shader link failed: ${gl.getProgramInfoLog(program)}`);
  return program;
};

const sphereGeometry = (longitudeSegments = 256, latitudeSegments = 128) => {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let latitudeIndex = 0; latitudeIndex <= latitudeSegments; latitudeIndex += 1) {
    const v = latitudeIndex / latitudeSegments;
    const latitude = -Math.PI / 2 + v * Math.PI;
    const cosine = Math.cos(latitude);
    for (let longitudeIndex = 0; longitudeIndex <= longitudeSegments; longitudeIndex += 1) {
      const u = longitudeIndex / longitudeSegments;
      const longitude = -Math.PI + u * Math.PI * 2;
      vertices.push(cosine * Math.cos(longitude), Math.sin(latitude), -cosine * Math.sin(longitude), u, v);
    }
  }
  const stride = longitudeSegments + 1;
  for (let y = 0; y < latitudeSegments; y += 1)
    for (let x = 0; x < longitudeSegments; x += 1) {
      const first = y * stride + x;
      const second = first + stride;
      indices.push(first, first + 1, second, second, first + 1, second + 1);
    }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
};

const textureSignature = (style: MapStylePreset) =>
  [
    style.landColor,
    style.waterColor,
    style.countryBorderColor,
    style.coastlineColor,
    style.lakeColor,
    style.riverColor,
    style.countryBorderWidth,
  ].join('|');

const buildMapTexture = (style: MapStylePreset, width: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = width / 2;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Unable to prepare offline Globe texture.');
  context.fillStyle = style.waterColor;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.scale(canvas.width / 1000, canvas.height / 560);
  context.fillStyle = style.landColor;
  for (const country of COUNTRIES) context.fill(new Path2D(country.path), 'evenodd');
  context.fillStyle = style.lakeColor;
  context.fill(new Path2D(LAKE_PATH), 'evenodd');
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.strokeStyle = style.riverColor;
  for (const [index, path] of RIVER_PATHS.entries()) {
    context.globalAlpha = [0.9, 0.72, 0.52][index] ?? 0.5;
    context.lineWidth = [0.65, 0.48, 0.34][index] ?? 0.3;
    context.stroke(new Path2D(path));
  }
  context.globalAlpha = 1;
  context.strokeStyle = style.countryBorderColor;
  context.lineWidth = Math.max(0.28, style.countryBorderWidth * 0.46);
  context.stroke(new Path2D(COUNTRY_BORDER_PATH));
  context.strokeStyle = style.coastlineColor;
  context.lineWidth = Math.max(0.35, style.countryBorderWidth * 0.56);
  context.stroke(new Path2D(COASTLINE_PATH));
  context.restore();
  return canvas;
};

export interface GlobeRenderStats {
  geometryUploadCount: number;
  textureUploadCount: number;
  cameraMs: number;
  renderMs: number;
}

export interface GlobeRendererDiagnostics {
  canvasWidth: number;
  canvasHeight: number;
  contextLost: boolean;
  indexCount: number;
  vertexCount: number;
  textureWidth: number;
  textureHeight: number;
  drawCount: number;
  glError: number;
  matricesFinite: boolean;
  cameraDistance: number;
  maxTextureSize: number;
  anisotropyLevel: number;
  textureUploadMs: number;
}

export class GlobeWebGLRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly program: WebGLProgram;
  readonly vertexArray: WebGLVertexArrayObject;
  readonly vertexBuffer: WebGLBuffer;
  readonly indexBuffer: WebGLBuffer;
  readonly texture: WebGLTexture;
  readonly indexCount: number;
  readonly vertexCount: number;
  geometryUploadCount = 0;
  textureUploadCount = 0;
  private styleSignature = '';
  private disposed = false;
  private drawCount = 0;
  private textureWidth = 0;
  private textureHeight = 0;
  private readonly textureSize: number;
  private readonly anisotropy: { extension: EXT_texture_filter_anisotropic; value: number } | null;
  private textureUploadMs = 0;
  matrices: GlobeCameraMatrices | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      depth: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 is unavailable; professional Globe mode cannot start.');
    this.gl = gl;
    this.textureSize = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    const anisotropic = gl.getExtension('EXT_texture_filter_anisotropic');
    this.anisotropy = anisotropic
      ? {
          extension: anisotropic,
          value: Math.min(4, gl.getParameter(anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number),
        }
      : null;
    this.program = createProgram(gl);
    const geometry = sphereGeometry();
    this.indexCount = geometry.indices.length;
    this.vertexCount = geometry.vertices.length / 5;
    const vertexArray = gl.createVertexArray();
    const vertexBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();
    const texture = gl.createTexture();
    if (!vertexArray || !vertexBuffer || !indexBuffer || !texture)
      throw new Error('Unable to allocate Globe GPU resources.');
    this.vertexArray = vertexArray;
    this.vertexBuffer = vertexBuffer;
    this.indexBuffer = indexBuffer;
    this.texture = texture;
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.program, 'a_position');
    const uv = gl.getAttribLocation(this.program, 'a_uv');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(uv);
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 20, 12);
    gl.bindVertexArray(null);
    this.geometryUploadCount = 1;
    const initializationError = gl.getError();
    if (initializationError !== gl.NO_ERROR)
      throw new Error(
        `Globe WebGL initialization failed with GL error 0x${initializationError.toString(16)}.`,
      );
  }

  resize(width: number, height: number) {
    if (this.canvas.width === width && this.canvas.height === height) return false;
    this.canvas.width = width;
    this.canvas.height = height;
    return true;
  }

  private updateTexture(style: MapStylePreset) {
    const signature = textureSignature(style);
    if (signature === this.styleSignature) return;
    const started = performance.now();
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.anisotropy)
      gl.texParameterf(
        gl.TEXTURE_2D,
        this.anisotropy.extension.TEXTURE_MAX_ANISOTROPY_EXT,
        this.anisotropy.value,
      );
    const source = buildMapTexture(style, this.textureSize);
    if (source.width <= 0 || source.height <= 0)
      throw new Error('Globe texture source has invalid dimensions.');
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.styleSignature = signature;
    this.textureWidth = source.width;
    this.textureHeight = source.height;
    this.textureUploadCount += 1;
    this.textureUploadMs = performance.now() - started;
  }

  render(camera: CameraState, style: MapStylePreset): GlobeRenderStats {
    if (this.disposed) throw new Error('Globe renderer has been disposed.');
    if (this.canvas.width <= 1 || this.canvas.height <= 1)
      throw new Error(
        `Globe canvas has invalid framebuffer dimensions ${this.canvas.width}x${this.canvas.height}.`,
      );
    if (this.gl.isContextLost()) throw new Error('Globe WebGL context is lost.');
    this.updateTexture(style);
    const cameraStarted = performance.now();
    this.matrices = globeCameraMatrices(camera, this.canvas.width, this.canvas.height);
    if (![...this.matrices.viewProjection, ...this.matrices.inverseViewProjection].every(Number.isFinite))
      throw new Error('Globe camera produced a non-finite matrix.');
    const cameraMs = performance.now() - cameraStarted;
    const renderStarted = performance.now();
    const gl = this.gl;
    const background = style.backgroundColor
      .match(/[\da-f]{2}/gi)
      ?.map((value) => Number.parseInt(value, 16) / 255) ?? [0, 0, 0];
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(background[0], background[1], background[2], 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.frontFace(gl.CCW);
    gl.cullFace(gl.BACK);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(
      gl.getUniformLocation(this.program, 'u_viewProjection'),
      false,
      this.matrices.viewProjection,
    );
    const orientation = this.matrices.orientation;
    gl.uniform4f(
      gl.getUniformLocation(this.program, 'u_orientation'),
      orientation.x,
      orientation.y,
      orientation.z,
      orientation.w,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_map'), 0);
    gl.bindVertexArray(this.vertexArray);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    this.drawCount += 1;
    gl.bindVertexArray(null);
    gl.flush();
    const drawError = gl.getError();
    if (drawError !== gl.NO_ERROR)
      throw new Error(`Globe WebGL draw failed with GL error 0x${drawError.toString(16)}.`);
    return {
      geometryUploadCount: this.geometryUploadCount,
      textureUploadCount: this.textureUploadCount,
      cameraMs,
      renderMs: performance.now() - renderStarted,
    };
  }

  diagnostics(): GlobeRendererDiagnostics {
    const matricesFinite = this.matrices
      ? [...this.matrices.viewProjection, ...this.matrices.inverseViewProjection].every(Number.isFinite)
      : false;
    const target = this.matrices?.target;
    const position = this.matrices?.position;
    return {
      canvasWidth: this.canvas.width,
      canvasHeight: this.canvas.height,
      contextLost: this.gl.isContextLost(),
      indexCount: this.indexCount,
      vertexCount: this.vertexCount,
      textureWidth: this.textureWidth,
      textureHeight: this.textureHeight,
      drawCount: this.drawCount,
      glError: this.gl.getError(),
      matricesFinite,
      cameraDistance:
        target && position
          ? Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2])
          : Number.NaN,
      maxTextureSize: this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number,
      anisotropyLevel: this.anisotropy?.value ?? 1,
      textureUploadMs: this.textureUploadMs,
    };
  }

  readPixels() {
    const { gl, canvas } = this;
    const source = new Uint8Array(canvas.width * canvas.height * 4);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const output = new Uint8ClampedArray(source.length);
    const rowBytes = canvas.width * 4;
    for (let row = 0; row < canvas.height; row += 1)
      output.set(source.subarray(row * rowBytes, (row + 1) * rowBytes), (canvas.height - row - 1) * rowBytes);
    return output;
  }

  dispose() {
    if (this.disposed) return;
    this.gl.deleteTexture(this.texture);
    this.gl.deleteBuffer(this.vertexBuffer);
    this.gl.deleteBuffer(this.indexBuffer);
    this.gl.deleteVertexArray(this.vertexArray);
    this.gl.deleteProgram(this.program);
    this.disposed = true;
  }
}
