// ============================================================
// src/renderer.js —— 2D 版渲染层
//
// 它要解决五件事：
//   1. 把立绘摆到窗口里（比例定位，不写绝对像素）
//   2. 程序化动画：呼吸 / 摇摆 / 浮动
//   3. 表情：开心、被戳 —— 矢量小人换眼型／嘴型；贴图模式只换装
//   4. ★ 命中判定：光标哪里算「落在她身上」
//   5. 交互：点击反应、拖拽、右键退出、气泡、心情值
//
// ------------------------------------------------------------
// 和 3D 版最大的区别，以及它带来的好处：
//
//   3D 版的模型是一整块网格，没有形态键，所以**表情做不了** ——
//   只能靠代码画眼睛和嘴盖上去，最后还因为模型自带脸而关掉了，
//   代价是「不会眨眼」。那是 3D 版最大的一个遗憾。
//
//   2D 版不存在这个问题：**换一张贴图就是换一个表情**。
//   想加表情，加一张图就行 —— 但注意 AI 重画的「同角色不同表情」
//   并不是同一姿势，直接换图会闪（见 README「眨眼为什么被删掉」）。
//   这就是为什么值得为 2D 单开一条线。
//
// ------------------------------------------------------------
// ★ 这一版刻意没有用 canvas 画立绘，用的是 DOM + CSS transform。
//   原因有三：
//     · CSS transform 由合成器处理，比每帧重绘 canvas 省电得多
//       （桌宠是 7x24 开着的东西，省电不是小事）
//     · 立绘边缘的抗锯齿和缩放质量由浏览器保证，不用自己写重采样
//     · ★ 最关键：canvas 在 file:// 下读像素会被判「跨域污染」，
//       getImageData 直接抛 SecurityError。而命中判定恰恰需要读像素。
//       改用「离线烘焙好的遮罩网格 + 自己算矩阵」就完全绕开了这件事，
//       顺带还让命中判定变成一段可单独测试的纯数学。
//
// ------------------------------------------------------------
// 坐标系约定（全文件只有这一处约定，别在别处再立一套）：
//
//   #pet 是个零尺寸元素，它的原点 = 立绘的【脚底中线】。
//   于是立绘的局部坐标干净得像一张纸：
//
//        x ∈ [-W/2, +W/2]      横向，0 是中轴
//        y ∈ [-H, 0]           纵向，0 是脚底，-H 是头顶
//
//   屏幕坐标 = R(旋转) · S(缩放) · 局部坐标 + 锚点(ax, ay)
//
//   正向是这个式子，命中判定就把 s 反解回 p，反着走一遍。
//   同一个矩阵，两个方向 —— 这是这套写法最省心的地方。
// ============================================================

'use strict';

// ------------------------------------------------------------
// 零、取配置
//
// preload 用 sendSync 在主进程侧就把配置读好了，这里是同步拿到的，
// 所以第一帧渲染之前参数就已经就位，不会闪一下默认值。
// ------------------------------------------------------------
const CFG = window.petConfig;

if (!CFG || CFG._missing) {
  const hud = document.getElementById('hud');
  if (hud) {
    hud.innerHTML =
      '<div style="color:#a32d2d">没有拿到配置</div>' +
      '<div style="color:#5f5e5a">' +
      ((CFG && CFG._reason) || '主进程的配置频道没有注册') +
      '</div>';
  }
  throw new Error('petConfig 不可用');
}

// 为了方便调试，挂到全局上 —— 在开发者工具里敲 CFG.placement 就能看
window.CFG = CFG;

const DEBUG = CFG.debug || {};
const PLACE = CFG.placement || {};
const ANIM = CFG.animation || {};
const REACT = CFG.reaction || {};

