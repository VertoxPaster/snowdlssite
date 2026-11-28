// Фон как в главном меню клиента (menu_bg.fsh), портирован на WebGL1
(function () {
  var canvas = document.getElementById('smokeCanvas');
  if (!canvas) return;
  var gl = canvas.getContext('webgl', { antialias: false, alpha: false }) || canvas.getContext('experimental-webgl');
  if (!gl) return;

  var vs = 'attribute vec2 a;varying vec2 uv;void main(){uv=a*0.5+0.5;gl_Position=vec4(a,0.0,1.0);}';
  var fs = [
    'precision highp float;',
    'varying vec2 uv;',
    'uniform vec3 color1;uniform vec3 color2;',
    'uniform vec4 p0;uniform vec4 p1;',
    'float hash21(vec2 p){vec3 p3=fract(vec3(p.xyx)*0.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}',
    'float ribbonW(vec2 q,float ang,float freq,float ph,float amp,float off,float t){',
    '  float c=cos(ang),s=sin(ang);',
    '  vec2 r=vec2(c*q.x-s*q.y,s*q.x+c*q.y);',
    '  return r.y-off+amp*sin(r.x*freq+ph+t)+0.45*amp*sin(r.x*freq*2.1-ph-t*0.7)+0.2*amp*sin(r.x*freq*3.7+ph*2.0+t*0.4);',
    '}',
    'vec3 ribbons(vec2 q,float ang,float t,vec3 c1,vec3 c2,float seed){',
    '  vec3 acc=vec3(0.0);',
    '  for(int i=0;i<6;i++){',
    '    float fi=float(i);',
    '    float w=ribbonW(q,ang,0.85+0.12*fi,fi*1.3+seed*3.0,0.17+0.015*fi,-0.28+0.14*fi,t*(0.5+0.1*fi));',
    '    float body=(1.0-smoothstep(-0.50,0.03,w))*exp(min(w,0.0)*1.5)*0.70;',
    '    float edge=exp(-w*w*1400.0)*1.25+exp(-w*w*60.0)*0.30;',
    '    vec3 base=mix(c1,c2,clamp(0.15+0.17*fi,0.0,1.0));',
    '    vec3 edgeCol=mix(base,vec3(1.0),0.15);',
    '    acc+=base*body*(0.50-0.05*fi)+edgeCol*edge*(0.65-0.06*fi);',
    '  }',
    '  return acc;',
    '}',
    'void main(){',
    '  float aspect=p0.y;float energy=p1.y;float time=p1.z;float t=time*0.14;',
    '  vec2 mp=(p0.zw-0.5)*vec2(aspect,1.0);',
    '  vec2 q=(uv-0.5)*vec2(aspect,1.0)-mp*0.03;',
    '  vec3 c1=color1;vec3 c2=color2;',
    '  vec3 col=vec3(0.012,0.012,0.016);',
    '  float mBL=1.0-smoothstep(0.15,1.05,length((uv-vec2(0.0,0.10))*vec2(1.0,1.1)));',
    '  col+=ribbons(q,-0.95,t,c1,c2,0.0)*mBL*1.30;',
    '  float mTR=1.0-smoothstep(0.10,0.85,length((uv-vec2(1.0,0.98))*vec2(0.85,1.0)));',
    '  col+=ribbons(q,2.15,t*0.9,c1,c2,1.7)*mTR*1.10;',
    '  col+=mix(c1,c2,0.4)*(mBL*0.10+mTR*0.08);',
    '  col+=mix(c1,vec3(1.0),0.3)*exp(-length((uv-p0.zw)*vec2(aspect,1.0))*5.0)*(0.02+0.04*energy);',
    '  float center=1.0-0.60*exp(-pow(length((uv-0.5)*vec2(1.5,1.0)),2.0)*8.0);',
    '  col*=center;',
    '  float vig=1.0-smoothstep(0.60,1.40,length((uv-0.5)*vec2(1.0,1.1)));',
    '  col*=mix(0.70,1.0,vig);',
    '  col*=0.42;',
    '  col=1.0-exp(-col*1.75);',
    '  col=pow(col,vec3(0.95));',
    '  col*=p1.x;',
    '  col+=(hash21(gl_FragCoord.xy)-0.5)*(1.2/255.0);',
    '  gl_FragColor=vec4(col,1.0);',
    '}'
  ].join('\n');

  function sh(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); return null; }
    return s;
  }
  var v = sh(gl.VERTEX_SHADER, vs), f = sh(gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return;
  var pr = gl.createProgram();
  gl.attachShader(pr, v); gl.attachShader(pr, f); gl.linkProgram(pr);
  gl.useProgram(pr);

  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(pr, 'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  var U = {
    c1: gl.getUniformLocation(pr, 'color1'), c2: gl.getUniformLocation(pr, 'color2'),
    p0: gl.getUniformLocation(pr, 'p0'), p1: gl.getUniformLocation(pr, 'p1')
  };
  // цвета ленточек (лавандовый -> светлый), как в меню
  gl.uniform3f(U.c1, 0.20, 0.17, 0.30);
  gl.uniform3f(U.c2, 0.38, 0.35, 0.48);

  var SCALE = 0.6; // рендер в пониженном разрешении, фон и так мягкий
  function resize() {
    var w = Math.max(2, Math.floor(innerWidth * SCALE)), h = Math.max(2, Math.floor(innerHeight * SCALE));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
  }
  addEventListener('resize', resize); resize();

  var mx = 0.5, my = 0.5, tx = 0.5, ty = 0.5, energy = 0, last = 0;
  addEventListener('mousemove', function (e) {
    tx = e.clientX / innerWidth; ty = 1 - e.clientY / innerHeight;
    energy = Math.min(1, energy + 0.15);
  });

  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var t0 = performance.now();
  function frame(now) {
    mx += (tx - mx) * 0.06; my += (ty - my) * 0.06;
    energy *= 0.96;
    var time = reduce ? 20 : (now - t0) / 1000 + 20;
    gl.uniform4f(U.p0, 0, innerWidth / innerHeight, mx, my);
    gl.uniform4f(U.p1, 1, energy, time, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (!reduce && !document.hidden) requestAnimationFrame(frame);
    else if (!reduce) setTimeout(function () { requestAnimationFrame(frame); }, 500);
  }
  requestAnimationFrame(frame);
})();