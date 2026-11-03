import { ATLAS_SIZE, S, type Atlas, type Rect } from './atlas';
import { program, uniforms } from './gl';

const VS = `#version 300 es
precision highp float;
in vec2 aPos;
in vec2 aUV;
in vec4 aColor;
uniform vec2 uCam;
uniform vec2 uView;
out vec2 vUV;
out vec4 vColor;
void main() {
  vec2 n = (aPos - uCam) / uView;
  gl_Position = vec4(n.x * 2.0 - 1.0, 1.0 - n.y * 2.0, 0.0, 1.0);
  vUV = aUV;
  vColor = aColor;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vColor;
out vec4 oColor;
uniform sampler2D uTex;
void main() {
  vec4 t = texture(uTex, vUV);
  if (t.a < 0.02) discard;
  oColor = t * vColor;
}`;

const MAX_QUADS = 4096;
const FLOATS_PER_VERT = 5; // x, y, u, v, packed colour
const VERTS_PER_QUAD = 6;

export class SpriteBatch {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null>;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private data: Float32Array;
  private colors: Uint8Array;
  private count = 0;
  private tex: WebGLTexture;
  atlas: Atlas;

  constructor(gl: WebGL2RenderingContext, atlas: Atlas) {
    this.gl = gl;
    this.atlas = atlas;
    this.prog = program(gl, VS, FS);
    this.u = uniforms(gl, this.prog, ['uCam', 'uView', 'uTex']);

    const bytes = MAX_QUADS * VERTS_PER_QUAD * FLOATS_PER_VERT * 4;
    const buffer = new ArrayBuffer(bytes);
    this.data = new Float32Array(buffer);
    this.colors = new Uint8Array(buffer);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_VERT * 4;
    const aPos = gl.getAttribLocation(this.prog, 'aPos');
    const aUV = gl.getAttribLocation(this.prog, 'aUV');
    const aColor = gl.getAttribLocation(this.prog, 'aColor');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 4, gl.UNSIGNED_BYTE, true, stride, 16);
    gl.bindVertexArray(null);

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  begin(): void {
    this.count = 0;
  }

  /** Draws a sprite with its centre at (cx, cy) in world pixels. */
  push(
    rect: Rect,
    cx: number,
    cy: number,
    scaleX: number,
    scaleY: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    if (this.count >= MAX_QUADS) return;
    const hw = (rect.w * scaleX) / 2;
    const hh = (rect.h * scaleY) / 2;
    const x0 = cx - hw;
    const x1 = cx + hw;
    const y0 = cy - hh;
    const y1 = cy + hh;
    const u0 = rect.x / ATLAS_SIZE;
    const v0 = rect.y / ATLAS_SIZE;
    const u1 = (rect.x + rect.w) / ATLAS_SIZE;
    const v1 = (rect.y + rect.h) / ATLAS_SIZE;

    const base = this.count * VERTS_PER_QUAD * FLOATS_PER_VERT;
    const verts = [
      x0, y0, u0, v0,
      x1, y0, u1, v0,
      x0, y1, u0, v1,
      x1, y0, u1, v0,
      x1, y1, u1, v1,
      x0, y1, u0, v1,
    ];
    for (let i = 0; i < VERTS_PER_QUAD; i++) {
      const o = base + i * FLOATS_PER_VERT;
      this.data[o] = verts[i * 4];
      this.data[o + 1] = verts[i * 4 + 1];
      this.data[o + 2] = verts[i * 4 + 2];
      this.data[o + 3] = verts[i * 4 + 3];
      const co = (o + 4) * 4;
      this.colors[co] = r;
      this.colors[co + 1] = g;
      this.colors[co + 2] = b;
      this.colors[co + 3] = a;
    }
    this.count++;
  }

  /**
   * Draws a named sprite at its natural world size.
   *
   * Sprites are authored at S atlas pixels per world pixel, so this divides by
   * S. Nothing outside this method needs to know the authoring resolution.
   */
  named(
    name: string,
    cx: number,
    cy: number,
    flip: number,
    r = 255,
    g = 255,
    b = 255,
    a = 255,
  ): void {
    const rect = this.atlas.sprites[name];
    if (!rect) return;
    this.push(rect, cx, cy, flip / S, 1 / S, r, g, b, a);
  }

  /** Draws a sprite stretched to an explicit size in world pixels. */
  pushWorld(
    rect: Rect,
    cx: number,
    cy: number,
    worldW: number,
    worldH: number,
    r = 255,
    g = 255,
    b = 255,
    a = 255,
  ): void {
    this.push(rect, cx, cy, worldW / rect.w, worldH / rect.h, r, g, b, a);
  }

  /** World-pixel height of a named sprite, for anchoring. */
  worldHeight(name: string): number {
    const rect = this.atlas.sprites[name];
    return rect ? rect.h / S : 0;
  }

  flush(camX: number, camY: number, viewW: number, viewH: number): void {
    if (this.count === 0) return;
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const used = this.count * VERTS_PER_QUAD * FLOATS_PER_VERT;
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, used));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform2f(this.u.uCam, camX, camY);
    gl.uniform2f(this.u.uView, viewW, viewH);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, this.count * VERTS_PER_QUAD);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    this.count = 0;
  }
}
