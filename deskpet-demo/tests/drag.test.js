// ============================================================
// tests/drag.test.js —— 拖拽算法测试（纯 Node，不需要 Electron）
//
// 跑法：npm run test:drag
//
// 覆盖两个已经真实发生过的 bug：
//   坑 1：用 clientX 算位移 -> 窗口「走一步停一步」的闪烁
//   坑 2：用 setPosition 移动 -> 窗口「越拖越高」，模型显得越来越大
// ============================================================

const { createDragController } = require('../drag');

let failed = 0;
function check(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (detail) console.log(`       ${detail}`);
  if (!ok) failed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// 假窗口 A：完全正常的窗口，用来验证跟随精度
// ------------------------------------------------------------
function makeFakeWindow(startX, startY, width = 320, height = 424) {
  const pos = { x: startX, y: startY };
  const size = { width, height };
  const history = [];
  const calls = { setPosition: 0, setBounds: 0 };

  return {
    getPosition: () => [pos.x, pos.y],
    getBounds: () => ({ x: pos.x, y: pos.y, width: size.width, height: size.height }),
    setPosition: (x, y) => { calls.setPosition++; pos.x = x; pos.y = y; },
    setBounds: (b) => {
      calls.setBounds++;
      if (b.x !== undefined) pos.x = b.x;
      if (b.y !== undefined) pos.y = b.y;
      if (b.width !== undefined) size.width = b.width;
      if (b.height !== undefined) size.height = b.height;
      history.push({ x: pos.x, y: pos.y, w: size.width, h: size.height });
    },
    _pos: pos,
    _size: size,
    _history: history,
    _calls: calls,
  };
}

// ------------------------------------------------------------
// 假窗口 B：模拟实测到的 Windows 行为
//   调 setPosition 会让窗口慢慢变高（125% 缩放下的真实 bug）
//   调 setBounds 且带显式宽高则完全稳定
// ------------------------------------------------------------
function makeGrowingFakeWindow(startX, startY, width = 320, height = 424) {
  const pos = { x: startX, y: startY };
  const size = { width, height };
  const GROWTH_PER_MOVE = 1.35;   // 按实测速率折算

  return {
    getPosition: () => [pos.x, pos.y],
    getBounds: () => ({ x: pos.x, y: pos.y, width: size.width, height: size.height }),
    setPosition: (x, y) => {
      pos.x = x;
      pos.y = y;
      size.height += GROWTH_PER_MOVE;   // ★ 模拟系统的「自由发挥」
    },
    setBounds: (b) => {
      pos.x = b.x;
      pos.y = b.y;
      size.width = b.width;             // ★ 显式宽高把尺寸钉死
      size.height = b.height;
    },
    _pos: pos,
    _size: size,
  };
}

// ============================================================
// 坑 1 复现：clientX 增量导致「走一步停一步」
// ============================================================
console.log('\n=== 坑 1 复现：clientX 增量（旧实现）===');

(function reproduceStutter() {
  const CURSOR_START = 1000;
  const STEP = 5;
  const FRAMES = 24;

  let winX = 900;
  let lastClientX = CURSOR_START - winX;
  const dxs = [];
  const windowXs = [winX];

  for (let i = 1; i < FRAMES; i++) {
    const clientX = CURSOR_START + STEP * i - winX;   // ★ clientX 依赖 winX
    const dx = clientX - lastClientX;
    winX = Math.round(winX + dx);
    lastClientX = clientX;
    dxs.push(dx);
    windowXs.push(winX);
  }

  const cursorTravel = STEP * (FRAMES - 1);
  const windowTravel = windowXs[windowXs.length - 1] - windowXs[0];
  const zeroFrames = dxs.filter((d) => d === 0).length;

  console.log(`       每帧窗口位移: [${dxs.slice(0, 8).join(', ')} ...]`);

  check('复现成功：窗口「走一步停一步」',
    zeroFrames > 0,
    `${dxs.length} 帧里有 ${zeroFrames} 帧位移为 0 —— 这就是闪烁的来源`);
  check('复现成功：窗口速度只有光标的一半',
    windowTravel <= cursorTravel * 0.55,
    `光标走 ${cursorTravel}px，窗口只走 ${windowTravel}px`);
})();

// ============================================================
// 坑 2 复现：setPosition 导致「越拖越大」
// ============================================================
console.log('\n=== 坑 2 复现：setPosition 导致越拖越大（旧实现）===');

(function reproduceGrowth() {
  const win = makeGrowingFakeWindow(900, 400);
  const startH = win.getBounds().height;

  // 模拟旧实现：只用 setPosition
  for (let i = 0; i < 60; i++) {
    const b = win.getBounds();
    win.setPosition(b.x + 8, b.y + 1);
  }

  const endH = win.getBounds().height;
  const grew = endH - startH;

  check('复现成功：只用 setPosition 窗口会持续变高',
    grew > 20,
    `60 次移动后高度从 ${startH.toFixed(1)} 涨到 ${endH.toFixed(1)}（+${grew.toFixed(1)}）—— 这就是「体积不断变大」`);
})();

// ============================================================
// 修复验证
// ============================================================
console.log('\n=== 修复验证：绝对坐标 + setBounds 显式宽高 ===');

async function verifyFix() {
  const START_WIN_X = 900;
  const START_WIN_Y = 400;
  const START_CURSOR_X = 1000;
  const START_CURSOR_Y = 500;
  const STEP = 4;
  const STEPS = 50;

  const win = makeFakeWindow(START_WIN_X, START_WIN_Y, 320, 424);
  let cursorX = START_CURSOR_X;
  const startHeight = win.getBounds().height;

  const controller = createDragController({
    getWindow: () => win,
    getCursor: () => ({ x: cursorX, y: START_CURSOR_Y }),
    interval: 16,
  });

  controller.start();

  check('按下时记录了正确的偏移量',
    win._pos.x === START_WIN_X && win._pos.y === START_WIN_Y,
    `偏移量 (100, 100)，窗口保持原位 (${win._pos.x}, ${win._pos.y})`);

  for (let i = 0; i < STEPS; i++) {
    cursorX += STEP;
    await sleep(16);
  }
  await sleep(80);

  const moved = controller.end();
  const expectedTravel = STEP * STEPS;
  const expectedWinX = START_CURSOR_X + expectedTravel - 100;

  check('窗口严格跟随光标（位移量完全一致）',
    win._pos.x === expectedWinX,
    `窗口 x = ${win._pos.x}，期望 ${expectedWinX}`);
  check('（对比旧实现）位移不再只有一半',
    win._pos.x - START_WIN_X > expectedTravel * 0.9,
    `实际走了 ${win._pos.x - START_WIN_X}px，旧实现约只能走 ${expectedTravel / 2}px`);

  check('全程使用 setBounds 且带显式宽高，从未调用 setPosition',
    win._calls.setBounds > 0 && win._calls.setPosition === 0,
    `setBounds ${win._calls.setBounds} 次，setPosition ${win._calls.setPosition} 次`);

  const allSizesPinned = win._history.every((h) => h.w === 320 && h.h === 424);
  check('每次移动都显式带上了宽高（尺寸被钉死）',
    allSizesPinned,
    `${win._history.length} 次移动全部带 width=320, height=424`);

  check('拖拽后窗口尺寸毫无变化（「越拖越大」已修复）',
    win.getBounds().height === startHeight,
    `高度 ${startHeight} -> ${win.getBounds().height}`);

  check('累计位移量记录正确（用于区分点击与拖拽）',
    Math.abs(moved - expectedTravel) <= STEP * 2,
    `记录 ${moved.toFixed(1)}px，实际 ${expectedTravel}px`);

  let backSteps = 0;
  for (let i = 1; i < win._history.length; i++) {
    if (win._history[i].x < win._history[i - 1].x) backSteps++;
  }
  check('窗口轨迹单调向前，无倒退抖动',
    backSteps === 0,
    `${win._history.length} 次移动，倒退 ${backSteps} 次`);

  // ----------------------------------------------------------
  // 放到「会变大的假窗口」上，尺寸也应该被钉住
  // ----------------------------------------------------------
  console.log('\n=== 修复后的实现跑在会「自动变大」的窗口上 ===');

  const growWin = makeGrowingFakeWindow(900, 400);
  let cx = 1000;
  const c2 = createDragController({
    getWindow: () => growWin,
    getCursor: () => ({ x: cx, y: 500 }),
    interval: 16,
  });
  c2.start();
  for (let i = 0; i < 40; i++) {
    cx += 5;
    await sleep(16);
  }
  await sleep(80);
  c2.end();

  check('★ 即使在会「自动变大」的窗口上，尺寸也被钉住',
    growWin.getBounds().height === 424,
    `高度保持 ${growWin.getBounds().height}（若沿用旧实现会涨到约 ${(424 + 40 * 1.35).toFixed(1)}）`);
}

verifyFix().then(() => {
  console.log('');
  if (failed === 0) {
    console.log('全部通过');
    process.exit(0);
  } else {
    console.log(`${failed} 项失败`);
    process.exit(1);
  }
});