// ------------------------------------------------------------
// 一、小工具
// ------------------------------------------------------------
const stage = document.getElementById('stage');
const petEl = document.getElementById('pet');
const spriteEl = document.getElementById('sprite');
const vectorEl = document.getElementById('vector');
const bubbleEl = document.getElementById('bubble');
const hudEl = document.getElementById('hud');
const hitStateEl = document.getElementById('hitState');
const hitMaskEl = document.getElementById('hitmask');

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 配置里的颜色写作 0xRRGGBB，CSS 要 '#rrggbb'。 */
function css(colorNum, alpha) {
  const n = (typeof colorNum === 'number' ? colorNum : 0) & 0xffffff;
  const hex = '#' + n.toString(16).padStart(6, '0');
  if (alpha === undefined || alpha >= 1) return hex;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 角度转弧度。2D 里角度更好读，所以配置写度、计算用弧度。 */
const DEG = Math.PI / 180;

// ============================================================
// 二、几何 —— 纯函数，不碰 DOM
//
// 这一节是整个 2D 版最需要保证正确的地方，所以刻意写成
// 不依赖任何浏览器状态的纯函数：给它一组数字，它还你一组数字。
// 这样 tests 里可以直接喂合成数据断言，不用去开窗口。
// ============================================================

/**
 * 立绘在窗口里的尺寸与锚点。
 *
 * H 由 placement.heightRatio 决定，W 由素材的宽高比决定 ——
 * 注意「由素材决定」这件事很关键：你不能写死 W/H，
 * 否则换一张不同比例的画就会变形。
 */
function computeLayout(winW, winH, aspect) {
  const H = PLACE.heightRatio * winH;
  const W = H * aspect;
  return {
    winW,
    winH,
    W,
    H,
    aspect,
    ax: PLACE.centerX * winW,     // 锚点 X（脚底中线的屏幕横坐标）
    ay: PLACE.groundY * winH,     // 锚点 Y（脚底的屏幕纵坐标）
  };
}

/**
 * 算出这一帧的变换参数。
 *
 * 返回值里的 (ax, ay, rot, sx, sy) 就是那个式子里的四个量：
 *     屏幕坐标 = R(rot) · S(sx, sy) · 局部坐标 + (ax, ay)
 *
 * 为什么要拆成一个函数而不是直接写进样式？
 *   因为命中判定要用【同一组数】反解。如果样式和判定各算各的
 *   （比如样式用 CSS 的百分比、判定用另一套算式），两边迟早对不上，
 *   表现就是「看着点中了但没反应」。让它们共用一份数据，
 *   这种偏差在结构上就不可能发生。
 */
function computeTransform(layout, s) {
  const t = s.time;

  // --- 呼吸：整体微微放大缩小 ---
  const breathPhase = 2 * Math.PI * t / (ANIM.breath ? ANIM.breath.period : 2.6);
  const breath = Math.sin(breathPhase);
  const breathY = 1 + (ANIM.breath ? ANIM.breath.amplitudeY : 0.022) * breath;
  const breathX = 1 + (ANIM.breath ? ANIM.breath.amplitudeX : 0.01) * breath;

  // --- 摇摆：左右轻轻侧倾 ---
  const swayPhase = 2 * Math.PI * t / (ANIM.sway ? ANIM.sway.period : 4.1);
  const rotDeg = (ANIM.sway ? ANIM.sway.amplitude : 1.6) * Math.sin(swayPhase);

  // --- 浮动：整体上下飘 ---
  const floatPhase = 2 * Math.PI * t / (ANIM.float ? ANIM.float.period : 3.3);
  const floatAmp = ANIM.float ? ANIM.float.amplitude : 0.012;
  const floatY = -floatAmp * layout.H * Math.sin(floatPhase);   // 负 = 向上

  // --- 点击反应：压扁 + 跳 ---
  const sq = s.squash;             // 0..1
  const jp = s.jump;               // 0..1
  const squashY = 1 - (REACT.squashYFactor || 0.35) * sq;
  const squashX = 1 + (REACT.squashXFactor || 0.25) * sq;
  const jumpY = -(REACT.jumpLift || 0.5) * layout.H * jp;

  // --- 心情：越高兴飘得越高 ---
  const moodY = -(REACT.moodLift || 0.06) * layout.H * s.mood;

  return {
    ax: layout.ax,
    ay: layout.ay + floatY + jumpY + moodY,
    rot: rotDeg,
    rotRad: rotDeg * DEG,
    sx: breathX * squashX,
    sy: breathY * squashY,
  };
}

/**
 * 屏幕坐标 -> 立绘局部坐标。
 *
 * 就是把正向式子反着走一遍：
 *     p = S⁻¹ · R⁻¹ · (s - A)
 */
function screenToLocal(tf, sx, sy) {
  const dx = sx - tf.ax;
  const dy = sy - tf.ay;
  const c = Math.cos(-tf.rotRad);
  const sn = Math.sin(-tf.rotRad);
  // R(-θ) · (dx, dy)
  const rx = dx * c - dy * sn;
  const ry = dx * sn + dy * c;
  // S⁻¹
  return { x: rx / tf.sx, y: ry / tf.sy };
}

/** 局部坐标是否落在立绘的矩形内（外扩 pad）。 */
function insideBox(p, layout, padRatio) {
  const pad = (padRatio || 0) * layout.W;
  return (
    p.x >= -layout.W / 2 - pad &&
    p.x <= layout.W / 2 + pad &&
    p.y >= -layout.H - pad &&
    p.y <= 0 + pad
  );
}

/** 局部坐标归一化为 u∈[0,1] 横向、v∈[0,1] 纵向（v 从图片顶部往下量）。 */
function localToUV(p, layout) {
  return {
    u: (p.x + layout.W / 2) / layout.W,
    // 局部 y=0 是脚底，图片 v=1 也是底部，所以是 1 + y/H
    v: 1 + p.y / layout.H,
  };
}

/** 从烘焙好的遮罩里取一格。越界一律算「不命中」。 */
function sampleMask(mask, u, v) {
  if (!mask || !mask.ok) return null;
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const mx = clamp(Math.floor(u * mask.w), 0, mask.w - 1);
  const my = clamp(Math.floor(v * mask.h), 0, mask.h - 1);
  return mask.bits[my * mask.w + mx] ? 1 : 0;
}

/**
 * 局部坐标是否落在矢量小人的轮廓里（若干个形状的并集）。
 *
 * pad 是外扩量（归一化单位，相对立绘宽度），调用方传 CFG.hit.padding。
 * ★ 判定和「遮罩可视化」必须共用这一个函数 —— 别各写一份。
 *   以前 drawHitMask() 自己抄了一遍椭圆循环，两份代码一旦漂移，
 *   你看到的红区就不再是真正生效的范围，那个调试工具也就没意义了。
 */
function insideVector(p, layout, shapes, pad) {
  const u = (p.x + layout.W / 2) / layout.W;
  const v = 1 + p.y / layout.H;
  const e = pad || 0;
  for (const s of shapes) {
    if (s.kind === 'rect') {
      if (u >= s.x0 - e && u <= s.x1 + e && v >= s.y0 - e && v <= s.y1 + e) {
        return true;
      }
    } else {
      const dx = (u - s.cx) / (s.rx + e);
      const dy = (v - s.cy) / (s.ry + e);
      if (dx * dx + dy * dy <= 1) return true;
    }
  }
  return false;
}

// ============================================================
// 三、状态
// ============================================================
const state = {
  time: 0,            // 累计秒数，动画全靠它
  frames: 0,          // 渲染帧数（测试用它来「等帧」而不是「等毫秒」）
  mood: 0,            // 心情 0..1
  squash: 0,          // 压扁冲量 0..1
  jump: 0,            // 跳跃冲量 0..1
  lastMouse: { x: -9999, y: -9999 },
  isCurrentlyHit: false,
  lastSentHit: null,  // 上一次发给主进程的值（避免每帧都刷 IPC）
  mode: 'vector',     // 'vector' | 'sprite'
  expression: 'idle', // 想显示的表情（与素材无关）
  spriteState: 'idle',// 实际用到的贴图（贴图模式才有效）
  spriteAspect: 200 / 300,
  mask: { ok: false, w: 0, h: 0, bits: null },
  hudVisible: true,
};

// 立绘在各模式下的宽高比。素材加载完会改写它。
let vectorAspect = 200 / 300;

function layoutNow() {
  const aspect = state.mode === 'sprite' ? state.spriteAspect : vectorAspect;
  return computeLayout(window.innerWidth, window.innerHeight, aspect);
}

function transformNow() {
  return computeTransform(layoutNow(), state);
}

// ============================================================
// 四、矢量小人 —— 没有贴图时的占位形象
//
// ★ 它虽然是「占位」，但能力比贴图模式更强：
//   眼睛和嘴是真的 SVG 元素，所以高兴时换眼型／嘴型都不用换图。
//
// 画在 200x300 的 viewBox 里，原点在左上角。
// 下面那些坐标就是照这个画布量的 —— 改比例时按这个尺度改。
// ============================================================
const VB = { w: 200, h: 300 };

// ------------------------------------------------------------
// ★ 几何表 —— 绘制和命中判定【共用同一份数字】
//
// 这一版是照着动画官方人设图（refs/azusa_official_chara08_front.png）
// 重画的 Q 版中野梓。从人设图量出来的比例（原图全身 840px）：
//   头（发顶到下巴）20.5% ｜ 外套下摆 53% ｜ 裙摆 60% ｜ 袜口 79% ｜ 鞋 94%
// Q 版的做法是【把头放大、其余按同一比例压下来】，所以下面这些 y 值
// 基本就是按上面那串百分比分配出来的。
//
// ★★ 为什么写成一张表，而不是像上一版把坐标散在绘制代码里？
//   因为踩过一次，代价不小：身体画的是矩形和梯形，命中判定却【全用椭圆】，
//   而椭圆在矩形的四个角上天然覆盖不到 —— 结果肩膀、胳膊外侧、裙摆两角
//   点下去直接穿到桌面。最要命的是【所有数值断言都是绿的】，
//   因为「漏掉一块」和「判定贴合轮廓」在数字上长得一模一样。
//   最后是靠打开 debug.showHitMask 把遮罩画出来、和立绘逐像素比才发现的。
//
//   现在两边从同一个数字出发，结构上就不可能对不上。
//   ⚠️ 改这里的数字 = 同时改绘制和判定，两边永远同步。
//      冒烟测试里「命中区域要盖住立绘 ≥97%」「命中面积不超过立绘 1.8 倍」
//      两条断言在守这件事 —— 改歪了会红，别把它当摆设。
// ------------------------------------------------------------
const VEC = {
  // 头的判定范围要比脸大一圈 —— 头发体积、鬓发都在里面。
  // ★ ry 取 72（不是 62）是为了把鬓发【上端到中段】一起包进来：
  //   鬓发垂到 y≈156，比下巴低不少，头这一块不够高就会漏掉。
  head:  { cx: 100, cy: 88,  rx: 58, ry: 72 },   // y 16..160, x 42..158
  // 猫耳画的是三角形、而且带 earAngle 旋转，判定用椭圆兜住。
  // ★ 这两个数不能贴着三角形写：rotate(-28°) 之后顶点会甩到
  //   (51.9,3.5) / (97.5,38.2) 这种地方，贴着写就会漏掉耳尖。
  earL:  { cx: 66,  cy: 30,  rx: 30, ry: 32 },
  earR:  { cx: 134, cy: 30,  rx: 30, ry: 32 },
  // 双马尾垂下来的那条带。
  // ★ 这一版【收窄并往外挪】了：原来 26..74 太宽，把胳膊整个盖住，
  //   而袖子又是深蓝的、和头发几乎同色 —— 结果两只胳膊直接「消失」。
  tailL: { x0: 22, y0: 62,  x1: 58,  y1: 258 },
  tailR: { x0: 142, y0: 62, x1: 178, y1: 258 },
  torso: { x0: 50, y0: 136, x1: 150, y1: 204 },  // 西装外套
  // 袖子只比外套宽一丁点，手包在同一个矩形里
  armL:  { x0: 48, y0: 140, x1: 72,  y1: 222 },  // 袖子 + 手
  armR:  { x0: 128, y0: 140, x1: 152, y1: 222 },
  skirt: { x0: 46, y0: 196, x1: 154, y1: 224 },  // 百褶裙
  legL:  { x0: 80, y0: 216, x1: 99,  y1: 260 },  // 腿（裸腿段）
  legR:  { x0: 101, y0: 216, x1: 120, y1: 260 },
  sockL: { x0: 78, y0: 250, x1: 101, y1: 290 },  // 及膝袜
  sockR: { x0: 99, y0: 250, x1: 122, y1: 290 },
  shoeL: { cx: 88,  cy: 291, rx: 18, ry: 9 },    // 鞋
  shoeR: { cx: 112, cy: 291, rx: 18, ry: 9 },
};

// 眼睛的数字。表情系统（笑脸）和绘制共用这一份。
//
// ★ hw / hh 是按官方人设图的比例算出来的，不是随手给的：
//   人设图上「眼宽 / 脸宽 = 0.31」「眼高 / 头高 = 0.19」，
//   套到这里的脸宽 74、头高 107 上，得到 23 x 20 ——
//   再乘一点点（Q 版会特意把眼睛放大一档）就是 24 x 21。
//   第一版给成 30 x 26 并配了 r=13 的虹膜，画出来是「两个大黑饼」，
//   因为虹膜几乎把眼白占光了。现在虹膜缩到 10，两侧才留得出眼白。
const EYE = {
  l: { cx: 78,  cy: 98, r: 10, hw: 12, hh: 10.5 },
  r: { cx: 122, cy: 98, r: 10, hw: 12, hh: 10.5 },
};

const uu = (x) => x / VB.w;
const vv = (y) => y / VB.h;
const rectShape = (r) =>
  ({ kind: 'rect', x0: uu(r.x0), y0: vv(r.y0), x1: uu(r.x1), y1: vv(r.y1) });
const ellipseShape = (e) =>
  ({ kind: 'ellipse', cx: uu(e.cx), cy: vv(e.cy), rx: uu(e.rx), ry: vv(e.ry) });

// ------------------------------------------------------------
// 两个开关：绘制和判定都从这里取，免得两边漂了
// ------------------------------------------------------------

// 猫耳。默认关（先做正常版）。关掉之后判定也不该再算「头顶那两个角」——
// 不然点头顶的空气也有反应，手感很怪。
const CAT_EARS = !!(CFG.vector && CFG.vector.catEars);

// 头身比 → 相对基准值的缩放倍数。
//
// ★ 这个参数以前是个【死参数】：config/index.js 会校验它，
//   desktop/README.md 还写着「调到 0.16 就变成写实比例」，
//   但渲染层根本没人读它 —— 用户改了完全没反应。
//   属于这个项目最想避免的那一类坑，现在真的接上了：
//   头的所有部件（含头发、猫耳、五官）统一【绕下巴】缩放，
//   所以调大调小只是「头变大变小」，脖子和身体一动不动。
const HEAD_BASE_RATIO = 0.38;   // 几何表就是按这个比例画的，等于 1 倍
const CHIN_Y = 133;             // 绕这个点缩放，下巴才不会跑
const headK = Math.max(0.4, Math.min(2.2,
  ((CFG.vector && CFG.vector.headHeightRatio) || HEAD_BASE_RATIO) / HEAD_BASE_RATIO));

// 头的判定形状要跟着一起缩放，否则头变大了会觉得「点脸没反应」
const headShape = (e) => ellipseShape({
  cx: e.cx,
  cy: CHIN_Y + (e.cy - CHIN_Y) * headK,
  rx: e.rx * headK,
  ry: e.ry * headK,
});

// 判定形状由上面那张表生成
const VECTOR_HIT_SHAPES = [
  headShape(VEC.head),
  ...(CAT_EARS ? [headShape(VEC.earL), headShape(VEC.earR)] : []),
  rectShape(VEC.tailL),
  rectShape(VEC.tailR),
  rectShape(VEC.torso),
  rectShape(VEC.armL),
  rectShape(VEC.armR),
  rectShape(VEC.skirt),
  rectShape(VEC.legL),
  rectShape(VEC.legR),
  rectShape(VEC.sockL),
  rectShape(VEC.sockR),
  ellipseShape(VEC.shoeL),
  ellipseShape(VEC.shoeR),
];

function buildVector() {
  const c = (CFG.vector && CFG.vector.colors) || {};
  const V = CFG.vector || {};
  const earA = V.earAngle || 0;

  const hair = css(c.hair, 1);
  const hairShine = css(c.hairShine, 1);
  const skin = css(c.skin, 1);
  const collar = css(c.collar, 1);
  const cloth = css(c.cloth, 1);
  const button = css(c.button, 1);
  const skirt = css(c.skirt, 1);
  const sock = css(c.sock, 1);
  const shoe = css(c.shoe, 1);
  const accent = css(c.accent, 1);
  const blush = css(c.blush, 1);
  const eyeDark = css(c.eye, 1);
  const iris = css(c.iris, 1);
  const irisLow = css(c.irisLow, 1);
  const eyeWhite = css(c.eyeWhite, 1);
  const shine = css(c.eyeShine, 1);
  const earColor = css(V.earColor || c.hair, 1);
  const earInner = css(V.earInnerColor || c.skin, 1);

  // 细节的明暗不再多开一个颜色参数，直接叠一层半透明的黑／白。
  // 好处：用户把外套改成米色时，褶子、口袋、袖缝会跟着一起对，
  // 不用再去单独调一个「外套的暗部」色。
  const SHADE = 'rgba(0,0,0,0.20)';
  const SHADE_SOFT = 'rgba(0,0,0,0.12)';
  const LIGHT = 'rgba(255,255,255,0.16)';

  // 猫耳朝外张开一点。用 rotate 而不是手算坐标，
  // 这样 earAngle 是个能直接改的参数，不用重画路径。
  const ear = (x, cy, dir) =>
    `<g transform="rotate(${dir * earA} ${x} ${cy})">` +
    `<path d="M${x - 24} ${cy + 22} L${x} ${cy - 30} L${x + 24} ${cy + 22} Z" fill="${earColor}"/>` +
    `<path d="M${x - 11} ${cy + 16} L${x} ${cy - 11} L${x + 11} ${cy + 16} Z" fill="${earInner}" opacity="0.5"/>` +
    `</g>`;

  // ----------------------------------------------------------
  // 眼睛 —— 一只眼睛是五样东西叠出来的，不是一个椭圆
  //
  // 结构是照官方人设图放大 8 倍看着画的：
  //   ① 眼白　② 近黑的虹膜（几乎填满）　③ 虹膜下半的茶红色
  //   ④ 一块高光（光从左上来，所以两只眼睛的高光都在左上）
  //   ⑤ 加粗的上眼睑线，外眼角再多一块（少了它就不像动画脸）
  // 虹膜用 clipPath 裁进眼白里，这样它不会漏到眼睛外面。
  //
  // 所有尺寸都从 EYE 的 hw / hh / r 推出来，不写第二份魔数 ——
  // 想把眼睛调大调小，只改 EYE 就行。
  // ----------------------------------------------------------
  const E = EYE;
  const eyePath = (cx, cy, hw, hh) =>
    `M${cx - hw} ${cy}` +
    `C${cx - hw + 1} ${cy - hh + 1} ${cx - hw * 0.45} ${cy - hh} ${cx} ${cy - hh}` +
    `C${cx + hw * 0.55} ${cy - hh} ${cx + hw} ${cy - hh * 0.6} ${cx + hw} ${cy}` +
    `C${cx + hw} ${cy + hh * 0.6} ${cx + hw * 0.55} ${cy + hh} ${cx} ${cy + hh}` +
    `C${cx - hw * 0.45} ${cy + hh} ${cx - hw + 1} ${cy + hh - 1} ${cx - hw} ${cy}Z`;
  // 外眼角加粗的那一块。dir=-1 表示外眼角在左（左眼），+1 在右。
  const lashWedge = (cx, cy, hw, hh, dir) => {
    const X = (d) => cx + dir * d;
    return `M${X(hw)} ${cy + hh * 0.3}
            C${X(hw * 0.95)} ${cy - hh * 0.6} ${X(hw * 0.6)} ${cy - hh} ${X(hw * 0.15)} ${cy - hh - 1}
            L${X(hw * 0.1)} ${cy - hh * 0.65}
            C${X(hw * 0.45)} ${cy - hh * 0.6} ${X(hw * 0.75)} ${cy - hh * 0.25} ${X(hw * 0.75)} ${cy + hh * 0.35}Z`;
  };
  const eye = (cx, cy, hw, hh, dir, side) => `
        <g id="v-eye-${side}">
          <path d="${eyePath(cx, cy, hw, hh)}" fill="${eyeWhite}"/>
          <g clip-path="url(#v-clip-${side})">
            <circle cx="${cx}" cy="${cy + 1}" r="${E[side].r}" fill="${iris}"/>
            <!-- 虹膜下半的茶红：从虹膜中线往下铺，再裁进虹膜那个圆里 -->
            <g clip-path="url(#v-iris-${side})">
              <rect x="${cx - hw}" y="${cy + 1}" width="${hw * 2}"
                    height="${E[side].r}" fill="${irisLow}"/>
            </g>
            <!-- 高光压小了。原来给它虹膜的三分之一，
                 在桌宠这个尺寸下像一个贴上去的白点，不像眼睛自己反出来的光 -->
            <ellipse id="v-shine-${side}" cx="${cx - hw * 0.42}" cy="${cy - hh * 0.45}"
                     rx="${(hw * 0.26).toFixed(2)}" ry="${(hh * 0.28).toFixed(2)}"
                     fill="${shine}"/>
            <!-- 下面再点一个小高光，人设图上也有，加了眼神才活 -->
            <circle cx="${cx + hw * 0.3}" cy="${cy + hh * 0.45}"
                    r="${(hh * 0.13).toFixed(2)}" fill="${shine}" opacity="0.75"/>
          </g>
          <path d="M${cx - hw + 1} ${cy + 1}
                   C${cx - hw + 2} ${cy - hh * 0.85} ${cx - hw * 0.5} ${cy - hh + 1} ${cx} ${cy - hh + 1}
                   C${cx + hw * 0.5} ${cy - hh + 1} ${cx + hw - 1} ${cy - hh * 0.75} ${cx + hw - 1} ${cy + 1}"
                fill="none" stroke="${eyeDark}" stroke-width="${(hh * 0.32).toFixed(2)}"
                stroke-linecap="round"/>
          <path d="${lashWedge(cx, cy, hw, hh, dir)}" fill="${eyeDark}"/>
          <path d="M${cx - hw * 0.65} ${cy + hh * 0.95}
                   C${cx - hw * 0.15} ${cy + hh + 1} ${cx + hw * 0.42} ${cy + hh * 0.95} ${cx + hw * 0.88} ${cy + hh * 0.65}"
                fill="none" stroke="${eyeDark}" stroke-width="1.6"
                stroke-linecap="round" opacity="0.55"/>
        </g>`;

  // 头的整体缩放（headHeightRatio）。正好 1 倍时不写 transform，
  // 免得白套一层矩阵。
  const headTf = Math.abs(headK - 1) < 1e-4 ? ''
    : ` transform="translate(100 ${CHIN_Y}) scale(${headK.toFixed(4)})` +
      ` translate(-100 ${-CHIN_Y})"`;

  vectorEl.setAttribute('viewBox', `0 0 ${VB.w} ${VB.h}`);
  vectorEl.innerHTML = `
    <defs>
      <clipPath id="v-clip-l"><path d="${eyePath(E.l.cx, E.l.cy, E.l.hw, E.l.hh)}"/></clipPath>
      <clipPath id="v-clip-r"><path d="${eyePath(E.r.cx, E.r.cy, E.r.hw, E.r.hh)}"/></clipPath>
      <clipPath id="v-iris-l"><circle cx="${E.l.cx}" cy="${E.l.cy + 1}" r="${E.l.r}"/></clipPath>
      <clipPath id="v-iris-r"><circle cx="${E.r.cx}" cy="${E.r.cy + 1}" r="${E.r.r}"/></clipPath>
    </defs>

    <!-- ── 双马尾：在最后面，所以最先画 ──
         收窄到 24..56，给胳膊让出位置（见 VEC 里 tailL 的注释）。
         ★ 描一圈暗边：马尾、鬓发、后发是同一个颜色，不描边就糊成
           一整块深色，看过去像披了件斗篷，完全分不出哪是哪。 ── -->
    <path d="M48 78 C 30 108 24 160 26 206 C 27 228 30 244 36 256
             C 41 240 45 218 46 194 C 48 148 52 104 56 88 Z" fill="${hair}"
          stroke="rgba(0,0,0,0.32)" stroke-width="1.4"/>
    <path d="M152 78 C 170 108 176 160 174 206 C 173 228 170 244 164 256
             C 159 240 155 218 154 194 C 152 148 148 104 144 88 Z" fill="${hair}"
          stroke="rgba(0,0,0,0.32)" stroke-width="1.4"/>
    <!-- 马尾上的两道发丝线。深色头发在这个尺寸下就是一块色，
         加两条线立刻能看出「这是一束头发」而不是一块布。 -->
    <path d="M45 100 C 35 142 31 190 33 236" fill="none"
          stroke="${hairShine}" stroke-width="2" opacity="0.45"/>
    <path d="M155 100 C 165 142 169 190 167 236" fill="none"
          stroke="${hairShine}" stroke-width="2" opacity="0.45"/>

    <!-- ── 后发：头后面的头发体积 ── -->
    <path d="M100 26 C 67 26 46 54 46 100 C 46 130 48 150 52 166
             C 60 160 66 148 68 134 L 132 134
             C 134 148 140 160 148 166 C 152 150 154 130 154 100
             C 154 54 133 26 100 26 Z" fill="${hair}"/>

    <!-- ── 脖子（会被头和领子各压掉一部分，只露出一小段）── -->
    <rect x="90" y="118" width="20" height="30" fill="${skin}"/>

    <!-- ── 衬衫领：先画，外套的 V 形开口会把它露出来 ── -->
    <path d="M88 122 L 74 134 L 78 164 L 100 172 L 122 164 L 126 134 L 112 122
             L 108 142 L 92 142 Z" fill="${collar}"/>

    <!-- ── 西装外套：正面开了个 V 形口，领结从那里露出来 ── -->
    <path d="M100 138 L 78 146 C 66 151 58 162 58 178 L 58 202 L 142 202
             L 142 178 C 142 162 134 151 122 146
             L 116 156 L 100 163 L 84 156 Z" fill="${cloth}"/>
    <path d="M70 152 C 64 168 62 186 62 202" fill="none"
          stroke="${SHADE_SOFT}" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M130 152 C 136 168 138 186 138 202" fill="none"
          stroke="${SHADE_SOFT}" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M68 184 L 86 184" fill="none" stroke="${SHADE}"
          stroke-width="2.2" stroke-linecap="round"/>
    <path d="M114 184 L 132 184" fill="none" stroke="${SHADE}"
          stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="100" cy="172" r="3" fill="${button}"/>
    <circle cx="100" cy="183" r="3" fill="${button}"/>
    <circle cx="100" cy="194" r="3" fill="${button}"/>

    <!-- ── 领结：两片向上翘的环 + 中间的结 + 两条垂下来的缎带 ── -->
    <path d="M100 153 L 83 143 L 81 162 L 100 158 Z" fill="${accent}"/>
    <path d="M100 153 L 117 143 L 119 162 L 100 158 Z" fill="${accent}"/>
    <path d="M99 157 L 89 176 L 96 173 L 100 161 Z" fill="${accent}"/>
    <path d="M101 157 L 111 176 L 104 173 L 100 161 Z" fill="${accent}"/>
    <rect x="94" y="150" width="12" height="10" rx="3.5" fill="${accent}"/>
    <rect x="94" y="150" width="12" height="10" rx="3.5" fill="${SHADE}"/>

    <!-- ── 百褶裙 ── -->
    <path d="M60 198 L 140 198 L 150 222 L 50 222 Z" fill="${skirt}"/>
    <g stroke="rgba(0,0,0,0.16)" stroke-width="1.3" fill="none">
      <path d="M72 200 L 66 220"/>
      <path d="M86 200 L 83 222"/>
      <path d="M100 200 L 100 222"/>
      <path d="M114 200 L 117 222"/>
      <path d="M128 200 L 134 220"/>
    </g>
    <path d="M50 222 L 150 222" fill="none" stroke="${SHADE}" stroke-width="1.6"/>

    <!-- ── 胳膊（西装袖）+ 手
         ★ 必须画在裙子【之后】。原来画在裙子前面，
           而手的位置（y 202~218）正好落在裙子的范围（198~222）里，
           于是两只手被裙子整个盖掉了 —— 图上完全看不到手。── -->
    <rect x="50" y="148" width="20" height="58" rx="10" fill="${cloth}"/>
    <rect x="130" y="148" width="20" height="58" rx="10" fill="${cloth}"/>
    <path d="M54 196 L 66 196" fill="none" stroke="${SHADE}"
          stroke-width="1.8" stroke-linecap="round"/>
    <path d="M134 196 L 146 196" fill="none" stroke="${SHADE}"
          stroke-width="1.8" stroke-linecap="round"/>
    <circle cx="60" cy="210" r="8" fill="${skin}"/>
    <circle cx="140" cy="210" r="8" fill="${skin}"/>

    <!-- ── 腿 ── -->
    <rect x="83" y="216" width="15" height="44" rx="7" fill="${skin}"/>
    <rect x="102" y="216" width="15" height="44" rx="7" fill="${skin}"/>

    <!-- ── 及膝袜 ── -->
    <rect x="80" y="252" width="19" height="38" rx="6" fill="${sock}"/>
    <rect x="101" y="252" width="19" height="38" rx="6" fill="${sock}"/>

    <!-- ── 鞋 ── -->
    <ellipse cx="88" cy="291" rx="18" ry="8.5" fill="${shoe}"/>
    <ellipse cx="112" cy="291" rx="18" ry="8.5" fill="${shoe}"/>
    <path d="M75 288 C 81 285 95 285 101 288" fill="none"
          stroke="${LIGHT}" stroke-width="2" stroke-linecap="round"/>
    <path d="M99 288 C 105 285 119 285 125 288" fill="none"
          stroke="${LIGHT}" stroke-width="2" stroke-linecap="round"/>

    <!-- ══ 头：头发和五官全在这一组里，整体绕下巴缩放 ══ -->
    <g id="v-head"${headTf}>
      ${CAT_EARS ? ear(66, 32, -1) + ear(134, 32, 1) : ''}

      <!-- 脸：下巴收窄的鹅蛋形（不是纯椭圆） -->
      <path d="M100 133
               C 86 133 68 120 63 98
               C 58 70 74 42 100 42
               C 126 42 142 70 137 98
               C 132 120 114 133 100 133 Z" fill="${skin}"/>

      <!-- 刘海：外端垂到太阳穴，中间几缕带尖。
           尖到底停在 y≈86（眼睛上沿是 87.5），正好轻轻压到眼睛上沿 ——
           压太多眼睛就被吃掉了，一点不压又不像动画。 -->
      <path d="M46 104
               C 40 60 68 26 100 26
               C 132 26 160 60 154 104
               C 148 90 144 80 138 70
               L 128 86 L 120 68 L 106 88 L 100 70 L 94 88 L 80 68
               L 70 86 C 62 80 52 88 46 104 Z" fill="${hair}"/>

      <!-- 两侧鬓发：从太阳穴垂到胸口就收（y≈156）。
          原来垂到 192，正好压在胳膊上，胳膊又被同色的双马尾遮着，
          结果整条胳膊都看不见了。 -->
      <path d="M48 70 C 43 100 45 128 52 156 C 58 136 62 112 63 92
               C 64 82 60 74 55 68 Z" fill="${hair}"
            stroke="rgba(0,0,0,0.28)" stroke-width="1.3"/>
      <path d="M152 70 C 157 100 155 128 148 156 C 142 136 138 112 137 92
               C 136 82 140 74 145 68 Z" fill="${hair}"
            stroke="rgba(0,0,0,0.28)" stroke-width="1.3"/>

      <!-- ★ 头发高光必须画在刘海【之后】。
           原来这条高光写在刘海前面，被刘海整块盖住 —— 等于白写，
           而少了它整个头就是一块深色，完全看不出是头发。
           顺序错了不会报错，只会「看起来不对」，所以这条要留着。 -->
      <path d="M60 74 C 68 48 86 35 110 35 C 90 42 74 55 69 76 Z"
            fill="${hairShine}" opacity="0.55"/>
      <path d="M112 38 C 126 43 138 55 143 72 C 138 57 126 45 112 41 Z"
            fill="${hairShine}" opacity="0.32"/>
      <!-- 两缕发丝的暗线，让刘海不是一块平色 -->
      <path d="M84 40 C 88 58 93 74 97 88" fill="none"
            stroke="rgba(0,0,0,0.22)" stroke-width="1.5"/>
      <path d="M118 40 C 114 58 109 74 105 88" fill="none"
            stroke="rgba(0,0,0,0.22)" stroke-width="1.5"/>
      <!-- 脸和鬓发之间压一条暗边，这样鬓发不会和脸糊在一起 -->
      <path d="M64 66 C 62 100 64 130 70 152" fill="none"
            stroke="rgba(0,0,0,0.18)" stroke-width="2"/>
      <path d="M136 66 C 138 100 136 130 130 152" fill="none"
            stroke="rgba(0,0,0,0.18)" stroke-width="2"/>

      <!-- 眉毛：画在刘海【之后】，所以会压在头发上。
           这不是画错了 —— 动画里眉毛透出刘海本来就是常规画法，
           人设图上也是这样。 -->
      <path d="M66 84 C 71 79 82 78 89 81" fill="none" stroke="${eyeDark}"
            stroke-width="2" stroke-linecap="round" opacity="0.8"/>
      <path d="M134 84 C 129 79 118 78 111 81" fill="none" stroke="${eyeDark}"
            stroke-width="2" stroke-linecap="round" opacity="0.8"/>

      <!-- 眼睛 -->
      <g id="v-eyes-open">
        ${eye(E.l.cx, E.l.cy, E.l.hw, E.l.hh, -1, 'l')}
        ${eye(E.r.cx, E.r.cy, E.r.hw, E.r.hh, 1, 'r')}
      </g>

      <!-- 开心时换成弯眼睛 ^ ^ -->
      <g id="v-eyes-happy" style="display:none">
        <path d="M66 101 C 71 90 85 90 90 101" fill="none" stroke="${eyeDark}"
              stroke-width="4" stroke-linecap="round"/>
        <path d="M134 101 C 129 90 115 90 110 101" fill="none" stroke="${eyeDark}"
              stroke-width="4" stroke-linecap="round"/>
      </g>

      <!-- 鼻子：一个小点就够，画多了反而脏 -->
      <circle cx="100" cy="115" r="1.2" fill="${eyeDark}" opacity="0.6"/>

      <!-- 嘴 -->
      <path id="v-mouth-idle" d="M96 123 C 98 127 102 127 104 123" fill="none"
            stroke="${eyeDark}" stroke-width="1.8" stroke-linecap="round"/>
      <path id="v-mouth-happy" style="display:none"
            d="M93 120 Q100 133 107 120 Q100 125 93 120 Z" fill="#b5445a"/>

      <!-- 脸颊红晕：人设图上是两道小斜线，不是一整块腮红 -->
      <g stroke="${blush}" stroke-width="1.8" stroke-linecap="round" fill="none">
        <path d="M72 113 L 77 117"/>
        <path d="M79 111 L 84 115"/>
        <path d="M128 113 L 123 117"/>
        <path d="M121 111 L 116 115"/>
      </g>
    </g>
  `;

  // ★ 眨眼已移除：矢量小人的眼睛不再压扁，也就不用给它们设缩放原点了。
}

/** 按 state 更新矢量小人的表情。 */
function updateVectorFace() {
  const eyesOpen = vectorEl.querySelector('#v-eyes-open');
  const eyesHappy = vectorEl.querySelector('#v-eyes-happy');
  const mouthIdle = vectorEl.querySelector('#v-mouth-idle');
  const mouthHappy = vectorEl.querySelector('#v-mouth-happy');
  if (!eyesOpen) return;

  const happy = state.expression === 'happy';
  eyesOpen.style.display = happy ? 'none' : '';
  eyesHappy.style.display = happy ? '' : 'none';
  mouthIdle.style.display = happy ? 'none' : '';
  mouthHappy.style.display = happy ? '' : 'none';

  // ★ 眨眼已移除：矢量小人的眼睛不再压扁，画成什么样就什么样。
}

// ============================================================
// 五、贴图模式
//
// 一套 = 一个目录里的若干张图（idle 必须有，happy / surprise 可选）。
// 加载失败不影响启动 —— 会一直留在矢量小人上，并记一条状态。
//
// ------------------------------------------------------------
// ★★ 换装（本次新增）
//
// 「一套」= 一个目录，里面有 4 张表情 + 1 个 mask.json。
// 点一下桌宠就在所有套之间随机跳一套（不重复）。
//
// 这里有两个容易踩的点，写在最前面：
//
//   ① 【遮罩必须跟着套一起换】。不同服装的轮廓宽高比不一样
//      （冬制服 542 宽，粉卫衣 467 宽，同样是 719 高），
//      用 A 套的遮罩去判 B 套的命中，点起来就会「歪一边」。
//      所以换套时贴图和遮罩是绑在一起换的，缺一不可。
//
//   ② 【宽高比也要跟着换】。立绘高度由 heightRatio × 窗口高 决定，
//      宽度 = 高 × 素材宽高比。所以换套时 layout 会变 ——
//      这是对的，因为换的是「一个人穿不同衣服」，
//      她的横向占位本来就不同。前提是素材已经按「脚底 + 水平中线」
//      对齐过（tools/make-sprite.py 干的），否则会左右跳。
// ============================================================
const spriteImages = { idle: null, happy: null, surprise: null };
let spriteLoadNote = '未启用';

// ------------------------------------------------------------
// 当前套：dir 是绝对（相对 src/）的目录路径，name 只给日志和调试看
// ------------------------------------------------------------
let currentOutfit = { name: '', dir: (CFG.sprite && CFG.sprite.dir) || '../assets/sprites' };

// ------------------------------------------------------------
// ★ 换装牌堆 —— 「随机不重复」的实现
//
// 为什么不用 Math.random() 直接抽？
//   因为纯随机会「连着两次抽到同一套」——
//   用户点一下看到没变，会以为程序坏了。而且小列表里这种概率不低
//   （5 套的话，连抽两次相同的概率是 20%）。
//
// 做法是【洗牌发牌】：把列表洗一遍按顺序发，发完了再洗一遍。
//   · 一轮之内每套都会出现恰好一次 —— 一定不会连着重复
//   · 每轮的顺序都不同 —— 感觉上是随机的
//   · 唯一「不随机」的地方是「轮与轮的交界」：
//     上一轮最后一张和下一轮第一张理论上可能相同。
//     这个概率是 1/n，比纯随机的 1/n 小得多（那是每步都 1/n），
//     真碰上了也不会难受 —— 毕竟是一整轮才遇到一次。
// ------------------------------------------------------------
let outfitDeck = [];
let outfitRound = 0;        // 第几轮（每次重洗发牌 +1）。测试用来按轮验「不重复」
let outfitPool = [];        // 所有可换的套（名字），启动时从 CFG 读
let outfitHistory = [];     // 每次成功换装记一条 {name, round}，供测试按轮校验

function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/** 从牌堆里抽下一套。牌堆空了就重洗（并尽量避开刚看过的那套）。 */
function drawOutfit() {
  if (outfitPool.length === 0) return null;

  // 牌堆空 -> 重洗
  if (outfitDeck.length === 0) {
    outfitDeck = outfitPool.slice();
    shuffleInPlace(outfitDeck);
    outfitRound++;      // ★ 记轮次：测试要按「轮」验「一轮内不重复」
    // ★ 轮与轮交界处：如果重洗后第一张正好是当前这套，
    //   和最后一张换一下，保证「点下去一定看得出变化」。
    if (outfitDeck.length > 1 && outfitDeck[0] === currentOutfit.name) {
      const t = outfitDeck[0];
      outfitDeck[0] = outfitDeck[outfitDeck.length - 1];
      outfitDeck[outfitDeck.length - 1] = t;
    }
  }

  // 从前面发牌；万一抽到的就是当前这套（单套时会出现），也照常返回
  const name = outfitDeck.shift();
  return name;
}

/** 把套名变成相对 src/ 的目录路径。 */
function outfitDir(name) {
  const root = (CFG.sprite && CFG.sprite.root) || '../assets/sprites';
  return `${root}/${name}`;
}

function spriteURL(name, dirOverride) {
  const files = (CFG.sprite && CFG.sprite.files) || {};
  const file = files[name];
  if (!file) return null;
  const dir = dirOverride || currentOutfit.dir;
  return `${dir}/${file}?v=${encodeURIComponent(dir + '/' + file)}`;
}

function loadOne(name, dirOverride) {
  return new Promise((resolve) => {
    const url = spriteURL(name, dirOverride);
    if (!url) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * 加载一套的四张表情。
 *
 * ★ 返回一组【新】的图片对象，不直接写进 spriteImages。
 *   为什么？因为要「全部加载成功之后才换」——
 *   如果边加载边替换，会在切换的中途出现
 *   「idle 已经是新套、happy 还是旧套」的混合状态，
 *   正好这时候用户又点一下就会用到旧图。
 *   所以先在旁边加载好，成功了再一次性换上去（原子替换）。
 */
async function loadOutfit(name) {
  const dir = outfitDir(name);
  const [idle, happy, surprise] = await Promise.all([
    loadOne('idle', dir), loadOne('happy', dir), loadOne('surprise', dir),
  ]);
  if (!idle) return null;                    // 没有 idle = 这套不能用
  return { name, dir, imgs: { idle, happy, surprise } };
}

/** 读一套的遮罩。读不到返回 null（退回矩形判定，不影响运行）。 */
async function loadMaskFor(dir) {
  const file = (CFG.sprite && CFG.sprite.maskFile) || 'mask.json';
  try {
    const res = await fetch(`${dir}/${file}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const bits = decodeBits(data.bits, data.w * data.h);
    if (!bits) throw new Error('位图解码失败');
    return { ok: true, w: data.w, h: data.h, bits };
  } catch (err) {
    return { ok: false, w: 0, h: 0, bits: null, error: String(err && err.message) };
  }
}

/** 把一套的图 + 遮罩原子地切上去。 */
function applyOutfit(o, mask) {
  spriteImages.idle = o.imgs.idle;
  spriteImages.happy = o.imgs.happy;
  spriteImages.surprise = o.imgs.surprise;
  currentOutfit = { name: o.name, dir: o.dir };
  state.mask = mask || { ok: false, w: 0, h: 0, bits: null };

  // ★ 宽高比跟着这套走。下一帧 render() 会用新比例重算 layout。
  state.spriteAspect = o.imgs.idle.naturalWidth / o.imgs.idle.naturalHeight;

  // ★ 表情状态也要重算 —— 换套后要按新套的素材重新决定。
  state.expression = '';         // 清掉缓存，强制 applyExpression 重跑
  state.spriteState = 'idle';
  applyExpression(chooseExpression());

  // ★★ 换装的「真正换图」就在这里 —— 贴图模式下 spriteEl.src 只有这一处会改。
  //    以前这行藏在 applyExpression 里，导致眨眼也会顺路换图；
  //    现在把「换图」和「换表情」彻底分开：
  //      换装 -> 改 src（就是这行）
  //      眨眼 -> 功能已删除，立绘上不再有任何覆盖层
  spriteEl.src = o.imgs.idle.src;

  // 换套可能改了宽高比 -> 重新摆位、重画遮罩
  initPlacementStyles();
  drawHitMask();

  // ★ 记一笔「这一轮发到哪一张了」。测试靠它验「一轮内每套只出现一次」——
  //   从外面按 pool.length 切窗口是数不准的（轮与轮的交界会误判）。
  outfitHistory.push({ name: o.name, round: outfitRound });
}

/**
 * 点一下 -> 换下一套。
 *
 * ★ 这里做了「并发保护」：切换过程要读 5 个文件，花几十毫秒。
 *   用户手快连点两下的话，两轮切换会互相覆盖 ——
 *   最后可能显示 A 套的图 + B 套的遮罩，点起来就歪了。
 *   所以用一个 switching 标志把并发的第二次点击挡在外面。
 */
let switching = false;

function switchToNextOutfit() {
  const sw = (CFG.sprite && CFG.sprite.outfitSwitch) || {};
  if (!(CFG.sprite && CFG.sprite.enabled)) return;
  if (sw.enabled === false) return;
  if (outfitPool.length < 2) return;      // 只有一套就没什么好换的
  if (switching) return;

  const name = drawOutfit();
  if (!name || name === currentOutfit.name) return;

  switching = true;
  (async () => {
    try {
      const o = await loadOutfit(name);
      if (!o) {
        spriteLoadNote = `换装失败：${name}（没有 idle.png）`;
        return;
      }
      const mask = await loadMaskFor(o.dir);
      applyOutfit(o, mask);
      spriteLoadNote = `已加载 ${name}（${o.imgs.idle.naturalWidth}x` +
        `${o.imgs.idle.naturalHeight}）`;
    } finally {
      switching = false;
    }
  })();
}

async function loadSprites() {
  if (!(CFG.sprite && CFG.sprite.enabled)) {
    spriteLoadNote = 'sprite.enabled = false，用矢量小人';
    return false;
  }

  // 换装列表：去重、去掉空项
  const list = Array.isArray(CFG.sprite.outfits) ? CFG.sprite.outfits : [];
  outfitPool = [];
  for (const n of list) {
    if (typeof n === 'string' && n && outfitPool.indexOf(n) < 0) outfitPool.push(n);
  }

  spriteLoadNote = '正在加载';

  // 先加载 dir 指向的那一套（它可能不在 outfits 里）
  const dirName = (CFG.sprite.dir || '').split('/').pop();
  const first = await loadOutfit(dirName);
  if (!first) {
    // 这里是「降级」而不是「报错」——
    // 一张素材都没有的时候程序照样要能跑、能点、能被拖。
    // 这和 3D 版加载不了模型就退回蓝色方块是同一个思路。
    spriteLoadNote = 'idle 贴图加载失败，已退回矢量小人';
    state.mode = 'vector';
    return false;
  }

  const mask = await loadMaskFor(first.dir);
  spriteImages.idle = first.imgs.idle;
  spriteImages.happy = first.imgs.happy;
  spriteImages.surprise = first.imgs.surprise;
  currentOutfit = { name: first.name, dir: first.dir };
  state.mask = mask;

  state.mode = 'sprite';
  state.spriteAspect = first.imgs.idle.naturalWidth / first.imgs.idle.naturalHeight;
  const sw = (CFG.sprite && CFG.sprite.outfitSwitch) || {};
  spriteLoadNote = `已加载（${first.imgs.idle.naturalWidth}x${first.imgs.idle.naturalHeight}）` +
    (first.imgs.happy ? ' +开心图' : '') + (first.imgs.surprise ? ' +惊讶图' : '') +
    (sw.enabled !== false && outfitPool.length >= 2
      ? ` ｜ 可换装 ${outfitPool.length} 套` : '');

  spriteEl.src = first.imgs.idle.src;

  // ★ 初始化牌堆：让「第一下点击」就能换到别的套。
  //   如果不处理，第一下可能抽到 dir 这一套（如果它也在 outfits 里），
  //   表现就是「第一下点了没反应」，很像是坏的。
  outfitDeck = [];
  return true;
}

/** 遮罩文件（命中判定用）。读不到就退回矩形判定。 */
async function loadMask() {
  state.mask = await loadMaskFor(currentOutfit.dir);
  return state.mask.ok;
}

/**
 * 位图解码：base64 -> 每像素 1 bit。
 *
 * 格式约定（必须和 tools/make-sprite.py 里的一致，两边是同一份规格）：
 *   · 位按【行优先】连续排列，第 i 位对应 (row = i / w, col = i % w)
 *   · ★ 每行【不】补齐到字节边界，是整张图连着排的。
 *     这点很容易搞错：很多位图格式每行会补 0 到整字节，
 *     如果这边按补齐来解、那边按连续来写，画面会整体斜掉，
 *     而且斜得不明显，特别难查。所以这里两个文件都写死了「不补齐」。
 *   · 字节内 MSB 优先：第 0 位是最高位
 *
 * 为什么用 base64 而不是「0101...」的字符串？
 *   64x96 的遮罩是 6144 位，写成字符串就是 6144 个字符（约 6KB），
 *   打包成字节再 base64 只有 1024 个字符。差 6 倍。
 *   而遮罩是要跟着每份素材走的，小一点总是好的。
 */
function decodeBits(b64, count) {
  if (!b64) return null;
  let bin;
  try {
    bin = atob(b64);
  } catch (_) {
    return null;
  }
  if (bin.length * 8 < count) return null;
  const bits = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const byte = bin.charCodeAt(i >> 3);
    bits[i] = (byte >> (7 - (i & 7))) & 1;
  }
  return bits;
}

// ============================================================
// 六、命中判定
//
// 三条路，按优先级：
//   1. 贴图模式 + 遮罩可用  -> 采样遮罩（最准）
//   2. 矢量模式             -> 椭圆并集
//   3. 兜底                 -> 退化为矩形包围盒
//
// 三条路都在「局部坐标」这一层工作，所以变换矩阵只有一处要维护。
// ============================================================
function hitTest(screenX, screenY) {
  const layout = layoutNow();
  const tf = transformNow();
  const p = screenToLocal(tf, screenX, screenY);

  // 先做一次便宜的粗筛。落在包围盒外面就不用往下算了，
  // 大部分鼠标移动都会在这一步被挡掉。
  if (!insideBox(p, layout, CFG.hit.padding)) return false;

  if (state.mode === 'vector') {
    // 矢量模式稍微外扩一点，手感和包围盒的 pad 保持一致
    return insideVector(p, layout, VECTOR_HIT_SHAPES, CFG.hit.padding || 0);
  }

  if (state.mask.ok) {
    const uv = localToUV(p, layout);
    const v = sampleMask(state.mask, uv.u, uv.v);
    return v >= (CFG.hit.threshold || 0.5);
  }

  if (CFG.hit.fallbackToBox === false) return false;
  return true;   // 已经过了 insideBox
}

/** 这一帧该给出的命中结果（供测试直接调用）。 */
function hitTestNow() {
  state.isCurrentlyHit = hitTest(state.lastMouse.x, state.lastMouse.y);
  if (state.isCurrentlyHit !== state.lastSentHit) {
    state.lastSentHit = state.isCurrentlyHit;
    if (window.petAPI && window.petAPI.setIgnoreMouse) {
      window.petAPI.setIgnoreMouse(state.isCurrentlyHit);
    }
  }
  return state.isCurrentlyHit;
}

// ============================================================
// 七、气泡与心情
// ============================================================
let bubbleTimer = null;

function showBubble(text) {
  bubbleEl.textContent = text;
  bubbleEl.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubbleEl.classList.remove('show'),
    REACT.bubbleDurationMs || 1800);
}

function pickLine() {
  const happy = REACT.bubbleLinesHappy || ['嘿嘿~'];
  const neutral = REACT.bubbleLinesNeutral || ['嗯？'];
  const pool = state.mood >= (REACT.moodHappyThreshold || 0.7) ? happy : neutral;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 被戳。squash/jump 给冲量，心情涨一截。 */
function poke() {
  // ★ 这两个开关默认开着（和 3D 版行为一致），
  //   但本项目这一版按需求关掉了 —— 点一下只换立绘，别的不动。
  if (REACT.pokeSquash !== false) {
    state.squash = REACT.squash !== undefined ? REACT.squash : 1;
    state.jump = REACT.jump !== undefined ? REACT.jump : 1;
  }
  state.mood = clamp(state.mood + (REACT.moodGainPerPoke || 0.28), 0, 1);
  if (REACT.pokeBubble !== false) showBubble(pickLine());

  // ★ 每点一下换一套服装。
  //   放在最后：换图是异步的（要加载新素材），先让点击的其它反馈立刻发生。
  switchToNextOutfit();
}

/** 清空反应（测试要确定性，不能靠等时间衰减）。 */
function resetReaction() {
  state.squash = 0;
  state.jump = 0;
}

// ============================================================
// 八、选择当前该显示哪种表情
//
// ★ 这里把「想显示什么表情」和「素材够不够」【拆开】了。
//
//   一开始我写成「心情好【而且】有 happy 图才返回 happy」，
//   结果矢量小人永远开心不起来 —— 因为它根本没有贴图，
//   于是被永远压在 idle 上。这类 bug 很阴：贴图模式下一切正常，
//   只有矢量模式（也就是「一张素材都没有」的默认状态）才是坏的，
//   而默认状态恰恰是测试和用户第一次看到的状态。
//
//   现在的分工：
//     expression  —— 意图，纯粹由状态决定，与素材无关
//     spriteState —— 实际用的是哪张图（贴图模式才有效）
//   矢量小人看 expression，贴图模式看 spriteState。
// ============================================================
function chooseExpression() {
  const moodHappy = state.mood >= (REACT.moodHappyThreshold || 0.7);

  // 优先级和「为什么这么排」：
  //   被戳（surprise）压过一切 —— 那是个瞬间事件，必须立刻看到反馈
  //   开心（happy）次之        —— 弯眼睛比平眼睛更有反馈感
  if (state.squash > 0.35) return 'surprise';
  if (moodHappy) return 'happy';
  return 'idle';
}

function applyExpression(next) {
  if (next === state.expression) return;
  state.expression = next;

  // 矢量模式到这儿就结束了 —— 它的表情是在 SVG 里换嘴型/压眼睛，
  // 由 updateVectorFace() 每帧按 expression 更新，不用换图。
  if (state.mode !== 'sprite') return;

  // ★★★ 贴图模式：永远只用 idle 那一张，表情靠【叠加层】做，绝不换图。
  //
  //   为什么（血泪史）：
  //   一开始我们准备了四张图（idle / blink / happy / surprise），按状态换 src。
  //   但 AI 生成的这四张【不是同一姿势只换表情】，而是【分别重画的四张整身立绘】——
  //   实测 idle↔blink 的像素差异遍布整个轮廓（占画面 14%），
  //   连帽子/围巾/姿势/大小都不同，有的套里 surprise 甚至是水手服。
  //   结果就是：每隔 2~4.5 秒眨一次眼，整只小人会「换了个样」闪一下。
  //
  //   所以现在的规矩是：
  //     - 贴图模式下 spriteEl.src 【只在换装时变】（由 applyOutfit 负责）
  //     - 眨眼功能后来也删掉了，现在连眼皮都不动
  //
  //   这段函数保留 state.spriteState 的更新，是因为它还要给调试面板/测试看，
  //   让它们知道「当前意图是什么」。但刻意【不】动 spriteEl.src。
  const has = !!spriteImages[next];
  state.spriteState = has ? next : 'idle';   // 缺图就退回 idle
}

// ============================================================
// 九、主循环
// ============================================================
let lastTs = 0;

// 暂停开关（只给调试和自动化测试用）。
//
// 为什么要它：立绘一直在呼吸、摇摆、飘。想拿两张截图逐像素比对
// （比如「命中区域是不是盖住了立绘」），两次截图之间姿态已经变了 ——
// 光头顶就能横移七八个像素，比对结果全是假差异。
// 冻结时间轴之后拍两张，姿态完全一致，比对才有意义。
//
// 注意它只冻结【时间的推进】，帧循环、渲染、命中判定都照常跑，
// 所以测试里的 waitFrames() 依然有效。
//
// ⚠️ 这个 let 必须待在 update()/frame() 【前面】。
//    它俩不会在定义时执行，但 requestAnimationFrame 会在本次模块求值
//    结束时就跑第一帧 —— 声明写在后面就是 TDZ，报的是
//    「paused is not defined」，而且只在真机上才炸，语法检查看不出来。
let paused = false;

function update(dt) {
  // ★ 眨眼已经整个删掉了（2026-09-16）—— 见 README「眨眼为什么被删掉」。
  //   这里不再有任何「眼睛开合」的状态：立绘 / 矢量小人的眼睛永远保持素材本来的样子。
  // --- 冲量衰减 ---
  // 用 pow(系数, dt) 而不是「每帧固定乘一个数」，
  // 这样掉帧和满帧的衰减【时间】是一样的，不会一卡顿就回弹得特别快。
  state.squash *= Math.pow(REACT.squashDecay || 0.0008, dt);
  state.jump *= Math.pow(REACT.jumpDecay || 0.004, dt);
  if (state.squash < 1e-4) state.squash = 0;
  if (state.jump < 1e-4) state.jump = 0;

  // --- 心情回落 ---
  state.mood = clamp(state.mood - (REACT.moodDecayPerSec || 0.06) * dt, 0, 1);

  state.time += dt;

  applyExpression(chooseExpression());
}

function render() {
  const layout = layoutNow();
  const tf = transformNow();

  petEl.style.transform =
    `translate(${tf.ax.toFixed(2)}px, ${tf.ay.toFixed(2)}px) ` +
    `rotate(${tf.rot.toFixed(4)}deg) ` +
    `scale(${tf.sx.toFixed(5)}, ${tf.sy.toFixed(5)})`;

  // 立绘尺寸。两个模式都要设 —— 万一这帧刚切过模式，
  // 尺寸也得跟着更新，不然会沿用上一种模式的比例。
  const w = layout.W.toFixed(2) + 'px';
  const h = layout.H.toFixed(2) + 'px';
  if (state.mode === 'sprite') {
    spriteEl.style.width = w;
    spriteEl.style.height = h;
  } else {
    vectorEl.style.width = w;
    vectorEl.style.height = h;
  }

  if (state.mode === 'vector') updateVectorFace();

  // --- 气泡跟随头顶 ---
  // 用变换把「头顶中线」这个局部点投影到屏幕上，
  // 所以气泡会跟着浮动和摇摆走，不会飘在答案外面。
  const headTop = {
    x: tf.ax + (0 * tf.sx) * Math.cos(tf.rotRad) - (-layout.H * tf.sy) * Math.sin(tf.rotRad),
    y: tf.ay + (0 * tf.sx) * Math.sin(tf.rotRad) + (-layout.H * tf.sy) * Math.cos(tf.rotRad),
  };
  const gap = (REACT.bubbleOffsetY || 0.06) * layout.H;
  // ★ 下限护住 HUD：气泡绝不能飘进左上角那块面板里。
  //   但 HUD 关掉之后（debug.showHud = false，正式版就是关的），
  //   再拿 60px 去卡气泡就只会让它无谓地往下坠、贴着头顶。
  //   所以这个下限是【跟着 HUD 的可见性走的】：
  //     HUD 开着 -> 留 60px（面板底约 56px + 4px 呼吸缝）
  //     HUD 关着 -> 只留 4px，让气泡老老实实待在头顶上方
  const bubbleFloor = state.hudVisible ? 60 : 4;
  const bubbleY = Math.max(bubbleFloor, headTop.y - gap - 34);
  bubbleEl.style.top = bubbleY.toFixed(1) + 'px';
  bubbleEl.style.left = (tf.ax.toFixed(1)) + 'px';
  // ★ 这里【不要】再调 frame()。
  //   调度只归 frame() 管，render() 只负责「把当前状态画到屏幕上」。
  //   一开始写成 render() 末尾调 frame()、frame() 里又调 render()，
  //   两个函数互相调用 = 无限递归，动画循环一帧都跑不起来
  //   （表现是 __petDebug 里 frames 恒为 0，但画面看着「有东西」，
  //    因为 initPlacementStyles 已经摆过一次位了 —— 极具迷惑性）。
}

function frame() {
  const now = performance.now();
  const dt = lastTs ? Math.min((now - lastTs) / 1000, 0.1) : 0.016;
  lastTs = now;

  if (!paused) update(dt);

  render();
  hitTestNow();          // 每一帧都算 —— 立绘自己会动，光标可能没动
  updateHud();

  state.frames++;
  requestAnimationFrame(frame);
}

function updateHud() {
  if (!hudEl) return;
  // ★ 必须给【显式值】，不能写 `state.hudVisible ? '' : 'none'`。
  //   清空行内样式只是「不再覆盖」，如果别处（比如 HTML 的
  //   style="display:none"，或者样式表里那条规则）还有 display:none，
  //   元素依然不显示 —— 这个坑在本项目踩过一次，记在 initPlacementStyles
  //   的注释里。显式 'block' 才是真正的「让它显示」。
  hudEl.style.display = state.hudVisible ? 'block' : 'none';
  if (!state.hudVisible || !hitStateEl) return;
  hitStateEl.textContent = state.isCurrentlyHit ? '立绘上（接收）' : '透明区（穿透）';
  hitStateEl.className = state.isCurrentlyHit ? 'hit' : 'miss';
}

// ============================================================
// 十、交互
// ============================================================
// ★ 点击/拖拽的判定一律用 e.screenX / screenY（屏幕绝对坐标），
//   不用 clientX / clientY。因为窗口自己会被拖着走，
//   client 坐标是「相对窗口」的，窗口一动它就跟着变 ——
//   3D 版在这里踩过坑，结论写进了 drag.js 的注释。
let pointer = null;

window.addEventListener('pointermove', (e) => {
  state.lastMouse.x = e.clientX;
  state.lastMouse.y = e.clientY;
  if (pointer) {
    pointer.moved = Math.max(
      pointer.moved,
      Math.abs(e.screenX - pointer.sx) + Math.abs(e.screenY - pointer.sy)
    );
    if (!pointer.dragging && pointer.moved > (REACT.clickMaxDistance || 6)) {
      pointer.dragging = true;
      if (window.petAPI) window.petAPI.dragStart();
    }
  }
});

window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (!state.isCurrentlyHit) return;   // 只有点在身上才算
  // 点在身上 -> 窗口要接收鼠标事件，否则拖拽途中鼠标滑出立绘就断了
  if (window.petAPI && window.petAPI.setIgnoreMouse) window.petAPI.setIgnoreMouse(true);
  pointer = { sx: e.screenX, sy: e.screenY, moved: 0, dragging: false };
  e.preventDefault();
});

window.addEventListener('pointerup', (e) => {
  if (!pointer) return;
  const wasDrag = pointer.dragging;
  pointer = null;
  if (wasDrag) {
    if (window.petAPI) window.petAPI.dragEnd();
  } else if (state.isCurrentlyHit) {
    poke();                            // 短按 = 戳一下
  }
});

// 鼠标滑出窗口也要结束拖拽，否则会卡在「一直跟着光标」
window.addEventListener('blur', () => {
  if (pointer && pointer.dragging && window.petAPI) window.petAPI.dragEnd();
  pointer = null;
});

// 右键退出
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (window.petAPI) window.petAPI.quit();
});

// 键盘：F12 / Ctrl+R，和 3D 版一致
window.addEventListener('keydown', (e) => {
  if (e.key === 'F12') {
    e.preventDefault();
    if (window.petAPI) window.petAPI.toggleDevTools();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R')) {
    e.preventDefault();
    if (window.petAPI) window.petAPI.reloadRenderer();
  }
});

// ============================================================
// 十一、命中判定的可视化（debug.showHitMask）
// ============================================================
// 遮罩开关为什么不能只读 CFG.debug.showHitMask？
//   因为那是一份【启动时】从主进程 sendSync 过来的配置快照。
//   开发时在 devtools 里改它、或者自动化测试想临时打开，
//   都不会触发重画 —— 必须重新加载页面才看得到，很难用。
//   所以这里留一个运行时变量：配置里写了算开，运行时打开也算开。
//
//   （教训：冒烟测试原来就是「先给 canvas 加 .on class，再调用重绘」，
//     结果重绘函数第一行就把 .on 又摘掉了 —— 什么都没画出来，
//     而那条断言写成了 check(..., true, ...)，永远不会失败。
//     假绿比红更麻烦，因为没人会去查。）
let hitMaskVisible = !!DEBUG.showHitMask;

function drawHitMask() {
  if (!hitMaskVisible) {
    hitMaskEl.classList.remove('on');
    return;
  }
  hitMaskEl.classList.add('on');
  const dpr = Math.min(window.devicePixelRatio || 1, DEBUG.maxPixelRatio || 2);
  const w = window.innerWidth, h = window.innerHeight;
  hitMaskEl.width = Math.round(w * dpr);
  hitMaskEl.height = Math.round(h * dpr);
  hitMaskEl.style.width = w + 'px';
  hitMaskEl.style.height = h + 'px';
  const ctx = hitMaskEl.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // ★ 不逐屏幕像素反解（那太慢），改成按【遮罩自己的格子】来画。
  //   这么做还有个额外好处：画出来的方格子尺寸就直接暴露了遮罩的分辨率 ——
  //   如果格子粗得能看出来，说明遮罩该加密了，一眼就知道。
  const layout = layoutNow();
  const tf = transformNow();
  const useMask = state.mode === 'sprite' && state.mask.ok;
  const cols = useMask ? state.mask.w : 48;
  const rows = useMask ? state.mask.h : 72;
  const cw = w / cols, ch = h / rows;

  ctx.fillStyle = 'rgba(220, 40, 40, 0.42)';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = screenToLocal(tf, (c + 0.5) * cw, (r + 0.5) * ch);
      if (!insideBox(p, layout, CFG.hit.padding)) continue;
      let hit;
      if (useMask) {
        const uv = localToUV(p, layout);
        hit = sampleMask(state.mask, uv.u, uv.v) >= (CFG.hit.threshold || 0.5);
      } else {
        // ★ 直接用 hitTest() 里那份判定，不自己再算一遍（见 insideVector 的注释）
        hit = insideVector(p, layout, VECTOR_HIT_SHAPES, CFG.hit.padding || 0);
      }
      if (hit) {
        ctx.fillRect(Math.floor(c * cw), Math.floor(r * ch),
                     Math.ceil(cw) + 1, Math.ceil(ch) + 1);
      }
    }
  }
}

// ============================================================
// 十二、启动
// ============================================================
function initPlacementStyles() {
  // 矢量小人的内部坐标系是固定的，宽高比由 VB 决定
  vectorAspect = VB.w / VB.h;
  state.hudVisible = DEBUG.showHud !== false;
  hitMaskEl.classList.toggle('on', hitMaskVisible);

  // ------------------------------------------------------------
  // ★ 「显示哪一个」只在这一个地方决定。
  //
  //   这里连着踩了两个坑，都值得记下来：
  //
  //   坑一：CSS 里 #sprite 和 #vector 默认都是 display:none（等 JS 决定
  //   显示谁）。我一开始只在【贴图加载成功】的分支里把 sprite 打开，
  //   矢量模式那条路忘了打开 vector —— 小人一个像素都没画出来。
  //   而它骗过了绝大部分断言：命中判定是纯数学、不看画面，
  //   帧数、缩放、气泡位置也都不依赖它。唯一戳穿它的是
  //   「截图 + 统计像素 alpha」：全不透明像素只有 0.7%。
  //
  //   坑二：第一版修法写的是 `el.style.display = ''`。
  //   这【只是清掉行内样式】，CSS 里那条 display:none 依然生效，
  //   所以修完还是看不见。要让元素显示出来必须给个显式值
  //   （'block'），或者去改 CSS 默认值。清空 ≠ 覆盖。
  //
  //   两条教训合起来是一句话：凡是「两个分支只走通一个」的地方，
  //   显示逻辑就不要各写一遍，集中到一处，并且给显式值。
  // ------------------------------------------------------------
  const useSprite = state.mode === 'sprite';
  spriteEl.style.display = useSprite ? 'block' : 'none';
  vectorEl.style.display = useSprite ? 'none' : 'block';

  // 一开始先摆一次，避免第一帧出现在 (0,0) 位置再跳过去
  const layout = layoutNow();
  const tf = transformNow();
  petEl.style.transform =
    `translate(${tf.ax}px, ${tf.ay}px) scale(${tf.sx}, ${tf.sy})`;
  spriteEl.style.width = layout.W + 'px';
  spriteEl.style.height = layout.H + 'px';
  spriteEl.classList.toggle('pixelated', !!CFG.sprite.pixelated);
  vectorEl.style.width = layout.W + 'px';
  vectorEl.style.height = layout.H + 'px';
}

buildVector();
initPlacementStyles();
drawHitMask();

// 主循环立刻起来 —— 不要等贴图加载完再起。
// 素材是「锦上添花」，矢量小人从第一帧就该动起来。
requestAnimationFrame(frame);

// 素材异步加载。加载完再切换模式，中间不会黑屏。
(async () => {
  const usedSprite = await loadSprites();
  if (usedSprite) await loadMask();
  initPlacementStyles();
  drawHitMask();
})();

// ============================================================
// 十三、调试接口
//
// 自动化测试靠它拿到内部状态。正常运行时不涉及，没有性能影响。
// ★ 这些字段名是测试和渲染层之间的契约，改名前先看 tests/。
// ============================================================
window.__petDebug = {
  config: () => CFG,

  state() {
    const layout = layoutNow();
    const tf = transformNow();
    return {
      frames: state.frames,
      time: state.time,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      dpr: window.devicePixelRatio || 1,

      // 名字沿用 3D 版的 bodyScale，语义一样：立绘当前的净缩放
      bodyScale: [tf.sx, tf.sy],
      rotation: tf.rot,
      anchor: { x: tf.ax, y: tf.ay },
      petSize: { w: layout.W, h: layout.H },

      mode: state.mode,
      expression: state.expression,
      spriteState: state.spriteState,
      spriteLoadNote,

      mood: state.mood,
      reaction: { squash: state.squash, jump: state.jump },

      isCurrentlyHit: state.isCurrentlyHit,
      needHitTest: false,
      hitMode: state.mode === 'vector' ? 'vector'
        : (state.mask.ok ? 'mask' : (CFG.hit.fallbackToBox === false ? 'none' : 'box')),
      maskInfo: { ok: state.mask.ok, w: state.mask.w, h: state.mask.h,
                  error: state.mask.error || null },

      hudVisible: state.hudVisible,
      vectorColors: CFG.vector ? CFG.vector.colors : null,
      placement: { ...PLACE },
    };
  },

  hitTestAt: (x, y) => hitTest(x, y),
  setMouse: (x, y) => { state.lastMouse.x = x; state.lastMouse.y = y; },
  hitTestNow,

  poke,
  resetReaction,

  // 纯几何接口，供测试直接验证正反变换是否自洽。
  //
  // ★ 为什么特意把「正变换」也暴露出来？
  //   因为命中判定的正确性全靠【正反变换互为逆运算】这一件事。
  //   只要给一个局部点，正着算一遍、再反解回来，
  //   应该还是同一个点 —— 这个往返测试能一次性抓住
  //   旋转方向搞反、缩放没除干净、锚点算错等一整类 bug，
  //   而且完全不需要开窗口、不需要真鼠标。
  geometry: (winW, winH, aspect) => computeLayout(winW, winH, aspect),
  transform: () => transformNow(),
  localToScreen: (x, y) => {
    const tf = transformNow();
    const c = Math.cos(tf.rotRad), s = Math.sin(tf.rotRad);
    const px = x * tf.sx, py = y * tf.sy;
    return { x: tf.ax + px * c - py * s, y: tf.ay + px * s + py * c };
  },
  screenToLocal: (x, y) => {
    const tf = transformNow();
    return screenToLocal(tf, x, y);
  },
  vectorHitShapes: () => VECTOR_HIT_SHAPES,

  // ---- 换装相关（测试与调试用）----
  // 当前套的名字 / 目录
  outfit: () => ({ name: currentOutfit.name, dir: currentOutfit.dir,
                   pool: outfitPool.slice(), deckLeft: outfitDeck.length,
                   switching }),
  // 换下一套（点击走的就是它）
  switchOutfit: switchToNextOutfit,
  // 等到「没有正在切换」为止。测试里点完要等素材加载完才能断言。
  idle: () => new Promise((resolve) => {
    const t = setInterval(() => {
      if (!switching) { clearInterval(t); resolve(true); }
    }, 16);
  }),
  // ★ 把「随机」变成可控：先看一眼牌堆顺序（调试用）
  deck: () => outfitDeck.slice(),
  // 轮次信息：测试要按「轮」验「一轮内每套只出现一次」。
  // ★ 为什么不能从外面按 pool.length 切窗口来数？
  //   因为「轮与轮的交界」允许新一轮含上一轮出现过的套，
  //   从外部根本判断不出哪一次点击是新一轮的第一张。
  round: () => outfitRound,
  history: () => outfitHistory.slice(),

  // 冒烟测试和可视化检查用
  showBubble,
  setExpression: (s) => applyExpression(s),
  redrawHitMask: drawHitMask,
  // 运行时开关：devtools 里 __petDebug.setHitMaskVisible(true) 就能看命中区域，
  // 冒烟测试也走它。传入后立刻重画，不用刷新页面。
  setHitMaskVisible: (v) => {
    hitMaskVisible = !!v;
    drawHitMask();
    return hitMaskVisible;
  },
  // 冻结 / 恢复时间轴。截图比对用，见 frame() 上面的说明。
  setPaused: (v) => {
    paused = !!v;
    return paused;
  },
  /**
   * 把命中判定的结果按网格采样出来，给自动化测试用。
   *
   * ★ 为什么不让测试去数 07-hit-mask.png 里的红色像素？
   *   那张图是给人看的，为了让格子看得清，一格有 7x5 像素那么粗；
   *   边界上「格子中心在轮廓外」的地方就整格不画，会漏掉半格。
   *   拿它当覆盖率的尺子，量到的其实是「可视化的分辨率」，
   *   不是判定本身 —— 又会变成一次「代理指标骗人」。
   *   这里每一步都直接问 hitTest()，问的就是真正生效的那个判定。
   *
   * 位序和 decodeBits() 完全一致：行优先、每行不补字节、字节内 MSB 在前。
   * 两边是同一份规格，改一处必须改另一处。
   */
  hitRaster: (step) => {
    const s = Math.max(1, Math.round(step || 1));
    const w = window.innerWidth, h = window.innerHeight;
    const cols = Math.ceil(w / s), rows = Math.ceil(h / s);
    const n = cols * rows;
    const bytes = new Uint8Array((n + 7) >> 3);
    let hits = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (hitTest((c + 0.5) * s, (r + 0.5) * s)) {
          const i = r * cols + c;
          bytes[i >> 3] |= 128 >> (i & 7);
          hits++;
        }
      }
    }
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return { step: s, cols, rows, w, h, hits, bits: btoa(bin) };
  },
};
