/* ============================================================
   SNOWCLIENT — smoke-shader.js
   Объёмные волны на WebGL: обсидиан #040406 → графит #11141c → лёд #dbeafe.
   Курсор закручивает поток и поднимает рябь, чтобы сквозь стеклянные
   карточки всегда было видно движение.

   Подключение (до script.js, достаточно одного тега):
     <script src="smoke-shader.js" defer></script>
   Канвас можно задать самому: <canvas id="smokeCanvas"></canvas>
   Если его нет, шейдер создаст его сам.
   ============================================================ */

(() => {
  'use strict';

  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TOUCH   = window.matchMedia('(hover: none)').matches;

  /* ── Шейдеры ─────────────────────────────────────────── */
  const VERT = `
    attribute vec2 aPos;
    void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
  `;

  const FRAG = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif

    uniform vec2  uRes;
    uniform float uTime;
    uniform vec2  uMouse;   // 0..1, y вверх, уже сглажен на CPU
    uniform float uEnergy;  // 0..1, скорость курсора (поднимает рябь)

    const vec3 C_OBSIDIAN = vec3(0.0157, 0.0157, 0.0235); // #040406
    const vec3 C_GRAPHITE = vec3(0.0667, 0.0784, 0.1098); // #11141c
    const vec3 C_ICE      = vec3(0.8588, 0.9176, 0.9961); // #dbeafe

    /* Поле высоты: доменный варп синусами. Дешевле шумовых fbm,
       при этом даёт длинные плавные гребни без видимой сетки. */
    float field(vec2 p, float t, vec2 m, float energy) {
      vec2 d   = p - m;
      float r2 = dot(d, d);
      float inf = exp(-r2 * 2.6);

      // курсор закручивает поток вокруг себя
      p += vec2(-d.y, d.x) * inf * (0.55 + energy * 0.9);

      vec2 q = p;
      q += vec2(sin(q.y * 1.35 + t * 0.23), cos(q.x * 1.15 - t * 0.19)) * 0.62;
      q += vec2(sin(q.y * 2.10 - t * 0.31 + 1.7), cos(q.x * 1.85 + t * 0.27 + 0.6)) * 0.30;
      q += vec2(sin(q.y * 3.40 + t * 0.41 + 3.1), cos(q.x * 3.10 - t * 0.37 + 2.2)) * 0.12;

      float a = sin(q.x * 1.10 + q.y * 0.70 + t * 0.14) * 0.5 + 0.5;
      float b = sin(q.x * 2.05 - q.y * 1.25 - t * 0.11 + 1.3) * 0.5 + 0.5;
      float c = sin(q.x * 0.55 + q.y * 1.90 + t * 0.08 + 4.0) * 0.5 + 0.5;

      float h = a * 0.52 + b * 0.30 + c * 0.18;
      h = h * h * (3.0 - 2.0 * h);              // мягкая S-кривая: широкие впадины, узкие гребни

      // рябь от курсора
      float ring = sin(sqrt(r2) * 13.0 - t * 2.2) * 0.5 + 0.5;
      h += inf * (0.07 + energy * 0.12) * ring;
      return h;
    }

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / uRes;
      float asp = uRes.x / uRes.y;
      vec2 p = (uv - 0.5) * vec2(asp, 1.0) * 2.1;
      vec2 m = (uMouse - 0.5) * vec2(asp, 1.0) * 2.1;
      float t = uTime;

      const float e = 0.012;
      float h  = field(p, t, m, uEnergy);
      float hx = field(p + vec2(e, 0.0), t, m, uEnergy);
      float hy = field(p + vec2(0.0, e), t, m, uEnergy);

      // нормаль поверхности из конечных разностей
      vec3 n = normalize(vec3((h - hx) / e * 0.26, (h - hy) / e * 0.26, 1.0));
      vec3 L = normalize(vec3(-0.45, 0.62, 0.64));
      vec3 V = vec3(0.0, 0.0, 1.0);

      float diff = clamp(dot(n, L), 0.0, 1.0);
      float spec = pow(clamp(dot(reflect(-L, n), V), 0.0, 1.0), 26.0);
      float rim  = pow(1.0 - clamp(n.z, 0.0, 1.0), 2.2);

      // тоновая шкала: обсидиан → графит → лёд только на гребнях
      vec3 col = mix(C_OBSIDIAN, C_GRAPHITE, smoothstep(0.08, 0.58, h));
      float crest = smoothstep(0.62, 0.97, h);
      col = mix(col, C_ICE, crest * crest * 0.88);

      // объём: мягкий свет по склонам и тонкий блик на гребнях
      col += C_GRAPHITE * diff * 0.55;
      col += C_ICE * (spec * 0.22 + rim * 0.07) * (0.35 + crest);

      // подсветка у курсора
      float glow = exp(-dot(p - m, p - m) * 3.4);
      col += vec3(0.30, 0.38, 0.52) * glow * (0.05 + uEnergy * 0.07);

      // виньетка к чистому обсидиану, чтобы края страницы оставались чёрными
      float vig = smoothstep(1.35, 0.25, length((uv - 0.5) * vec2(asp * 0.85, 1.0)));
      col = mix(C_OBSIDIAN, col, 0.30 + vig * 0.70);

      // дизеринг против бэндинга на тёмных градиентах
      col += (hash(gl_FragCoord.xy + fract(t)) - 0.5) / 255.0;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  /* ── Канвас ──────────────────────────────────────────── */
  let canvas = document.getElementById('smokeCanvas');
  const created = !canvas;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'smokeCanvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none;display:block;background:#040406;';
    document.body.prepend(canvas);
  }

  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false
  });

  if (!gl) {
    document.documentElement.classList.add('no-webgl');
    return;
  }

  /* ── Сборка программы ────────────────────────────────── */
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('[smoke-shader]', gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  let prog, uRes, uTime, uMouse, uEnergy, buffer;

  function init() {
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;

    prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[smoke-shader]', gl.getProgramInfoLog(prog));
      return false;
    }
    gl.useProgram(prog);

    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    uRes    = gl.getUniformLocation(prog, 'uRes');
    uTime   = gl.getUniformLocation(prog, 'uTime');
    uMouse  = gl.getUniformLocation(prog, 'uMouse');
    uEnergy = gl.getUniformLocation(prog, 'uEnergy');
    return true;
  }

  if (!init()) {
    document.documentElement.classList.add('no-webgl');
    return;
  }

  /* ── Разрешение: рисуем в уменьшенном буфере ─────────── */
  /* Сцена всё равно проходит через blur(32px) стеклянных
     карточек, поэтому полное разрешение ничего не добавляет.
     Масштаб подстраивается под реальное время кадра. */
  let scale = TOUCH ? 0.5 : 0.62;
  const SCALE_MIN = 0.34;
  const SCALE_MAX = TOUCH ? 0.55 : 0.8;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(2, Math.floor(canvas.clientWidth  * dpr * scale));
    const h = Math.max(2, Math.floor(canvas.clientHeight * dpr * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.uniform2f(uRes, w, h);
  }

  /* ── Курсор: критически демпфированная пружина ────────── */
  const mouse = { x: 0.5, y: 0.5, vx: 0, vy: 0, tx: 0.5, ty: 0.5 };
  let energy = 0, lastMX = 0.5, lastMY = 0.5;

  window.addEventListener('pointermove', e => {
    mouse.tx = e.clientX / window.innerWidth;
    mouse.ty = 1 - e.clientY / window.innerHeight;
  }, { passive: true });

  window.addEventListener('pointerleave', () => { mouse.tx = 0.5; mouse.ty = 0.5; });

  function stepMouse(dt) {
    const k = 46, c = 2 * Math.sqrt(k);            // жёсткость и демпфирование
    mouse.vx += ((mouse.tx - mouse.x) * k - mouse.vx * c) * dt;
    mouse.vy += ((mouse.ty - mouse.y) * k - mouse.vy * c) * dt;
    mouse.x += mouse.vx * dt;
    mouse.y += mouse.vy * dt;

    const speed = Math.hypot(mouse.x - lastMX, mouse.y - lastMY) / Math.max(dt, 0.001);
    lastMX = mouse.x; lastMY = mouse.y;
    const target = Math.min(speed * 0.9, 1);
    energy += (target - energy) * Math.min(1, dt * (target > energy ? 9 : 2.4));
  }

  /* ── Цикл ────────────────────────────────────────────── */
  let raf = 0, running = false, last = 0, clock = 0;
  let slowFrames = 0, fastFrames = 0, lowCooldown = 0;

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);

    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    clock += dt;
    if (clock > 4000) clock = 0;                    // защита точности mediump

    stepMouse(dt);

    gl.uniform1f(uTime, clock);
    gl.uniform2f(uMouse, mouse.x, mouse.y);
    gl.uniform1f(uEnergy, energy);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // адаптивное качество
    if (lowCooldown > 0) { lowCooldown -= dt; return; }
    if (dt > 0.026) { slowFrames++; fastFrames = 0; }
    else if (dt < 0.0185) { fastFrames++; slowFrames = 0; }
    else { slowFrames = fastFrames = 0; }

    if (slowFrames > 24 && scale > SCALE_MIN) {
      scale = Math.max(SCALE_MIN, scale - 0.08);
      slowFrames = 0; lowCooldown = 1.2; resize();
    } else if (fastFrames > 240 && scale < SCALE_MAX) {
      scale = Math.min(SCALE_MAX, scale + 0.05);
      fastFrames = 0; lowCooldown = 2.5; resize();
    }
  }

  function start() {
    if (running || REDUCED) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  function drawStill() {
    resize();
    gl.uniform1f(uTime, 7.5);
    gl.uniform2f(uMouse, 0.5, 0.5);
    gl.uniform1f(uEnergy, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* ── События окружения ───────────────────────────────── */
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resize(); if (!running) drawStill(); }, 90);
  });

  document.addEventListener('visibilitychange', () => {
    document.hidden ? stop() : start();
  });

  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); stop(); });
  canvas.addEventListener('webglcontextrestored', () => {
    if (init()) { resize(); REDUCED ? drawStill() : start(); }
  });

  /* ── Старт ───────────────────────────────────────────── */
  resize();
  if (REDUCED) {
    drawStill();                                    // статичный кадр без анимации
  } else {
    start();
  }
  document.documentElement.classList.add('smoke-ready');

  window.SmokeShader = {
    start,
    stop,
    destroy() {
      stop();
      if (created) canvas.remove();
      document.documentElement.classList.remove('smoke-ready');
    }
  };
})();
