/**
 * WebGL2 compositor shared by preview and export. Each layer is a textured quad with a full 2D
 * transform, crop, flip, opacity, blend mode and per-pixel color adjustments.
 */
export interface ColorAdjust { exposure: number; contrast: number; saturation: number; temperature: number; tint: number; brightness: number; vignette: number }
export const IDENTITY_COLOR: ColorAdjust = { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, brightness: 0, vignette: 0 };

export interface LayerDraw {
  source: TexImageSource;
  srcWidth: number;
  srcHeight: number;
  /** Destination quad in canvas pixels before rotation: center and size. */
  cx: number; cy: number; w: number; h: number;
  rotation: number; // degrees
  opacity: number;
  crop: { left: number; top: number; right: number; bottom: number };
  flipH: boolean; flipV: boolean;
  blend: 'normal' | 'screen' | 'multiply' | 'overlay' | 'add';
  color?: ColorAdjust;
  /** Optional 3D LUT texture key (registered with setLut). */
  lut?: string; lutStrength?: number;
  blur?: number; // radius in pixels (cheap separable approximation)
  key?: { color: [number, number, number]; similarity: number; smoothness: number };
  mask?: { kind: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; feather: number; invert: boolean };
  /** Optional person matte (white = keep), same framing as the source. */
  matte?: TexImageSource;
  /** Source texture already has premultiplied alpha (canvas text) */
  premultiplied?: boolean;
}

const VS = `#version 300 es
in vec2 a_pos;
uniform mat3 u_m;
uniform vec4 u_uv;
out vec2 v_uv;
out vec2 v_local;
void main() {
  vec3 p = u_m * vec3(a_pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  v_uv = mix(u_uv.xy, u_uv.zw, a_pos);
  v_local = a_pos;
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
in vec2 v_local;
uniform sampler2D u_tex;
uniform sampler3D u_lut;
uniform float u_opacity;
uniform float u_exposure, u_contrast, u_saturation, u_temperature, u_tint, u_brightness, u_vignette;
uniform float u_lutStrength;
uniform float u_lutSize;
uniform float u_premul;
uniform vec2 u_texel;
uniform float u_blur;
uniform vec4 u_key; // rgb + enabled
uniform vec2 u_keyParams; // similarity, smoothness
uniform vec4 u_mask; // x y w h (local 0..1)
uniform vec3 u_maskParams; // kind (0 none,1 rect,2 ellipse), feather, invert
uniform sampler2D u_matte;
uniform float u_useMatte;
out vec4 outColor;

vec4 sampleTex(vec2 uv) {
  if (u_blur < 0.5) return texture(u_tex, uv);
  vec4 acc = vec4(0.0);
  float total = 0.0;
  for (int x = -3; x <= 3; x++) for (int y = -3; y <= 3; y++) {
    vec2 o = vec2(float(x), float(y)) * u_texel * u_blur / 3.0;
    float w = exp(-float(x * x + y * y) / 8.0);
    acc += texture(u_tex, uv + o) * w;
    total += w;
  }
  return acc / total;
}

void main() {
  vec4 c = sampleTex(v_uv);
  if (u_premul > 0.5 && c.a > 0.0) c.rgb /= c.a;
  vec3 rgb = c.rgb;
  rgb *= exp2(u_exposure);
  rgb += u_brightness;
  rgb = (rgb - 0.5) * (1.0 + u_contrast) + 0.5;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(l), rgb, 1.0 + u_saturation);
  rgb += vec3(u_temperature * 0.1, u_tint * 0.1, -u_temperature * 0.1);
  rgb = clamp(rgb, 0.0, 1.0);
  // Sample at texel centers: grid point i lives at (i + 0.5) / N.
  if (u_lutStrength > 0.0) rgb = mix(rgb, texture(u_lut, rgb * ((u_lutSize - 1.0) / u_lutSize) + 0.5 / u_lutSize).rgb, u_lutStrength);
  if (u_vignette > 0.0) { float d = distance(v_local, vec2(0.5)); rgb *= 1.0 - u_vignette * smoothstep(0.35, 0.8, d); }
  float a = c.a * u_opacity;
  if (u_key.a > 0.5) {
    float d = distance(c.rgb, u_key.rgb);
    a *= smoothstep(u_keyParams.x, u_keyParams.x + u_keyParams.y + 1e-4, d);
  }
  if (u_maskParams.x > 0.5) {
    vec2 p = (v_local - u_mask.xy) / max(u_mask.zw, vec2(1e-4));
    float m;
    if (u_maskParams.x < 1.5) {
      vec2 e = min(p, 1.0 - p);
      m = smoothstep(0.0, max(u_maskParams.y, 1e-4), min(e.x, e.y));
    } else {
      float r = length(p - 0.5) * 2.0;
      m = 1.0 - smoothstep(1.0 - u_maskParams.y, 1.0, r);
    }
    if (u_maskParams.z > 0.5) m = 1.0 - m;
    a *= clamp(m, 0.0, 1.0);
  }
  if (u_useMatte > 0.5) a *= texture(u_matte, v_uv).r;
  outColor = vec4(rgb * a, a);
}`;

