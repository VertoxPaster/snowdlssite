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

      float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
      float noise(vec2 p){
        vec2 i=floor(p),f=fract(p),u=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);
      }
      float fbm(vec2 p){
        float v=0.0,a=0.5;
        mat2 r=mat2(0.8,-0.6,0.6,0.8);
        for(int i=0;i<4;i++){v+=a*noise(p);p=r*p*2.0+vec2(1.7,9.2);a*=0.5;}
        return v;
      }
      // высота "ткани": складки шёлка
      float cloth(vec2 p,float t){
        vec2 w=vec2(fbm(p*0.9+vec2(0.0,t*0.5)),fbm(p*0.9+vec2(5.2,1.3)-t*0.4));
        p+=1.6*(w-0.5);
        float h=sin(p.x*1.9+p.y*1.1+fbm(p*1.3+t*0.3)*4.0)*0.5+0.5;
        h+=0.35*(sin(p.x*3.7-p.y*2.3+fbm(p*2.1)*5.0)*0.5+0.5);
        return h/1.35;
      }
      void main(){
        vec2 uv=gl_FragCoord.xy/u_res.xy;
        float asp=u_res.x/max(u_res.y,1.0);
        vec2 p=vec2((uv.x-0.5)*asp,uv.y-0.5)*2.2;
        p+=(u_mouse-0.5)*0.2;
        float t=u_time*0.08;
        float e=0.02;
        float h=cloth(p,t);
        float hx=cloth(p+vec2(e,0.0),t);
        float hy=cloth(p+vec2(0.0,e),t);
        vec3 n=normalize(vec3((h-hx)/e*0.35,(h-hy)/e*0.35,1.0));
        vec3 L=normalize(vec3(-0.5,0.6,0.7));
        float diff=clamp(dot(n,L),0.0,1.0);
        float spec=pow(clamp(dot(reflect(-L,n),vec3(0,0,1)),0.0,1.0),18.0);
        vec3 color=vec3(0.010)+vec3(0.060)*diff*diff+vec3(0.55,0.55,0.58)*spec*0.28;
        float d=length((uv-0.5)*vec2(1.1,1.0));
        color*=mix(0.35,1.0,smoothstep(0.95,0.15,d));
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