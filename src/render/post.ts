import { program, uniforms } from './gl';

/**
 * Post-processing: bloom, vignette and a light colour grade.
 *
 * The scene is drawn into an offscreen target, then composited to the screen in
 * one pass that adds a glow around anything bright - a furnace mouth, a burning
 * fuse, an explosion, sunlit gold, the sun itself - darkens the corners and
 * lifts the contrast slightly.
 *
 * This is the single change that most separates a modern-looking 2D game from a
 * flat one. Clonk Rage and OpenClonk both read as lit worlds rather than as
 * coloured tiles, and glow around light sources is a large part of why.
 *
 * Cost is one extra full-screen pass with sixteen taps, which is cheap next to
 * the terrain shader it composites.
 */
const VS = `#version 300 es
precision highp float;
in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos;
  gl_Position = vec4(aPos.x * 2.0 - 1.0, aPos.y * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 oColor;

uniform sampler2D uScene;
uniform vec2 uTexel;
uniform float uBloom;
uniform float uThreshold;
uniform float uVignette;

/** Golden-angle spiral, so a small number of taps still covers the disc. */
const vec2 TAPS[16] = vec2[16](
  vec2( 0.9689, 0.2474), vec2(-0.5878, 0.8090), vec2(-0.2079,-0.9781), vec2( 0.8443,-0.5358),
  vec2(-0.9927,-0.1205), vec2( 0.3546, 0.9350), vec2( 0.4818,-0.8763), vec2(-0.7557, 0.6549),
  vec2( 0.1045, 0.9945), vec2(-0.9135,-0.4068), vec2( 0.9781,-0.2079), vec2(-0.3090, 0.9511),
  vec2(-0.6549,-0.7557), vec2( 0.7290, 0.6845), vec2( 0.5878,-0.8090), vec2(-0.9511,-0.3090)
);

vec3 bloomAt(vec2 uv, float radius) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    // Two rings from one tap set: the odd taps sample further out, which widens
    // the halo without doubling the sample count.
    float r = radius * (mod(float(i), 2.0) > 0.5 ? 2.1 : 1.0);
    vec3 s = texture(uScene, uv + TAPS[i] * uTexel * r).rgb;
    sum += max(s - vec3(uThreshold), vec3(0.0));
  }
  return sum / 16.0;
}

void main() {
  vec3 scene = texture(uScene, vUV).rgb;
  vec3 glow = bloomAt(vUV, 9.0);

  vec3 col = scene + glow * uBloom;

  // Gentle grade: a touch more contrast, warm highlights, cool shadows.
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.12);
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, col * vec3(1.03, 1.00, 0.95), clamp(luma * 1.4, 0.0, 1.0));
  col = mix(col * vec3(0.95, 0.98, 1.06), col, clamp(luma * 2.0, 0.0, 1.0));

  // Vignette, kept subtle so it reads as a lens rather than a frame.
  vec2 d = (vUV - 0.5) * vec2(1.0, 1.0);
  float v = 1.0 - uVignette * pow(clamp(length(d) * 1.42, 0.0, 1.0), 2.6);
  col *= v;

  oColor = vec4(col, 1.0);
}`;

export class PostFx {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null>;
  private vao: WebGLVertexArrayObject;
  private fbo: WebGLFramebuffer;
  private tex: WebGLTexture;
  private w = 0;
  private h = 0;

  /**
   * Set bloom to 0 to bypass the whole pass.
   *
   * The threshold is tuned so the glow keys off light sources rather than off
   * the sky: lower, and the daylit sky blooms into itself, which blows out the
   * clouds and leaves the whole image hazy.
   */
  bloom = 0.14;
  threshold = 0.93;
  vignette = 0.05;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.prog = program(gl, VS, FS);
    this.u = uniforms(gl, this.prog, ['uScene', 'uTexel', 'uBloom', 'uThreshold', 'uVignette']);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.tex = gl.createTexture()!;
    this.fbo = gl.createFramebuffer()!;
  }

  private resize(w: number, h: number): void {
    if (this.w === w && this.h === h) return;
    const gl = this.gl;
    this.w = w;
    this.h = h;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // Linear, so the bloom taps blend between pixels instead of stepping.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Redirects drawing into the offscreen target. */
  begin(w: number, h: number): void {
    if (this.bloom <= 0 && this.vignette <= 0) return;
    this.resize(w, h);
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
  }

  /** Composites the offscreen target to the screen. */
  end(w: number, h: number): void {
    if (this.bloom <= 0 && this.vignette <= 0) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u.uScene, 0);
    gl.uniform2f(this.u.uTexel, 1 / Math.max(1, w), 1 / Math.max(1, h));
    gl.uniform1f(this.u.uBloom, this.bloom);
    gl.uniform1f(this.u.uThreshold, this.threshold);
    gl.uniform1f(this.u.uVignette, this.vignette);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
