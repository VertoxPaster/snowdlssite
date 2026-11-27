/* ============================================================
   SNOWCLIENT — снегопад на WebGL
   Слои снега с разной глубиной: дальние чёткие, ближние размыты (боке).
   Фон плоский, без градиентов; поверх него карточки с backdrop-blur.
   ============================================================ */
(function () {
  'use strict';

  function initSnow() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let canvas = document.getElementById('smokeCanvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'smokeCanvas';
      canvas.className = 'smoke-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      document.body.prepend(canvas);
    }

    const gl = canvas.getContext('webgl', {
      alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power'
    }) || canvas.getContext('experimental-webgl');
    if (!gl) return;

    const vs = 'attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }';

    const fs = `
      precision highp float;
      uniform vec2 u_res;
      uniform float u_time;
      uniform vec2 u_mouse;

      float h(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      // один слой снега: scale — плотность, size — радиус, blur — размытие по глубине
      float layer(vec2 uv, float t, float scale, float speed, float size, float blur, float seed, float density) {
        vec2 p = uv * scale;
        p.y += t * speed;
        vec2 id = floor(p);
        vec2 f = fract(p);
        float r = h(id + seed);
        vec2 pos = vec2(0.22 + 0.56 * h(id + seed + 1.7), 0.22 + 0.56 * h(id + seed + 3.1));
        pos.x += 0.14 * sin(t * (0.35 + r * 0.5) + r * 6.2831);
        float d = length(f - pos);
        float rad = size * (0.55 + 0.45 * h(id + seed + 5.3));
        float a = 1.0 - smoothstep(rad * 0.25, rad + blur, d);
        a *= step(1.0 - density, r);
        // чем сильнее размыто, тем прозрачнее пятно
        return a / (1.0 + blur * 9.0);
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / u_res.y;
        vec2 m = (u_mouse - 0.5);
        float t = u_time;

        float s = 0.0;
        s += layer(uv + m * 0.010, t, 22.0, 0.30, 0.050, 0.010, 11.0, 0.55) * 0.55;
        s += layer(uv + m * 0.020, t, 14.0, 0.42, 0.060, 0.018, 23.0, 0.55) * 0.75;
        s += layer(uv + m * 0.035, t,  8.5, 0.60, 0.070, 0.050, 37.0, 0.50) * 0.95;
        s += layer(uv + m * 0.060, t,  4.8, 0.85, 0.080, 0.160, 51.0, 0.45) * 1.10;
        s += layer(uv + m * 0.100, t,  2.6, 1.15, 0.090, 0.320, 67.0, 0.40) * 1.20;

        vec3 bg = vec3(0.026, 0.032, 0.042);
        vec3 snow = vec3(0.80, 0.89, 1.0);
        vec3 col = bg + snow * clamp(s, 0.0, 1.0) * 0.55;

        // зерно, чтобы поверхность не выглядела пластиковой
        col += (h(gl_FragCoord.xy + fract(t) * 91.0) - 0.5) * 0.028;

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { gl.deleteShader(sh); return null; }
      return sh;
    }

    const v = compile(gl.VERTEX_SHADER, vs);
    const f = compile(gl.FRAGMENT_SHADER, fs);
    if (!v || !f) return;

    const prog = gl.createProgram();
    gl.attachShader(prog, v);
    gl.attachShader(prog, f);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, 'u_res');
    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uMouse = gl.getUniformLocation(prog, 'u_mouse');

    let mx = 0.5, my = 0.5, tx = 0.5, ty = 0.5;
    window.addEventListener('mousemove', function (e) {
      tx = e.clientX / Math.max(window.innerWidth, 1);
      ty = 1 - e.clientY / Math.max(window.innerHeight, 1);
    }, { passive: true });

    function resize() {
      const mobile = window.innerWidth < 768;
      const dpr = Math.min(window.devicePixelRatio || 1, mobile ? 1 : 1.25);
      const w = Math.floor(window.innerWidth * dpr);
      const h = Math.floor(window.innerHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    }
    window.addEventListener('resize', resize, { passive: true });
    resize();

    let raf = null, start = performance.now(), pausedAt = 0;

    function frame(now) {
      mx += (tx - mx) * 0.04;
      my += (ty - my) * 0.04;
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, ((now - start) * 0.001) % 3600.0);
      gl.uniform2f(uMouse, mx, my);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      raf = requestAnimationFrame(frame);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (raf) { cancelAnimationFrame(raf); raf = null; pausedAt = performance.now(); }
      } else if (!raf) {
        if (pausedAt) start += performance.now() - pausedAt;
        raf = requestAnimationFrame(frame);
      }
    });

    raf = requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSnow);
  else initSnow();
})();
