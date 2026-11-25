/**
 * BWE Web 播放器 · 渲染内核
 *
 * 这是一份「消费同一份 Build 产物」的 WebGL2 渲染器，不是把 Java 塞进浏览器。
 * 你的引擎渲染层是 Java + JOGL 的固定管线；浏览器里没有 JOGL（本地库），
 * 所以 Web 导出必须是另一条渲染实现——同一套数据，两套渲染。
 *
 * 与 Java 侧保持一致的三条约定（错了整个画面就是歪的）：
 *   1. Y 轴向下，原点左上（与编辑器、scene_0.json 一致）
 *   2. 对象 x,y 是中心点；halfW/halfH 是可视化半尺寸
 *   3. 绘制顺序 layer → z → y（bwe.d.ts 里写明的规则）
 */

export interface AssetDef {
  id: string;
  name: string;
  kind: string;
  path: string;
  head: string;
  frames: number;
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  zeroBased: boolean;
}

export interface SceneObject {
  id: string;
  name: string;
  kind: string;
  x: number;
  y: number;
  layer: number;
  z: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  halfW: number;
  halfH: number;
  assetId: string;
  animMode: string;
  animFps: number;
  visible: boolean;
  modules?: unknown[];
}

export interface BootManifest {
  project: string;
  tileSize: number;
  masterVolume: number;
  /** boot.json 的全局变量表。GameData 只存字符串，缺省是空对象。 */
  variables?: Record<string, string>;
  assets: AssetDef[];
  scripts: { name: string; lang: string; file: string; source?: string }[];
  scenes: { name: string; file: string; width: number; height: number }[];
}