export class Compositor {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private textures: WebGLTexture[] = [];
  private matteTextures: WebGLTexture[] = [];
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private luts = new Map<string, WebGLTexture>();
  private lutSizes = new Map<WebGLTexture, number>();
  private floatLinear = false;
  private identityLut: WebGLTexture;
  width = 0;
  height = 0;

  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) { this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: false, antialias: true, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
    this.prog = p;
    for (const n of ['u_m', 'u_uv', 'u_tex', 'u_lut', 'u_opacity', 'u_exposure', 'u_contrast', 'u_saturation', 'u_temperature', 'u_tint', 'u_brightness', 'u_vignette', 'u_lutStrength', 'u_lutSize', 'u_premul', 'u_texel', 'u_blur', 'u_key', 'u_keyParams', 'u_mask', 'u_maskParams', 'u_matte', 'u_useMatte']) this.loc[n] = gl.getUniformLocation(p, n);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(p, 'a_pos');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    this.floatLinear = !!gl.getExtension('OES_texture_float_linear');
    this.identityLut = this.makeLut(2, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]));
  }

  private makeLut(size: number, data: Float32Array): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
    // 32-bit float keeps identity LUTs exact; fall back to half float where float filtering is missing.
    gl.texImage3D(gl.TEXTURE_3D, 0, this.floatLinear ? gl.RGB32F : gl.RGB16F, size, size, size, 0, gl.RGB, gl.FLOAT, data);
    this.lutSizes.set(t, size);
    return t;
  }

  /** Register a .cube LUT (size N, N^3 RGB triples, red fastest). */
  setLut(key: string, size: number, rgb: Float32Array): void {
    const old = this.luts.get(key);
    if (old) this.gl.deleteTexture(old);
    this.luts.set(key, this.makeLut(size, rgb));
  }
  hasLut(key: string): boolean { return this.luts.has(key); }

  resize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.width = width;
    this.height = height;
  }

  private texture(i: number): WebGLTexture {
    const gl = this.gl;
    while (this.textures.length <= i) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textures.push(t);
    }
    return this.textures[i]!;
  }

  draw(layers: LayerDraw[], background: [number, number, number]): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(background[0], background[1], background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    layers.forEach((L, i) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture(i));
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, L.source);
      gl.uniform1i(this.loc.u_tex!, 0);
      gl.activeTexture(gl.TEXTURE1);
      const lutTex = (L.lut && this.luts.get(L.lut)) || this.identityLut;
      gl.bindTexture(gl.TEXTURE_3D, lutTex);
      gl.uniform1f(this.loc.u_lutSize!, this.lutSizes.get(lutTex) ?? 2);
      gl.uniform1i(this.loc.u_lut!, 1);
      gl.uniform1f(this.loc.u_lutStrength!, L.lut && this.luts.has(L.lut) ? L.lutStrength ?? 1 : 0);
      // Transform: unit quad -> centered size -> rotate -> translate -> clip space.
      const r = (L.rotation * Math.PI) / 180;
      const cos = Math.cos(r), sin = Math.sin(r);
      const sx = 2 / this.width, sy = -2 / this.height;
      // p_pixel = center + R * ((u - 0.5) * size)
      const a = cos * L.w, b = -sin * L.h, c = sin * L.w, d = cos * L.h;
      const tx = L.cx - 0.5 * (a + b), ty = L.cy - 0.5 * (c + d);
      const m = new Float32Array([a * sx, c * sy, 0, b * sx, d * sy, 0, tx * sx - 1, ty * sy + 1, 1]);
      gl.uniformMatrix3fv(this.loc.u_m!, false, m);
      let u0 = L.crop.left, u1 = 1 - L.crop.right, v0 = L.crop.top, v1 = 1 - L.crop.bottom;
      if (L.flipH) [u0, u1] = [u1, u0];
      if (L.flipV) [v0, v1] = [v1, v0];
      gl.uniform4f(this.loc.u_uv!, u0, v0, u1, v1);
      const col = L.color ?? IDENTITY_COLOR;
      gl.uniform1f(this.loc.u_opacity!, Math.max(0, Math.min(1, L.opacity)));
      gl.uniform1f(this.loc.u_exposure!, col.exposure);
      gl.uniform1f(this.loc.u_contrast!, col.contrast);
      gl.uniform1f(this.loc.u_saturation!, col.saturation);
      gl.uniform1f(this.loc.u_temperature!, col.temperature);
      gl.uniform1f(this.loc.u_tint!, col.tint);
      gl.uniform1f(this.loc.u_brightness!, col.brightness);
      gl.uniform1f(this.loc.u_vignette!, col.vignette);
      gl.uniform1f(this.loc.u_premul!, L.premultiplied ? 1 : 0);
      gl.uniform2f(this.loc.u_texel!, 1 / Math.max(1, L.srcWidth), 1 / Math.max(1, L.srcHeight));
      gl.uniform1f(this.loc.u_blur!, L.blur ?? 0);
      gl.uniform4f(this.loc.u_key!, L.key?.color[0] ?? 0, L.key?.color[1] ?? 0, L.key?.color[2] ?? 0, L.key ? 1 : 0);
      gl.uniform2f(this.loc.u_keyParams!, L.key?.similarity ?? 0, L.key?.smoothness ?? 0);
      const mk = L.mask;
      gl.uniform4f(this.loc.u_mask!, mk?.x ?? 0, mk?.y ?? 0, mk?.w ?? 1, mk?.h ?? 1);
      gl.uniform3f(this.loc.u_maskParams!, mk ? (mk.kind === 'rect' ? 1 : 2) : 0, mk?.feather ?? 0, mk?.invert ? 1 : 0);
      gl.activeTexture(gl.TEXTURE2);
      if (L.matte) {
        while (this.matteTextures.length <= i) {
          const t = gl.createTexture()!;
          gl.bindTexture(gl.TEXTURE_2D, t);
          for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const) gl.texParameteri(gl.TEXTURE_2D, k, v);
          this.matteTextures.push(t);
        }
        gl.bindTexture(gl.TEXTURE_2D, this.matteTextures[i]!);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, L.matte);
      } else gl.bindTexture(gl.TEXTURE_2D, this.texture(0));
      gl.uniform1i(this.loc.u_matte!, 2);
      gl.uniform1f(this.loc.u_useMatte!, L.matte ? 1 : 0);
      switch (L.blend) {
        case 'screen': gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR); break;
        case 'multiply': gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA); break;
        case 'add': gl.blendFunc(gl.ONE, gl.ONE); break;
        default: gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    });
    gl.flush();
  }

  readPixels(x: number, y: number, w: number, h: number): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(w * h * 4);
    gl.readPixels(x, this.height - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    // Flip rows to top-down order.
    const row = w * 4;
    const tmp = new Uint8Array(row);
    for (let i = 0; i < h / 2; i++) {
      const a = i * row, b = (h - 1 - i) * row;
      tmp.set(out.subarray(a, a + row)); out.copyWithin(a, b, b + row); out.set(tmp, b);
    }
    return out;
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.textures) gl.deleteTexture(t);
    for (const t of this.luts.values()) gl.deleteTexture(t);
    this.textures = [];
  }
}

/** Parse an Adobe .cube 3D LUT. */
export function parseCube(text: string): { size: number; data: Float32Array } {
  let size = 0;
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^LUT_3D_SIZE\s+(\d+)/i.exec(line);
    if (m) { size = Number(m[1]); continue; }
    if (/^[A-Z_]/i.test(line)) continue;
    const parts = line.split(/\s+/).map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) vals.push(...parts);
  }
  if (!size || vals.length !== size * size * size * 3) throw new Error(`invalid .cube LUT (size ${size}, ${vals.length / 3} entries)`);
  return { size, data: new Float32Array(vals) };
}
