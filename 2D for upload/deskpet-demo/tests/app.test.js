// ============================================================
// tests/app.test.js —— 主进程拖拽集成测试
//
// 跑法：npm run test:app
//
// 这个测试加载【真实的 main.js】，启动真实的应用窗口，
// 然后通过 global.__deskpetTestCursor 注入一个假的「光标位置」，
// 在不需要真的移动你鼠标的前提下，验证真实的拖拽链路：
//
//      ipcMain 'drag-start'
//            ↓
//      main.js 启动拖拽控制器（drag.js）
//            ↓  每 16ms 读一次光标
//        移动真实窗口
//
// 它专门验证三件和你报告的问题直接相关的事：
//
//   1. 窗口是否精确跟随光标（旧的 clientX 方案只能走到一半就卡住）
//   2. 窗口轨迹是否单调，没有来回抖动
//   3. ★ 拖拽过程中窗口尺寸 / innerWidth / 画布尺寸是否保持稳定
//      —— 如果「体积不断变大」来自尺寸被改大，这里会直接抓到
//
// 为什么直接 emit IPC 而不模拟鼠标事件？
//   因为「模拟鼠标 -> 页面 mousedown」这条链路由 tests/renderer.test.js
//   负责验证（那个测试不改窗口位置，更纯粹）。这里专注验证主进程这一侧。
//   这么拆开还有实际好处：不依赖窗口焦点，测试更稳定。
//
// 注意：运行期间屏幕上会短暂出现那个桌宠窗口，几秒后自动退出。
// ============================================================

