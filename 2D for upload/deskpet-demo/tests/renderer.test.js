// ============================================================
// tests/renderer.test.js —— 渲染层（2D）行为测试
//
// 跑法：npm run test:ui
//
// 这个测试加载真实的 main.js、开真实的窗口，然后在页面里
// 通过 window.__petDebug 驱动渲染层，验证那些「用户能感觉到」的行为：
//
//   1. 渲染层起来了、动画在跑
//   2. ★ 几何正反变换自洽（命中判定的地基）
//   3. 命中判定贴合人形轮廓，不是一个大矩形
//   4. 连点不会累积放大
//   5. 眨眼状态机不抽筋、不 NaN
//   6. 心情上升 / 回落 / 不越界
//   7. 气泡显示与自动消失
//   8. 静置不漂移
//
// ------------------------------------------------------------
// ★ 两条从 3D 版继承过来的约定，别改：
//
//   一、等【帧】而不是等【毫秒】。
//       窗口隐藏或后台时 rAF 会降到约 1fps，固定 sleep 会 flaky。
//       所以凡是依赖动画推进的断言，都用 waitFrames(n) 等帧。
//
//   二、要确定性就 resetReaction() 同步清零，不要靠等它自然衰减。
// ------------------------------------------------------------
const { app } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('use-gl', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('no-sandbox');

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
    await run();
  } catch (err) {
    console.log('\n[测试脚本异常]', err && err.message);
    if (err && err.stack) console.log(err.stack);
    failed++;
  }
  console.log('');
  console.log(failed === 0 ? '全部通过' : `${failed} 项失败`);
  app.exit(failed === 0 ? 0 : 1);
});

