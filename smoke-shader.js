/* ============================================================
   SNOWCLIENT — WEBGL DOMAIN-WARPED SMOKE SHADER
   ============================================================ */
(function () {
  'use strict';

  function initSmokeShader() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    let canvas = document.getElementById('smokeCanvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'smokeCanvas';
      canvas.className = 'smoke-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      const bgBase = document.querySelector('.bg-base');
      if (bgBase && bgBase.parentNode) {
        bgBase.parentNode.insertBefore(canvas, bgBase.nextSibling);
      } else {
        document.body.prepend(canvas);
      }
    }

    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power'
    }) || canvas.getContext('experimental-webgl');

    if (!gl) return;

    const vsSource = `
      attribute vec2 a_pos;
      void main() {
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;

    const fsSource = `
      precision highp float;

      uniform vec2 u_res;
      uniform float u_time;
      uniform vec2 u_mouse;

      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);

        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));

        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }

      float fbm(vec2 p) {
        float value = 0.0;
        float amp = 0.5;
        mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
        for (int i = 0; i < 5; i++) {
          value += amp * noise(p);
          p = rot * p * 2.03 + vec2(1.7, 9.2);
          amp *= 0.5;
        }
        return value;
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / u_res.xy;
        float aspect = u_res.x / max(u_res.y, 1.0);
        vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5) * 2.1;

        p += (u_mouse - 0.5) * 0.22;

        float t = u_time * 0.14;

        vec2 q = vec2(
          fbm(p + vec2(0.0, 0.0) + t * 0.45),
          fbm(p + vec2(5.2, 1.3) - t * 0.35)
        );

        vec2 r = vec2(
          fbm(p + 3.1 * q + vec2(1.7, 9.2) + t * 0.55),
          fbm(p + 3.1 * q + vec2(8.3, 2.8) + t * 0.42)
        );

        float f = fbm(p + 2.4 * r);

        vec3 colVoid    = vec3(0.012, 0.012, 0.013);
        vec3 colDark    = vec3(0.036, 0.036, 0.040);
        vec3 colMid     = vec3(0.075, 0.075, 0.082);
        vec3 colAccent  = vec3(0.150, 0.150, 0.162);

        float smokeMask = smoothstep(0.18, 0.88, f);
        float wispMask  = smoothstep(0.45, 0.96, length(r) * 0.68);

        vec3 color = mix(colVoid, colDark, smokeMask);
        color = mix(color, colMid, smokeMask * wispMask * 0.85);
        color += colAccent * pow(clamp(f * wispMask, 0.0, 1.0), 2.6) * 0.55;
        color *= 2.1;

        // Лёгкая виньетка по краям экрана
        float dist = length((uv - 0.5) * vec2(1.15, 1.05));
        float vignette = smoothstep(0.95, 0.22, dist);
        color *= mix(0.45, 1.0, vignette);

        gl_FragColor = vec4(color, 1.0);
      }
    `;

    function compile(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    }

    const vs = compile(gl.VERTEX_SHADER, vsSource);
    const fs = compile(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return;

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;

    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const posLoc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, 'u_res');
    const uTime = gl.getUniformLocation(program, 'u_time');
    const uMouse = gl.getUniformLocation(program, 'u_mouse');

    let mouseX = 0.5;
    let mouseY = 0.5;
    let targetX = 0.5;
    let targetY = 0.5;

    window.addEventListener('mousemove', function (e) {
      targetX = e.clientX / Math.max(window.innerWidth, 1);
      targetY = 1.0 - e.clientY / Math.max(window.innerHeight, 1);
    }, { passive: true });

    function resize() {
      const isMobile = window.innerWidth < 768;
      const dpr = Math.min(window.devicePixelRatio || 1, isMobile ? 1.0 : 1.25);
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

    let rafId = null;
    let startTime = performance.now();
    let pausedAt = 0;

    function render(now) {
      mouseX += (targetX - mouseX) * 0.03;
      mouseY += (targetY - mouseY) * 0.03;

      const elapsed = ((now - startTime) * 0.001) % 3600.0;

      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, elapsed);
      gl.uniform2f(uMouse, mouseX, mouseY);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      rafId = requestAnimationFrame(render);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = null;
          pausedAt = performance.now();
        }
      } else if (!rafId) {
        if (pausedAt) startTime += performance.now() - pausedAt;
        rafId = requestAnimationFrame(render);
      }
    });

    rafId = requestAnimationFrame(render);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSmokeShader);
  } else {
    initSmokeShader();
  }
})();