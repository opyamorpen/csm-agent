/* 光标水面涟漪动效：划过=波痕拖尾+沿途细环缓绽（树枝划水），点击=三层同心环错峰扩散+中心闪光（石头砸水面）。
   一套机制两套渲染：浅色=蓝墨水涟漪（source-over 无泛光），深色=霓虹水光（lighter 叠加 + shadowBlur，贴合深色 glow 语言）。
   画布由本脚本自建：position:fixed 盖满视口、z-index 60（模态框 50 之上）、pointer-events:none 不挡任何交互。
   空闲即停 rAF（无存活粒子时零常驻开销）；prefers-reduced-motion 强制关闭并监听系统变化实时生效。
   顶栏开关经 window.csmCursorFx.setEnabled 控制；用户偏好存 localStorage 'csm-cursor-fx'（'off' 为关，其余一律默认开）。 */
(function () {
  'use strict';

  /* 调参区：尺寸/时长/浓度的唯一出处，调观感只动这里。 */
  var TUNE = {
    trailLife: 650, // 拖尾点存活 ms
    trailSpacing: 6, // 采样最小间距 px
    trailMax: 120, // 拖尾点上限
    wakeWidth: 7, // 波痕峰值线宽 px（随年龄渐细到 0.5）
    wakeAlpha: 0.38, // 波痕峰值透明度（二次方衰减）
    wobbleAmp: 2.2, // 侧摆幅度 px（树枝摇曳感）
    wobbleFreq: 0.09, // 侧摆空间频率（沿轨迹里程）
    ringSpacing: 30, // 沿途细环间隔 px
    ringR1: 16, // 细环终止半径 px
    ringDur: 400, // 细环寿命 ms
    ringAlpha: 0.45, // 细环峰值透明度
    clickR1: 70, // 点击同心环终止半径 px（2026-08-30 用户反馈 110 偏大 → 收敛）
    clickDur: 650, // 点击环寿命 ms
    clickAlpha: 0.55, // 点击环峰值透明度
    clickStagger: 80, // 三层错峰间隔 ms
    flashR: 10, // 中心闪光初始半径 px
    flashDur: 220, // 中心闪光寿命 ms
    glowBlur: 10 // 深色霓虹泛光 px
  };

  var canvas = null;
  var ctx = null;
  var raf = 0;
  var enabled = false;
  var pref = true;
  var dark = false;
  var colors = { wake: null, ring: null };
  var trail = [];
  var rings = [];
  var flashes = [];
  var lastX = null;
  var lastY = null;
  var distAcc = 0;

  function parseColor(str) {
    if (!str) return null;
    var s = String(str).trim();
    var m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) {
      var hex = m[1];
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
    }
    m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
    return null;
  }

  function withAlpha(c, a) {
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a.toFixed(3) + ')';
  }

  function readColors() {
    dark = document.documentElement.dataset.theme === 'dark';
    var s = window.getComputedStyle(document.documentElement);
    colors.wake = parseColor(s.getPropertyValue('--fx-wake')) || parseColor(dark ? '#22d3ee' : '#2457c5');
    colors.ring = parseColor(s.getPropertyValue('--fx-ring')) || parseColor(dark ? '#4f8cff' : '#3d85f8');
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  var resizeTimer = 0;
  function onResize() {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(resize, 120);
  }

  function onPointerMove(e) {
    var t = performance.now();
    var x = e.clientX;
    var y = e.clientY;
    if (lastX === null) {
      lastX = x;
      lastY = y;
    }
    var dx = x - lastX;
    var dy = y - lastY;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < TUNE.trailSpacing) return;
    // 沿途细环：按累计里程每 ringSpacing px 绽一朵；快速滑动一次跨多个间距时沿线段补齐，波痕不断档。
    distAcc += dist;
    var steps = Math.floor(distAcc / TUNE.ringSpacing);
    if (steps > 0) {
      distAcc -= steps * TUNE.ringSpacing;
      for (var i = 1; i <= steps; i++) {
        rings.push({
          x: lastX + (dx * i) / steps,
          y: lastY + (dy * i) / steps,
          t0: t,
          dur: TUNE.ringDur,
          r0: 2,
          r1: TUNE.ringR1,
          lw0: 1.6,
          lw1: 0.4,
          a0: TUNE.ringAlpha
        });
      }
      if (rings.length > 90) rings.splice(0, rings.length - 90);
    }
    lastX = x;
    lastY = y;
    trail.push({ x: x, y: y, t: t });
    if (trail.length > TUNE.trailMax) trail.shift();
    kick();
  }

  function onPointerDown(e) {
    var t = performance.now();
    for (var i = 0; i < 3; i++) {
      rings.push({
        x: e.clientX,
        y: e.clientY,
        t0: t + i * TUNE.clickStagger,
        dur: TUNE.clickDur,
        r0: 6,
        r1: TUNE.clickR1,
        lw0: 3,
        lw1: 0.8,
        a0: TUNE.clickAlpha
      });
    }
    flashes.push({ x: e.clientX, y: e.clientY, t0: t, dur: TUNE.flashDur, r0: TUNE.flashR, a0: 0.5 });
    kick();
  }

  function drawWake(t) {
    var n = trail.length;
    if (n < 2) return;
    var life = TUNE.trailLife;
    var s = 0; // 沿轨迹的累计里程，驱动侧摆相位
    for (var i = 1; i < n; i++) {
      var p0 = trail[i - 1];
      var p1 = trail[i];
      var dx = p1.x - p0.x;
      var dy = p1.y - p0.y;
      var seg = Math.sqrt(dx * dx + dy * dy) || 0.001;
      s += seg;
      var k1 = Math.max(0, 1 - (t - p1.t) / life);
      var k0 = Math.max(0, 1 - (t - p0.t) / life);
      if (k1 <= 0) continue;
      // 侧摆：垂直于前进方向的正弦偏移，相位随里程+时间演化，波痕呈摇曳的水痕而非僵硬折线。
      var nx = -dy / seg;
      var ny = dx / seg;
      var w1 = Math.sin(s * TUNE.wobbleFreq + t * 0.008) * TUNE.wobbleAmp * k1;
      var w0 = Math.sin((s - seg) * TUNE.wobbleFreq + t * 0.008) * TUNE.wobbleAmp * k0;
      ctx.strokeStyle = withAlpha(colors.wake, TUNE.wakeAlpha * k1 * k1);
      ctx.lineWidth = 0.5 + (TUNE.wakeWidth - 0.5) * k1;
      ctx.beginPath();
      ctx.moveTo(p0.x + nx * w0, p0.y + ny * w0);
      ctx.lineTo(p1.x + nx * w1, p1.y + ny * w1);
      ctx.stroke();
    }
  }

  function drawRing(r, t) {
    var p = (t - r.t0) / r.dur;
    if (p < 0 || p > 1) return;
    var e = 1 - Math.pow(1 - p, 3); // easeOutCubic：入水冲击快、扩散尾声慢
    ctx.strokeStyle = withAlpha(colors.ring, r.a0 * (1 - p));
    ctx.lineWidth = r.lw0 + (r.lw1 - r.lw0) * e;
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * e, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawFlash(f, t) {
    var p = (t - f.t0) / f.dur;
    if (p < 0 || p > 1) return;
    ctx.fillStyle = withAlpha(colors.ring, f.a0 * (1 - p));
    ctx.beginPath();
    ctx.arc(f.x, f.y, Math.max(0.1, f.r0 * (1 - p)), 0, Math.PI * 2);
    ctx.fill();
  }

  function frame() {
    raf = 0;
    var t = performance.now();
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    // 过期清理；切后台 rAF 暂停再回来时年龄自然超限被清，不会滞留爆发。
    while (trail.length && t - trail[0].t > TUNE.trailLife) trail.shift();
    rings = rings.filter(function (r) { return t <= r.t0 + r.dur; });
    flashes = flashes.filter(function (f) { return t <= f.t0 + f.dur; });

    ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowBlur = dark ? TUNE.glowBlur : 0;
    ctx.shadowColor = dark ? withAlpha(colors.ring, 0.9) : 'transparent';

    drawWake(t);
    for (var i = 0; i < rings.length; i++) drawRing(rings[i], t);
    for (var j = 0; j < flashes.length; j++) drawFlash(flashes[j], t);

    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';

    // 空闲即停：没有存活粒子就退出循环，下一次事件再 kick 唤醒。
    if (trail.length > 1 || rings.length > 0 || flashes.length > 0) {
      raf = window.requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      lastX = null;
    }
  }

  function kick() {
    if (!raf) raf = window.requestAnimationFrame(frame);
  }

  var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  function apply() {
    var next = pref && !mq.matches && !!ctx;
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      readColors();
      resize();
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      window.addEventListener('pointerdown', onPointerDown, { passive: true });
      window.addEventListener('resize', onResize);
    } else {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onResize);
      if (raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
      trail = [];
      rings = [];
      flashes = [];
      lastX = null;
      distAcc = 0;
      if (ctx) ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  }

  canvas = document.createElement('canvas');
  canvas.id = 'fx-canvas';
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:60';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d');
  if (!ctx) return; // 无 2D 环境直接退出，特效整体缺席

  try {
    pref = window.localStorage.getItem('csm-cursor-fx') !== 'off';
  } catch (error) {
    pref = true;
  }

  window.csmCursorFx = {
    setEnabled: function (on) {
      pref = !!on;
      apply();
    },
    isEnabled: function () {
      return enabled;
    }
  };

  // 主题切换即时换色；系统「减弱动态效果」变化即时开合。
  new MutationObserver(function () {
    if (enabled) readColors();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (mq.addEventListener) mq.addEventListener('change', apply);
  else if (mq.addListener) mq.addListener(apply);

  readColors();
  apply();
})();