interface Texture {
  tex: WebGLTexture;
  w: number;
  h: number;
  def: AssetDef;
}

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUV;
uniform vec2 uResolution;
uniform vec2 uCamPos;
uniform float uZoom;
out vec2 vUV;
void main() {
  // 世界坐标 -> 屏幕：先减相机，再缩放，再转 NDC。
  // Y 轴向下：世界 y 增大要往下走，所以 NDC 的 y 要取反。
  vec2 world = aPos;
  vec2 screen = (world - uCamPos) * uZoom;
  vec2 ndc = vec2(
     (screen.x / uResolution.x) * 2.0 - 1.0,
    -(screen.y / uResolution.y) * 2.0 + 1.0
  );
  gl_Position = vec4(ndc, 0.0, 1.0);
  vUV = aUV;
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec4 uTint;
uniform float uHasTex;
out vec4 outColor;
void main() {
  vec4 c = uHasTex > 0.5 ? texture(uTex, vUV) : vec4(1.0);
  outColor = c * uTint;
  if (outColor.a < 0.004) discard;
}`;

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private quadVbo: WebGLBuffer;
  private texs = new Map<string, Texture>();
  private uResolution: WebGLUniformLocation | null;
  private uCamPos: WebGLUniformLocation | null;
  private uZoom: WebGLUniformLocation | null;
  private uTex: WebGLUniformLocation | null;
  private uTint: WebGLUniformLocation | null;
  private uHasTex: WebGLUniformLocation | null;
  private quadBytes = 0;
  /** 本帧实际发出的 draw call 数（性能面板要读） */
  drawCalls = 0;
  /** 本帧实际绘制的对象数 */
  drawnObjects = 0;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error("这个浏览器不支持 WebGL2，无法运行导出的游戏。");
    }
    this.gl = gl;

    const vs = this.compile(gl.VERTEX_SHADER, VERT);
    const fs = this.compile(gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!prog) throw new Error("createProgram 失败");
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error("着色器链接失败: " + gl.getProgramInfoLog(prog));
    }
    this.prog = prog;

    this.uResolution = gl.getUniformLocation(prog, "uResolution");
    this.uCamPos = gl.getUniformLocation(prog, "uCamPos");
    this.uZoom = gl.getUniformLocation(prog, "uZoom");
    this.uTex = gl.getUniformLocation(prog, "uTex");
    this.uTint = gl.getUniformLocation(prog, "uTint");
    this.uHasTex = gl.getUniformLocation(prog, "uHasTex");

    const vbo = gl.createBuffer();
    if (!vbo) throw new Error("createBuffer 失败");
    this.quadVbo = vbo;

    // 单位方块：位置 + UV。每帧按对象写入实际四角，避免每个对象一次 bufferData。
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

    gl.enable(gl.BLEND);
    // 素材多为预乘 alpha 之外的普通 PNG，用标准 src-alpha 混合。
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type);
    if (!sh) throw new Error("createShader 失败");
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error("着色器编译失败: " + log);
    }
    return sh;
  }

  /** 加载一张图集。失败不抛（缺图不该让整个游戏黑屏），但会记录。 */
  async loadTexture(baseUrl: string, def: AssetDef): Promise<void> {
    const url = new URL(def.path, baseUrl).href;
    const bmp = await loadImage(url);
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // 像素画必须是 NEAREST，否则缩放会糊成一团。
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    this.texs.set(def.id, { tex, w: bmp.width, h: bmp.height, def });
  }

  /**
   * 用一块离屏 canvas 刷成纹理。给 bwe.mine 这类"引擎侧自己画"的模块用：
   * 它们产出的不是资源文件，而是运行期画布。
   */
  setTextureFromCanvas(id: string, src: HTMLCanvasElement | OffscreenCanvas, def?: AssetDef): void {
    const gl = this.gl;
    let entry = this.texs.get(id);
    if (!entry) {
      const tex = gl.createTexture();
      if (!tex) return;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      entry = { tex, w: src.width, h: src.height, def: def || ({} as AssetDef) };
      this.texs.set(id, entry);
    } else {
      entry.w = src.width;
      entry.h = src.height;
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  hasTexture(id: string): boolean {
    return this.texs.has(id);
  }

  textureCount(): number {
    return this.texs.size;
  }

  resize(w: number, h: number): void {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.max(1, Math.floor(w * dpr));
    const bh = Math.max(1, Math.floor(h * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
  }

  beginFrame(camX: number, camY: number, zoom: number): void {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.05, 0.06, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniform2f(this.uResolution, canvas.width / (Math.min(window.devicePixelRatio || 1, 2)), canvas.height / (Math.min(window.devicePixelRatio || 1, 2)));
    gl.uniform2f(this.uCamPos, camX, camY);
    gl.uniform1f(this.uZoom, zoom);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    this.drawCalls = 0;
    this.drawnObjects = 0;
  }

  /**
   * 画一个对象。frame 是序列帧序号（0 起）。
   * UV 由 cols/rows/cellW/cellH 算出来；单帧素材整张用。
   */
  drawObject(o: SceneObject, frame: number, tint?: { r: number; g: number; b: number; a: number }): void {
    const gl = this.gl;
    const t = this.texs.get(o.assetId);
    const hw = o.halfW > 0 ? o.halfW : 16;
    const hh = o.halfH > 0 ? o.halfH : 16;
    const x0 = o.x - hw;
    const y0 = o.y - hh;
    const x1 = o.x + hw;
    const y1 = o.y + hh;

    let u0 = 0;
    let v0 = 0;
    let u1 = 1;
    let v1 = 1;
    if (t && t.def.frames > 1) {
      const cols = Math.max(1, t.def.cols);
      const rows = Math.max(1, t.def.rows);
      const f = Math.max(0, Math.min(t.def.frames - 1, frame | 0));
      const cx = f % cols;
      const cy = Math.floor(f / cols);
      u0 = cx / cols;
      v0 = cy / rows;
      u1 = (cx + 1) / cols;
      v1 = (cy + 1) / rows;
    }

    // 6 顶点（两三角），位置 + UV 交错。
    const buf = new Float32Array([
      x0, y0, u0, v0,
      x1, y0, u1, v0,
      x1, y1, u1, v1,
      x0, y0, u0, v0,
      x1, y1, u1, v1,
      x0, y1, u0, v1,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
    this.quadBytes = buf.byteLength;

    if (t) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.uniform1i(this.uTex, 0);
      gl.uniform1f(this.uHasTex, 1);
    } else {
      gl.uniform1f(this.uHasTex, 0);
    }
    const c = tint ?? { r: 1, g: 1, b: 1, a: 1 };
    gl.uniform4f(this.uTint, c.r, c.g, c.b, c.a);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.drawCalls++;
    this.drawnObjects++;
  }
}

/** 用 createImageBitmap 解码，失败回退到 Image（兼容老浏览器与本地 file://）。 */
export async function loadImage(url: string): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const blob = await res.blob();
        return await createImageBitmap(blob);
      }
    } catch {
      /* 落到回退 */
    }
  }
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败: " + url));
    img.src = url;
  });
}

/**
 * 绘制顺序：layer → z → y（升序，先画小的，被大的盖住）。
 * 完全照 bwe.d.ts 里写明的规则，不自己发明。
 */
export function sortForDraw(objects: SceneObject[]): SceneObject[] {
  return [...objects].sort((a, b) => {
    if (a.layer !== b.layer) return a.layer - b.layer;
    if (a.z !== b.z) return a.z - b.z;
    return a.y - b.y;
  });
}