// 窗口层和 3D 版几乎完全一样，但它验的是【这个应用】的窗口，
// 所以尺寸/画布那些数字按 2D 版的配置来（340x400）。
//
// 一个值得注意的现象：这台机器缩放 125%，所以窗口请求 340 时
// 实际可能拿到 344（Windows 会把设备像素取整再换算回来）。
// 320 就没这个问题（320 × 1.25 = 400，刚好整数）。
// 所以下面所有尺寸断言都留了 ±6 的余量，而不是写死相等。

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// 无显卡环境需要软件渲染
app.commandLine.appendSwitch('use-gl', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('no-sandbox');

// 加载真实的应用主进程（它会在 app ready 时创建窗口）
const appModule = require('../main.js');

let failed = 0;
function check(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (detail) console.log(`       ${detail}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    await runTests();
  } catch (err) {
    console.log('\n[测试脚本异常]', err && err.message);
    if (err && err.stack) console.log(err.stack);
    failed++;
  }
  console.log('');
  console.log(failed === 0 ? '全部通过' : `${failed} 项失败`);
  app.exit(failed === 0 ? 0 : 1);
});

async function runTests() {
  // 等 main.js 把窗口建好并加载完页面
  let win = null;
  for (let i = 0; i < 80; i++) {
    win = appModule.getWindow();
    if (win && !win.webContents.isLoading()) break;
    await sleep(200);
  }
  if (!win) throw new Error('main.js 没有创建窗口');
  await sleep(1500);   // 等渲染层把立绘摆好、动画循环跑起来

  const evalJS = (expr) => win.webContents.executeJavaScript(expr);

  // ============================================================
  console.log('\n=== 1. 窗口初始状态 ===');

  const bounds0 = win.getBounds();
  const state0 = await evalJS('window.__petDebug.state()');

  // ★ 窗口尺寸不要写死一个数字 —— 它来自配置，用户随时会改。
  //   这里从主进程实际读到的配置里取期望值，再允许高 DPI 下的取整误差。
  //   （曾经写死 340x400，改成 300x260 之后这条就假红了 —— 假红会让人去查一个不存在的问题。）
  const winCfg = (appModule.getConfig() && appModule.getConfig().window) || {};
  const wantW = winCfg.width || 300;
  const wantH = winCfg.height || 260;
  const tol = 8;   // 125% 缩放下的取整 + 边框误差

  check('窗口尺寸符合配置（允许高 DPI 下的取整误差）',
    Math.abs(bounds0.width - wantW) <= tol && Math.abs(bounds0.height - wantH) <= tol,
    `${bounds0.width}x${bounds0.height} @ (${bounds0.x}, ${bounds0.y})，配置 ${wantW}x${wantH}`);
  check('渲染层已就绪',
    Array.isArray(state0.bodyScale) && Math.abs(state0.innerW - wantW) <= tol,
    `innerW ${state0.innerW}（配置 ${wantW}），立绘 ${state0.petSize.w.toFixed(1)}x${state0.petSize.h.toFixed(1)}，dpr ${state0.dpr}`);

  // ============================================================
  console.log('\n=== 2. 触发拖拽，验证窗口是否精确跟随 ===');

  const cursor0 = { x: bounds0.x + 170, y: bounds0.y + 200 };
  global.__deskpetTestCursor = { ...cursor0 };

  // 直接触发主进程的拖拽入口（相当于页面发来 drag-start）
  ipcMain.emit('drag-start', {});
  await sleep(150);

  check('拖拽已启动（窗口位置被重设为光标 - 偏移量）',
    win.getBounds().x === cursor0.x - 170 && win.getBounds().y === cursor0.y - 200,
    `窗口 (${win.getBounds().x}, ${win.getBounds().y})`);

  // 让假光标移动：右 400px、下 60px，分 50 步
  const STEP_X = 8, STEP_Y = 1.2, STEPS = 50;
  const positions = [];
  const sizes = [];
  const inners = [];

  for (let i = 1; i <= STEPS; i++) {
    global.__deskpetTestCursor = {
      x: cursor0.x + i * STEP_X,
      y: cursor0.y + i * STEP_Y,
    };
    await sleep(20);

    if (i % 5 === 0) {
      const b = win.getBounds();
      positions.push({ x: b.x, y: b.y });
      sizes.push({ w: b.width, h: b.height });
      inners.push(await evalJS(
        '(() => { const r = document.getElementById("stage").getBoundingClientRect();' +
        ' return { w: window.innerWidth, h: window.innerHeight,' +
        ' cw: Math.round(r.width), ch: Math.round(r.height) }; })()'
      ));
    }
  }

  await sleep(250);
  const boundsEnd = win.getBounds();

  const expectDX = STEPS * STEP_X;            // 400
  const expectDY = Math.round(STEPS * STEP_Y); // 60
  const actualDX = boundsEnd.x - bounds0.x;
  const actualDY = boundsEnd.y - bounds0.y;

  console.log(`       窗口位移: dx=${actualDX}, dy=${actualDY}（期望 dx≈${expectDX}, dy≈${expectDY}）`);
  console.log(`       轨迹采样: ${positions.map((p) => p.x).join(' -> ')}`);

  check('窗口精确跟随光标（右移方向）',
    Math.abs(actualDX - expectDX) <= 10,
    `实际 dx=${actualDX}，期望 ${expectDX}，误差 ${Math.abs(actualDX - expectDX)}px`);
  check('窗口精确跟随光标（下移方向）',
    Math.abs(actualDY - expectDY) <= 10,
    `实际 dy=${actualDY}，期望 ${expectDY}，误差 ${Math.abs(actualDY - expectDY)}px`);

  // 这是修复前后的关键差异：旧算法因为 clientX 反馈循环只能走到一半
  check('★ 未复现旧算法的「只走一半 / 走一步停一步」问题',
    actualDX > expectDX * 0.95,
    `旧算法约只能走 ${expectDX / 2}px，实际走了 ${actualDX}px`);

  let backSteps = 0;
  for (let i = 1; i < positions.length; i++) {
    if (positions[i].x < positions[i - 1].x) backSteps++;
  }
  check('★ 窗口轨迹单调向前，没有来回抖动（闪烁的根源）',
    backSteps === 0,
    `${positions.length} 个采样点，倒退 ${backSteps} 次`);

  // ============================================================
  console.log('\n=== 3. ★ 拖拽期间的尺寸稳定性 ===');

  // 注意断言口径：要验证的是「拖拽【期间】尺寸没有增长」，
  // 而不是「每个采样点都一模一样」。后者会时红时绿。
  //
  // 为什么：拖拽控制器每次都显式请求 340x400，但这台机器缩放 125%，
  // Windows 会把设备像素取整再换算回 DIP，于是会看到 344x401 和 344x400
  // 两种读数。关键是【矫正发生在第几帧是不确定的】——
  // 我一开始写「剔除前两个采样后必须完全一致」，结果它偏偏在第 3 个采样
  // 之后才矫正，断言就红了。这种依赖时机的断言本身就是坏的。
  //
  // 所以改成断言本质：全程波动不超过 1px。
  // 真正的「越拖越大」是单调往上爬（旧实现 60 次移动涨了 81px，
  // 拖 400px 大约会涨十几个像素），跨度 ≤1px 足以把它挡住，
  // 而且不受取整时机影响。
  const hs = sizes.map((s) => s.h);
  const ws = sizes.map((s) => s.w);
  const spanH = Math.max(...hs) - Math.min(...hs);
  const spanW = Math.max(...ws) - Math.min(...ws);
  check('★ 拖拽全程窗口尺寸稳定（只有 1px 内的取整抖动，无增长）',
    spanW <= 1 && spanH <= 1,
    `采样尺寸: ${[...new Set(sizes.map((s) => `${s.w}x${s.h}`))].join(', ')}；` +
    `全程波动 宽${spanW}px 高${spanH}px（旧实现拖这么远会涨十几个像素）`);
  check('★ 拖完后窗口没有比开始时更大',
    ws[ws.length - 1] <= ws[0] && hs[hs.length - 1] <= hs[0],
    `开始 ${ws[0]}x${hs[0]} -> 结束 ${ws[ws.length - 1]}x${hs[hs.length - 1]}`);

  const f = inners[0];
  check('★ 拖拽全程 innerWidth/innerHeight 未变',
    inners.every((s) => s.w === f.w && s.h === f.h),
    `稳定在 ${f.w}x${f.h}`);
  check('★ 拖拽全程舞台尺寸未变（无溢出放大）',
    inners.every((s) => s.cw === f.cw && s.ch === f.ch),
    `稳定在 ${f.cw}x${f.ch}`);

  const endState = await evalJS('window.__petDebug.state()');
  check('★ 拖拽后立绘缩放仍在 1.0 附近（无累积放大）',
    Math.abs(endState.bodyScale[0] - 1) < 0.12 && Math.abs(endState.bodyScale[1] - 1) < 0.12,
    `立绘 scale = [${endState.bodyScale.map((n) => n.toFixed(4)).join(', ')}]`);
  check('★ 立绘尺寸与旋转角正常，未出现 NaN/Infinity',
    Number.isFinite(endState.rotation) && Number.isFinite(endState.bodyScale[0]) &&
    endState.petSize.w > 0,
    `rotation = ${endState.rotation.toFixed(3)}°，立绘宽 = ${endState.petSize.w.toFixed(1)}`);

  // ============================================================
  console.log('\n=== 4. 结束拖拽 ===');

  ipcMain.emit('drag-end', {});
  await sleep(200);

  // 松手之后，即使光标继续移动，窗口也不应该再跟随
  const posAtRelease = win.getBounds();
  global.__deskpetTestCursor = { x: posAtRelease.x + 700, y: posAtRelease.y + 100 };
  await sleep(400);
  const posAfter = win.getBounds();

  check('松手后窗口不再跟随光标（拖拽定时器已停止）',
    posAfter.x === posAtRelease.x && posAfter.y === posAtRelease.y,
    `窗口停在 (${posAfter.x}, ${posAfter.y})`);

  global.__deskpetTestCursor = null;
}