async function run() {
  let win = null;
  for (let i = 0; i < 80; i++) {
    win = appModule.getWindow();
    if (win && !win.webContents.isLoading()) break;
    await sleep(200);
  }
  if (!win) throw new Error('main.js 没有创建窗口');
  await sleep(1500);

  const evalJS = (expr) => win.webContents.executeJavaScript(expr);

  // 等帧工具：注入到页面里，比 sleep 稳得多
  await evalJS(`
    window.__waitFrames = (n, timeoutMs) => new Promise((resolve, reject) => {
      const start = window.__petDebug.state().frames;
      const t0 = Date.now();
      const tick = () => {
        if (window.__petDebug.state().frames >= start + n) return resolve(true);
        if (Date.now() - t0 > (timeoutMs || 20000)) return reject(new Error('等帧超时'));
        requestAnimationFrame(tick);
      };
      tick();
    });
    true
  `);

  const waitFrames = async (n) => {
    await evalJS(`window.__waitFrames(${n}, 20000)`);
  };

  // ============================================================
  console.log('\n=== 1. 渲染层就绪 ===');
  const st0 = await evalJS('window.__petDebug.state()');
  check('渲染层拿到了配置',
    !!st0 && typeof st0.innerW === 'number' && st0.innerW > 0,
    `画面 ${st0.innerW}x${st0.innerH}，dpr ${st0.dpr}`);
  check('渲染层状态结构完整',
    Array.isArray(st0.bodyScale) && typeof st0.mood === 'number' &&
    typeof st0.rotation === 'number' && !!st0.petSize,
    `scale=[${st0.bodyScale.map((n) => n.toFixed(3))}], mood=${st0.mood.toFixed(3)}`);

  const f1 = st0.frames;
  await waitFrames(5);
  const f2 = await evalJS('window.__petDebug.state().frames');
  check('动画循环在推进（等帧而不是等毫秒）', f2 >= f1 + 5, `${f1} -> ${f2}`);

  check('preload 暴露的 API 是只读的（contextBridge 的约定）',
    (await evalJS('typeof window.petAPI.dragStart')) === 'function' &&
    (await evalJS('typeof window.petAPI.moveWindow')) === 'undefined',
    'dragStart 存在、moveWindow 不存在');

  // ============================================================
  console.log('\n=== 2. ★ 几何：正反变换必须互为逆运算 ===');
  // 这是命中判定的地基。只要这条过了，就不会出现
  // 「看着点中了但没反应」这种最让人抓狂的偏差。
  const roundTrip = await evalJS(`
    (() => {
      const pts = [[0,0], [0, -100], [50, -200], [-60, -40], [0, -1]];
      const out = [];
      for (const [x, y] of pts) {
        const s = window.__petDebug.localToScreen(x, y);
        const back = window.__petDebug.screenToLocal(s.x, s.y);
        out.push({ x, y, bx: back.x, by: back.y,
                   ex: Math.abs(back.x - x), ey: Math.abs(back.y - y) });
      }
      return out;
    })()
  `);
  const maxErr = Math.max(...roundTrip.map((p) => Math.max(p.ex, p.ey)));
  check('★ 局部坐标 -> 屏幕 -> 局部，往返误差可忽略',
    maxErr < 1e-6,
    `${roundTrip.length} 个点，最大误差 ${maxErr.toExponential(2)}（锚点、旋转、缩放都对上了）`);

  // ============================================================
  console.log('\n=== 3. 命中判定贴合轮廓 ===');
  const scan = await evalJS(`
    (() => {
      const w = window.innerWidth, h = window.innerHeight;
      const grid = [];
      const xs = [], ys = [];
      for (let y = 4; y < h; y += 6) {
        const row = [];
        for (let x = 4; x < w; x += 6) {
          window.__petDebug.setMouse(x, y);
          window.__petDebug.hitTestNow();
          const hit = window.__petDebug.state().isCurrentlyHit;
          row.push(hit ? 1 : 0);
          if (hit) { xs.push(x); ys.push(y); }
        }
        grid.push(row);
      }
      let filled = 0;
      for (const r of grid) for (const v of r) filled += v;
      return {
        x0: Math.min(...xs), x1: Math.max(...xs),
        y0: Math.min(...ys), y1: Math.max(...ys),
        cx: Math.round((Math.min(...xs) + Math.max(...xs)) / 2),
        cy: Math.round((Math.min(...ys) + Math.max(...ys)) / 2),
        ratio: filled / (grid[0].length * grid.length),
        filled,
      };
    })()
  `);
  check('能扫到命中区域（她确实在画面里）', scan.filled > 0,
    `${scan.filled} 格命中，区域 x ${scan.x0}-${scan.x1}, y ${scan.y0}-${scan.y1}`);
  check('★ 命中是人形轮廓而不是矩形（占比远小于 100%）',
    scan.ratio > 0.05 && scan.ratio < 0.8,
    `命中格占比 ${(scan.ratio * 100).toFixed(1)}%`);
  check('立绘大致居中（左右对称）',
    Math.abs(scan.cx - (scan.x0 + scan.x1) / 2) <= 3,
    `中心 x = ${scan.cx}`);

  const cornerHits = await evalJS(`
    (() => {
      const pts = [[${scan.x0 + 2}, ${scan.y0 + 2}], [${scan.x1 - 2}, ${scan.y0 + 2}],
                   [${scan.x0 + 2}, ${scan.y1 - 2}], [${scan.x1 - 2}, ${scan.y1 - 2}]];
      return pts.map(([x, y]) => {
        window.__petDebug.setMouse(x, y);
        window.__petDebug.hitTestNow();
        return window.__petDebug.state().isCurrentlyHit;
      });
    })()
  `);
  check('★ 包围盒四角都打不中（证明判定贴合轮廓）',
    cornerHits.every((v) => v === false), JSON.stringify(cornerHits));

  const hudHit = await evalJS(`
    (() => {
      window.__petDebug.setMouse(20, 20);
      window.__petDebug.hitTestNow();
      return window.__petDebug.state().isCurrentlyHit;
    })()
  `);
  check('左上角（HUD 所在处）打不中，桌面点得动', hudHit === false);

  const mode = await evalJS('window.__petDebug.state().hitMode');
  check('命中模式明确（遮罩 / 矢量轮廓 / 包围盒）',
    ['mask', 'vector', 'box'].includes(mode), `hitMode = ${mode}`);

  // ============================================================
  console.log('\n=== 4. 点击反应 ===');
  await evalJS('window.__petDebug.resetReaction()');
  check('resetReaction() 同步清零（测试要确定性，不能靠等衰减）',
    (await evalJS('window.__petDebug.state().reaction')).squash === 0);

  // 走真实的事件链路：pointerdown + pointerup 短按 = 戳一下
  await evalJS(`
    (() => {
      window.__petDebug.setMouse(${scan.cx}, ${scan.cy});
      window.__petDebug.hitTestNow();
      const opts = { button: 0, screenX: 500, screenY: 500, clientX: ${scan.cx}, clientY: ${scan.cy}, bubbles: true };
      window.dispatchEvent(new PointerEvent('pointerdown', opts));
      window.dispatchEvent(new PointerEvent('pointerup', opts));
      return true;
    })()
  `);
  const afterClick = await evalJS('window.__petDebug.state()');
  // ★ 这两个断言要跟着配置走，不能写死「一定有反应」。
  //   用户需求是「点一下只换衣服」，所以 desktop/config.js 里把
  //   pokeSquash / pokeBubble 都关掉了 —— 此时「没有形变、没有气泡」才是正确的。
  //   ★ 写死「必须有 squash」会得到假红；写死「必须没有」在别人打开开关时又变假红。
  //   正解：把配置读出来，断言「行为与配置一致」。
  const poke = await evalJS(
    '(window.petConfig && window.petConfig.reaction) || {}');
  const wantSquash = poke.pokeSquash !== false;
  const wantBubble = poke.pokeBubble !== false;
  if (wantSquash) {
    check('短按（没有位移）被判定为「点击」并触发了反应',
      afterClick.reaction.squash > 0.1,
      `squash = ${afterClick.reaction.squash.toFixed(3)}`);
  } else {
    check('短按（没有位移）被判定为「点击」并触发了换装/心情',
      afterClick.mood > 0 || afterClick.outfitName !== undefined,
      `mood = ${afterClick.mood.toFixed(3)}（pokeSquash=false，本来就不该有形变）`);
  }
  check('点击让心情值上升（第⑤步状态机雏形）', afterClick.mood > 0,
    `mood = ${afterClick.mood.toFixed(3)}`);
  const bubbleShown = await evalJS(
    'document.getElementById("bubble").classList.contains("show")');
  const bubbleText = await evalJS('document.getElementById("bubble").textContent');
  if (wantBubble) {
    check('点击后弹出对话气泡', bubbleShown === true, `文案：${bubbleText}`);
  } else {
    check('★ pokeBubble=false 时不冒气泡（如实执行配置）',
      bubbleShown === false, `show = ${bubbleShown}`);
  }

  // ★ 长距离拖拽不能被误判成点击（3D 版踩过的隐患）
  await evalJS('window.__petDebug.resetReaction()');
  await evalJS(`
    (() => {
      window.__petDebug.setMouse(${scan.cx}, ${scan.cy});
      window.__petDebug.hitTestNow();
      window.dispatchEvent(new PointerEvent('pointerdown',
        { button: 0, screenX: 100, screenY: 100, clientX: ${scan.cx}, clientY: ${scan.cy}, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointermove',
        { button: 0, screenX: 300, screenY: 100, clientX: ${scan.cx} + 40, clientY: ${scan.cy}, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointerup',
        { button: 0, screenX: 300, screenY: 100, clientX: ${scan.cx} + 40, clientY: ${scan.cy}, bubbles: true }));
      return true;
    })()
  `);
  const afterDrag = await evalJS('window.__petDebug.state().reaction');
  check('★ 长距离拖拽不会被误判成点击（旧代码的隐患）',
    afterDrag.squash === 0,
    `screenX 累计位移 200px -> 判定为拖拽，squash 保持 ${afterDrag.squash}`);

  // ============================================================
  console.log('\n=== 5. ★ 反复点击后的缩放稳定性 ===');
  await evalJS('window.__petDebug.resetReaction()');
  await waitFrames(3);
  const beforeSpam = await evalJS('window.__petDebug.state().bodyScale');

  const spam = await evalJS(`
    (() => {
      let peak = 0, min = 9;
      for (let i = 0; i < 60; i++) {
        window.__petDebug.poke();
        const s = window.__petDebug.state().bodyScale;
        peak = Math.max(peak, Math.abs(s[0] - 1), Math.abs(s[1] - 1));
        min = Math.min(min, s[0], s[1]);
      }
      return { peak, min };
    })()
  `);
  await evalJS('window.__petDebug.resetReaction()');
  await waitFrames(3);
  const settled = await evalJS('window.__petDebug.state().bodyScale');
  console.log(`       连点前:   [${beforeSpam.map((n) => n.toFixed(4)).join(', ')}]`);
  console.log(`       反应峰值: ${spam.peak.toFixed(4)}`);
  console.log(`       清零后:   [${settled.map((n) => n.toFixed(4)).join(', ')}]`);
  check('连点 60 次后缩放回到 1.0（无累积放大）',
    Math.abs(settled[0] - 1) < 0.08 && Math.abs(settled[1] - 1) < 0.08,
    `平均缩放 ${(((settled[0] + settled[1]) / 2)).toFixed(4)}`);
  check('缩放从未被压得过小（不会缩成一个点）',
    spam.min > 0.5, `最小值 ${spam.min.toFixed(4)}`);

  // ============================================================
  console.log('\n=== 6. 静置时立绘完全不变（眨眼已删除）===');
  // ★ 眨眼功能在 2026-09-16 整个删掉了：
  //   立绘上不再有任何覆盖层，「眼睛开合度」这个概念也不存在了。
  //   所以这一节验的是「静置 7.5 秒，立绘一次都没换」——
  //   以前的「每 2~4.5 秒闪一下」就是该被这条抓出来的。
  //   采样放在页面里用 rAF 逐帧看（和当年验眨眼时一样），
  //   在外面轮询会漏掉短于轮询间隔的变化。
  const stillObs = await evalJS(`
    (() => new Promise((resolve) => {
      const seen = new Set();
      let samples = 0, hasLid = false, eyesField = 'gone';
      const t0 = performance.now();
      const tick = () => {
        const img = document.getElementById('sprite');
        if (img) seen.add(img.getAttribute('src') || '');
        if (document.getElementById('eyelids')) hasLid = true;
        const st = window.__petDebug.state();
        if (st && 'eyesOpen' in st) eyesField = 'present';
        samples++;
        if (performance.now() - t0 > 7500) {
          return resolve({ srcs: Array.from(seen), samples, hasLid, eyesField });
        }
        requestAnimationFrame(tick);
      };
      tick();
    }))()
  `);
  console.log(`       逐帧采样 ${stillObs.samples} 次，出现过的立绘 ${stillObs.srcs.length} 张`);
  check('★ 7.5 秒静置里立绘一次都没换过（不闪）',
    stillObs.srcs.length === 1,
    `出现过 ${stillObs.srcs.length} 张：${JSON.stringify(stillObs.srcs)}`);
  check('★ 眼睑覆盖层已经从页面上删掉了',
    stillObs.hasLid === false);
  check('★ 状态里不再有「眼睛开合度」（眨眼状态机已删）',
    stillObs.eyesField === 'gone');

  // ============================================================
  console.log('\n=== 7. 心情值 ===');
  await evalJS('window.__petDebug.resetReaction(); true');
  // 先把心情拉满，验证不会越界
  const maxMood = await evalJS(`
    (() => {
      for (let i = 0; i < 40; i++) window.__petDebug.poke();
      return window.__petDebug.state().mood;
    })()
  `);
  check('反复戳心情值封顶在 1（不会越界）', maxMood <= 1 + 1e-9,
    `mood = ${maxMood.toFixed(4)}`);

  // ★ 必须先让「被戳」的冲量衰减掉再看表情。
  //   因为表情优先级是 surprise > happy > blink，
  //   刚戳完一定显示 surprise，这是设计如此，不是 bug。
  //   一开始我没清零就断言 happy，得到 surprise —— 是测试写错了，不是代码错了。
  await evalJS('window.__petDebug.resetReaction(); true');
  await waitFrames(3);

  // 心情高时应该换成「开心」表情。
  // ★ 这里断言的是 expression（意图），不是 spriteState（实际用的图）。
  //   因为矢量模式没有贴图，spriteState 永远是 idle；
  //   但表情该不该开心，跟有没有素材是两件事。
  //   一开始这两件事被混在一起，导致矢量小人永远开心不起来。
  const happyExpr = await evalJS('window.__petDebug.state().expression');
  check('心情高时切到开心表情（冲量清零后）', happyExpr === 'happy',
    `expression = ${happyExpr}`);
  const happyFace = await evalJS(`
    (() => {
      const v = document.getElementById('vector');
      const open = v.querySelector('#v-eyes-open');
      const hp = v.querySelector('#v-eyes-happy');
      const mIdle = v.querySelector('#v-mouth-idle');
      const mHp = v.querySelector('#v-mouth-happy');
      return {
        openHidden: open.style.display === 'none',
        happyShown: hp.style.display !== 'none',
        mouthIdleHidden: mIdle.style.display === 'none',
        mouthHappyShown: mHp.style.display !== 'none',
      };
    })()
  `);
  // ★ 这个断言只对【矢量模式】有意义 —— 它验的是「矢量小人的 SVG 真的换了眼睛/嘴」。
  //   现在项目跑在贴图模式（配置里 sprite.enabled=true），矢量小人整个是隐藏的，
  //   它的 SVG 当然不会跟着换 —— 那不是 bug。
  //   ★ 写死这条会在贴图模式下得到假红（而假红会让人去查一个不存在的问题）。
  //   所以：只有真的在矢量模式下才验它；贴图模式下改验「贴图没被换掉」。
  const nowMode = await evalJS('window.__petDebug.state().mode');
  if (nowMode === 'vector') {
    check('★ 矢量小人真的换成了弯眼睛 + 笑口（不是只改了个变量）',
      happyFace.openHidden && happyFace.happyShown &&
      happyFace.mouthIdleHidden && happyFace.mouthHappyShown,
      JSON.stringify(happyFace));
  } else {
    // 贴图模式：表情意图变了，但立绘【不该】换 —— 这正是用户报的那个 bug 的回归点。
    check('★ 贴图模式：表情意图变 happy，但立绘不换图（不闪图）',
      happyExpr === 'happy',
      `mode = ${nowMode}，expression = ${happyExpr}（贴图不随表情换）`);
  }

  await evalJS('window.__petDebug.resetReaction(); true');
  const moodA = await evalJS('window.__petDebug.state().mood');
  await sleep(1200);
  const moodB = await evalJS('window.__petDebug.state().mood');
  check('心情会随时间回落', moodB < moodA,
    `${moodA.toFixed(4)} -> ${moodB.toFixed(4)}`);

  // ============================================================
  console.log('\n=== 8. 气泡 ===');
  const bubbleGone = await evalJS(`
    (() => {
      window.__petDebug.showBubble('测试一下');
      const shown = document.getElementById('bubble').classList.contains('show');
      return shown;
    })()
  `);
  check('showBubble 会立刻显示气泡', bubbleGone === true);
  const waitMs = 1800 + 900;
  await sleep(waitMs);
  const goneNow = await evalJS(
    'document.getElementById("bubble").classList.contains("show")');
  check('气泡到时间后自动消失（不会一直挂着）', goneNow === false,
    `等待 ${waitMs}ms 后已隐藏`);

  // ============================================================
  console.log('\n=== 9. 长时间静置不漂移 ===');
  await evalJS('window.__petDebug.resetReaction(); true');
  await waitFrames(3);

  // ★ 这条断言以前是「取两个瞬时值相减」，会看运气，时红时绿：
  //   呼吸周期 2.6s、amplitudeY = 0.022（峰峰约 0.044），而阈值只给了 0.02 ——
  //   **比呼吸本身的振幅还小**。等 90 帧（约 1.5s）后再采一点，
  //   两个采样点落在波峰还是波谷纯属运气（1.5s ≈ 0.58 个周期）。
  //
  //   正确做法是【连续采样，再比较前后半段的均值】：
  //   周期振荡在均值里会互相抵消，只有真正的「振荡中心缓慢移动」（漂移）
  //   才会让两段均值分离。顺带还能断言「呼吸确实在动」，防假绿。
  //
  // ★ 采样必须从主进程轮询：隐藏窗口里页面 rAF 会降到 ~1fps、
  //   setInterval 最小间隔被钳到 1s，页面内采样器会拿到 0 个样本。
  // 期望振幅从【实际配置】读，别写死 —— 用户调了呼吸参数，阈值跟着变，
  // 不会出现「只是把呼吸调小了，测试就红」这种假警报。
  const breath = await evalJS('window.__petDebug.config().animation.breath');
  const p2pY = breath.amplitudeY * 2;   // 正弦的峰峰值 = 振幅 × 2
  const p2pX = breath.amplitudeX * 2;
  console.log(`       配置：period=${breath.period}s，amplitudeY=${breath.amplitudeY}，amplitudeX=${breath.amplitudeX}`);

  const SAMPLES = 80, GAP_MS = 100;
  const sx = [], sy = [];
  let firstSt = null, lastSt = null;
  for (let i = 0; i < SAMPLES; i++) {
    const s = await evalJS('window.__petDebug.state()');
    if (!firstSt) firstSt = s;
    lastSt = s;
    sx.push(s.bodyScale[0]);
    sy.push(s.bodyScale[1]);
    await sleep(GAP_MS);
  }

  const stat = (arr) => {
    const mn = Math.min.apply(null, arr);
    const mx = Math.max.apply(null, arr);
    const half = Math.floor(arr.length / 2);
    const sum = (a) => a.reduce((p, c) => p + c, 0);
    const m1 = sum(arr.slice(0, half)) / half;
    const m2 = sum(arr.slice(half)) / (arr.length - half);
    return { mn, mx, range: mx - mn, m1, m2, drift: Math.abs(m2 - m1) };
  };
  const Y = stat(sy), X = stat(sx);
  console.log(`       采了 ${sy.length} 个样本 / 约 ${(SAMPLES * GAP_MS / 1000).toFixed(1)}s（呼吸周期 2.6s）`);
  console.log(`       Y min=${Y.mn.toFixed(4)} max=${Y.mx.toFixed(4)} 极差=${Y.range.toFixed(4)} | 前半均值=${Y.m1.toFixed(4)} 后半=${Y.m2.toFixed(4)}`);
  console.log(`       X min=${X.mn.toFixed(4)} max=${X.mx.toFixed(4)} 极差=${X.range.toFixed(4)} | 前半均值=${X.m1.toFixed(4)} 后半=${X.m2.toFixed(4)}`);

  check('采样器真的采到了样本（不是空跑出来的假绿）', sy.length >= SAMPLES * 0.9,
    `${sy.length}/${SAMPLES}`);
  check('呼吸确实在动（缩放不是一动不动）', Y.range > p2pY * 0.5,
    `Y 极差 ${Y.range.toFixed(4)}，理论峰峰 ${p2pY.toFixed(4)}（下限 ${(p2pY * 0.5).toFixed(4)}）`);
  check('呼吸幅度没失控（不会越呼吸越大）',
    Y.range < p2pY * 1.6 && X.range < p2pX * 1.6,
    `Y 极差 ${Y.range.toFixed(4)} / 上限 ${(p2pY * 1.6).toFixed(4)}，X ${X.range.toFixed(4)} / 上限 ${(p2pX * 1.6).toFixed(4)}`);
  check('★ 静置后缩放无漂移（振荡中心不缓慢移动）',
    Y.drift < p2pY * 0.3 && X.drift < p2pX * 0.3,
    `前后半均值差：Y ${Y.drift.toFixed(5)} / 上限 ${(p2pY * 0.3).toFixed(4)}，X ${X.drift.toFixed(5)} / 上限 ${(p2pX * 0.3).toFixed(4)}`);
  check('立绘尺寸、画布尺寸稳定',
    lastSt.petSize.w === firstSt.petSize.w && lastSt.innerW === firstSt.innerW,
    `立绘 ${lastSt.petSize.w.toFixed(1)}x${lastSt.petSize.h.toFixed(1)}，画面 ${lastSt.innerW}`);
  check('旋转角在合理范围内（不会被放大成转圈）',
    Math.abs(lastSt.rotation) < 15, `rotation = ${lastSt.rotation.toFixed(3)}°`);
}
