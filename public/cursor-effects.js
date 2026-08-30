/* 光标水面动效：整个页面视作平静水面，鼠标划过如小船切水、点击如石头砸水面。
   机制：低分辨率高度场跑波动方程（波纹扩散/叠加/衰减由物理自然给出），逐格求梯度渲染成
        无色「白色波光 + 深蓝暗影」叠在页面上——页面文字随波纹明暗起伏，全程彩色零使用，
        天然双主题中性；低分辨率 ImageData 经 GPU 平滑放大全屏，像素间渐变连续无颗粒。
   画布由本脚本自建：position:fixed 盖满视口、z-index 60（模态框 50 之上）、pointer-events:none。
   空闲即停 rAF（场能量收敛后零常驻开销）；prefers-reduced-motion 强制关闭并监听系统变化。
   顶栏开关经 window.csmCursorFx.setEnabled 控制；用户偏好存 localStorage 'csm-cursor-fx'（'off' 为关，其余一律默认开）。 */
(function () {
  'use strict';

  /* 调参区：分辨率/阻尼/扰动强度/明暗上限的唯一出处，调观感只动这里。 */
  var TUNE = {
    simDiv: 6, // 波动场分辨率除数（视口/6；1280×800→~214×134 格）
    damping: 0.978, // 波阻尼：越小波纹衰减越快（尾迹收紧成 V 形，不拖泥带影）
    moveStep: 8, // 划过扰动核沿路径的落点间隔 px
    moveRadius: 2, // 划过扰动核半径（格）
    moveAmp: 0.6, // 划过扰动振幅上限（随指针速度取幅）
    clickRadius: 5, // 点击水花半径（格）
    clickAmp: 3.0, // 点击水花振幅（负值扰动=先压下水面，更像落石）
    lightGain: 0.55, // 波面梯度→明暗透明度增益（带符号平方压缩后使用）
    glintAlpha: 0.3, // 白色波光透明度上限
    shadeAlpha: 0.15, // 深蓝暗影透明度上限（低上限防浅色主题显脏）
    stopEps: 0.004, // 停机能量阈值（抽样）
    stopFrames: 30 // 连续低能帧数达到后停 rAF
  };

  var canvas = null;
  var ctx = null;
  var simCanvas = null;
  var simCtx = null;
  var simImg = null;
  var simW = 0;
  var simH = 0;
  var bufCur = null; // 高度场双缓冲
  var bufPrev = null;
  var raf = 0;
  var enabled = false;
  var pref = true;
  var lastX = null;
  var lastY = null;
  var lastT = 0;
  var quietFrames = 0;

  /* 扰动：圆形核 + 余弦包络（中心强边缘零），波感柔和不生硬。 */
  function disturb(cx, cy, radius, amp) {
    var gx = Math.round(cx);
    var gy = Math.round(cy);
    var r2 = radius * radius;
    var y0 = Math.max(1, gy - radius);
    var y1 = Math.min(simH - 2, gy + radius);
    var x0 = Math.max(1, gx - radius);
    var x1 = Math.min(simW - 2, gx + radius);
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var dx = x - gx;
        var dy = y - gy;
        var d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        bufPrev[y * simW + x] += amp * Math.cos((Math.sqrt(d2) / radius) * Math.PI * 0.5);
      }
    }
  }

  /* 波动方程：next = (四邻均值) − 前值，乘阻尼；边界恒 0 为吸收岸。 */
  function step() {
    var w = simW;
    var h = simH;
    var damp = TUNE.damping;
    for (var y = 1; y < h - 1; y++) {
      var row = y * w;
      for (var x = 1; x < w - 1; x++) {
        var i = row + x;
        var v = (bufPrev[i - 1] + bufPrev[i + 1] + bufPrev[i - w] + bufPrev[i + w]) / 2 - bufCur[i];
        bufCur[i] = v * damp;
      }
    }
    var tmp = bufPrev;
    bufPrev = bufCur;
    bufCur = tmp;
  }

  /* 渲染：梯度→明暗。亮=白波光、暗=深蓝影，低分辨率 ImageData 放大成全屏连续渐变。 */
  function render() {
    var data = simImg.data;
    var w = simW;
    var h = simH;
    var gain = TUNE.lightGain;
    for (var y = 1; y < h - 1; y++) {
      var row = y * w;
      for (var x = 1; x < w - 1; x++) {
        var i = row + x;
        var dx = bufPrev[i + 1] - bufPrev[i - 1];
        var dy = bufPrev[i + w] - bufPrev[i - w];
        // 带符号平方：抑制低梯度区（防扰动堆叠处糊成一片），只让波前亮暗成线。
        var s = dx + dy;
        var l = s * (s < 0 ? -s : s) * gain;
        var p = i * 4;
        if (l > 0.02) {
          var a = Math.min(TUNE.glintAlpha, l);
          data[p] = 255;
          data[p + 1] = 255;
          data[p + 2] = 255;
          data[p + 3] = (a * 255) | 0;
        } else if (l < -0.02) {
          var b = Math.min(TUNE.shadeAlpha, -l);
          data[p] = 15;
          data[p + 1] = 23;
          data[p + 2] = 42;
          data[p + 3] = (b * 255) | 0;
        } else {
          data[p + 3] = 0;
        }
      }
    }
    simCtx.putImageData(simImg, 0, 0);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.drawImage(simCanvas, 0, 0, simW, simH, 0, 0, window.innerWidth, window.innerHeight);
  }

  /* 场能量抽样：全场 |高度| 低于阈值视为水面恢复平静。 */
  function fieldQuiet() {
    for (var i = simW; i < bufPrev.length - simW; i += 17) {
      if (Math.abs(bufPrev[i]) > TUNE.stopEps) return false;
    }
    return true;
  }

  function frame() {
    raf = 0;
    step();
    render();
    if (fieldQuiet()) quietFrames++;
    else quietFrames = 0;
    if (quietFrames < TUNE.stopFrames) {
      raf = window.requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      lastX = null;
    }
  }

  function kick() {
    quietFrames = 0;
    if (!raf) raf = window.requestAnimationFrame(frame);
  }

  function onPointerMove(e) {
    var x = e.clientX;
    var y = e.clientY;
    var t = performance.now();
    if (lastX === null) {
      lastX = x;
      lastY = y;
      lastT = t;
      return;
    }
    var dx = x - lastX;
    var dy = y - lastY;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < TUNE.moveStep) return;
    var dt = Math.max(8, t - lastT);
    // 船体吃水深度随航速：快则波大、慢则涟漪轻，慢速也有下限避免"不动的船"。
    var amp = Math.min(TUNE.moveAmp, 0.3 + (dist / dt) * 1.1);
    var steps = Math.floor(dist / TUNE.moveStep);
    for (var i = 1; i <= steps; i++) {
      disturb(
        (lastX + (dx * i) / steps) / TUNE.simDiv,
        (lastY + (dy * i) / steps) / TUNE.simDiv,
        TUNE.moveRadius,
        amp
      );
    }
    lastX = x;
    lastY = y;
    lastT = t;
    kick();
  }

  function onPointerDown(e) {
    disturb(e.clientX / TUNE.simDiv, e.clientY / TUNE.simDiv, TUNE.clickRadius, -TUNE.clickAmp);
    kick();
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    simW = Math.max(2, Math.ceil(window.innerWidth / TUNE.simDiv));
    simH = Math.max(2, Math.ceil(window.innerHeight / TUNE.simDiv));
    bufCur = new Float32Array(simW * simH);
    bufPrev = new Float32Array(simW * simH);
    simCanvas.width = simW;
    simCanvas.height = simH;
    simImg = simCtx.createImageData(simW, simH);
    lastX = null;
  }

  var resizeTimer = 0;
  function onResize() {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(resize, 120);
  }

  var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  function apply() {
    var next = pref && !mq.matches && !!ctx;
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
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
      lastX = null;
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
  simCanvas = document.createElement('canvas');
  simCtx = simCanvas.getContext('2d');
  if (!simCtx) return;

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

  // 系统「减弱动态效果」变化即时开合；无色渲染无需监听主题切换。
  if (mq.addEventListener) mq.addEventListener('change', apply);
  else if (mq.addListener) mq.addListener(apply);

  apply();
})();
