// Мелкий снег: идёт только ниже первого разделителя (там, где тёмно-серый фон).
// На первом экране с картинкой (.top-bg) снега нет.
(function () {
  var canvas = document.getElementById('snowCanvas');
  var topBg = document.querySelector('.top-bg');
  if (!canvas || !topBg) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { canvas.style.display = 'none'; return; }
  var ctx = canvas.getContext('2d');
  var W = 0, H = 0, dpr = 1, flakes = [];

  function make(initial) {
    var r = 0.5 + Math.random() * 1.4;            // маленькие снежинки
    return {
      x: Math.random() * W,
      y: initial ? Math.random() * H : -4,
      r: r,
      vy: 14 + r * 14 + Math.random() * 10,       // px/сек, крупнее — чуть быстрее
      sw: 6 + Math.random() * 14,                 // амплитуда покачивания
      sp: 0.4 + Math.random() * 0.9,
      ph: Math.random() * 6.28,
      a: 0.25 + Math.random() * 0.55
    };
  }
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    canvas.width = Math.floor(W * dpr); canvas.height = Math.floor(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var n = Math.round(Math.min(160, Math.max(60, W * H / 11000)));
    flakes = []; for (var i = 0; i < n; i++) flakes.push(make(true));
  }
  addEventListener('resize', resize); resize();

  var last = performance.now();
  function frame(now) {
    var dt = Math.min(0.05, (now - last) / 1000); last = now;
    // нижняя граница картинки в координатах окна; ниже неё снег виден
    var cut = document.body.classList.contains('auth-open') ? 0 : topBg.getBoundingClientRect().bottom;
    if (cut >= H) { ctx.clearRect(0, 0, W, H); canvas.style.visibility = 'hidden'; requestAnimationFrame(frame); return; }
    canvas.style.visibility = 'visible';
    canvas.style.clipPath = 'inset(' + Math.max(0, Math.round(cut)) + 'px 0 0 0)';
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    for (var i = 0; i < flakes.length; i++) {
      var f = flakes[i];
      f.y += f.vy * dt;
      f.ph += f.sp * dt;
      var x = f.x + Math.sin(f.ph) * f.sw;
      if (f.y > H + 4) { flakes[i] = make(false); continue; }
      ctx.globalAlpha = f.a;
      ctx.beginPath(); ctx.arc(x, f.y, f.r, 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', function () { last = performance.now(); });
  requestAnimationFrame(frame);
})();
