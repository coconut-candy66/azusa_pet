// ============================================================
// tests/smoke/visual-check.js —— 真机启动 + 截图验证（2D 版）
//
// 跑法：npm run smoke
//
// 它和别的测试不一样的地方：
//   前面那些测试都是「读数值断言」，你看不到画面。
//   这个脚本会真的把应用跑起来，然后在几个关键时刻截图存到
//   screenshots/ 目录，让你用眼睛确认「画面到底对不对」。
//
// ★ 为什么数值测试之外还必须要有它？
//   这个教训是从 3D 版带过来的：那次数值断言全绿，
//   但截图一看，嘴巴被身体整个吞掉了、气泡压在调试面板上。
//   坏掉的都是【空间关系】，只有渲染出来才看得见。
//
// 截图时机：
//   01-idle              静置，看小人本体
//   02-hover-hit         光标放到她身上，看 HUD 变成「立绘上（接收）」
//   03-poke              刚点完，看压扁 + 气泡
//   04-dragging          拖拽途中
//   05-after-drag        松手之后
//   06-transparent-raw   不带背景的裸图，用来做透明度像素统计
//   07-hit-mask          命中判定范围可视化（半透明红）
//
// 为什么截图前要临时铺一层背景？
//   窗口本身透明，直接截图在图片查看器里通常显示成大黑块，看不出东西。
//   所以截图前临时给 html/body 加个渐变背景（只影响截图，
//   不碰渲染逻辑、不碰交互），截完立刻移除。
// ============================================================

const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// 无显卡环境走软件渲染
app.commandLine.appendSwitch('use-gl', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('no-sandbox');

// 加载真实的主进程
const appModule = require('../../main.js');

const SHOT_DIR = path.join(__dirname, '..', '..', 'screenshots');
// screenshots/ 是运行产物、未纳入版本控制，clone 之后该目录可能不存在。
// recursive:true 在目录已存在时也不会报错。
fs.mkdirSync(SHOT_DIR, { recursive: true });
const BACKDROP =
  'html,body{background:linear-gradient(160deg,#eef3f9 0%,#cfdbea 55%,#b3c4da 100%) !important;}';

const runtimeErrors = [];
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (_ev, level, message, line, sourceId) => {
    if (level >= 3) runtimeErrors.push(`${message}  (${sourceId}:${line})`);
  });
  wc.on('render-process-gone', (_ev, details) => {
    console.log('[渲染进程崩溃]', JSON.stringify(details));
    failed++;
  });
});

let failed = 0;
function check(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (detail) console.log(`       ${detail}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    await runSmoke();
  } catch (err) {
    console.log('\n[脚本异常]', err && err.message);
    if (err && err.stack) console.log(err.stack);
    // ★ 脚本半路抛异常时，之前收集到的渲染层报错一定要打出来 ——
    //   否则「页面自己报的错」会被「脚本挂了」这件事盖住，白跑一趟。
    //   （踩过：渲染层第 0 帧就抛错，而报告里只看到「脚本异常」。）
    if (runtimeErrors.length) {
      console.log('[渲染进程之前的报错]');
      runtimeErrors.forEach((s) => console.log(`  ${s}`));
    }
    failed++;
  }
  console.log('');
  console.log(failed === 0 ? '全部通过' : `${failed} 项失败`);
  console.log(`截图目录：${SHOT_DIR}`);
  app.exit(failed === 0 ? 0 : 1);
});

function saveShot(img, name) {
  const file = path.join(SHOT_DIR, name);
  fs.writeFileSync(file, img.toPNG());
  const size = img.getSize();
  console.log(`       -> ${name}  (${size.width}x${size.height})`);
  return file;
}

// ------------------------------------------------------------
// 扫描命中区域。不硬编码坐标 —— 现场扫一遍，
// 这样以后改摆位、换素材，这段也不会失效。
//
// 顺便把整张「命中图」也带回来：它能同时回答两件事 ——
//   1. 人到底在不在画面里
//   2. 判定是贴合轮廓的，还是退化成了一个大矩形
// 第二件事光看「有没有命中」是看不出来的，必须看形状。
// ------------------------------------------------------------
const SCAN = `
  (() => {
    const w = window.innerWidth, h = window.innerHeight;
    const xs = [], ys = [];
    const grid = [];
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
    if (!xs.length) return null;
    const gw = grid[0].length, gh = grid.length;
    let filled = 0;
    for (const r of grid) for (const v of r) filled += v;
    return {
      cx: Math.round((Math.min(...xs) + Math.max(...xs)) / 2),
      cy: Math.round((Math.min(...ys) + Math.max(...ys)) / 2),
      x0: Math.min(...xs), x1: Math.max(...xs),
      y0: Math.min(...ys), y1: Math.max(...ys),
      winW: w, winH: h, gw, gh, filled,
      // 命中格占整个网格的比例。人形轮廓大概 20~45%；
      // 如果接近 100%，说明退化成了矩形判定，那就白做了。
      ratio: filled / (gw * gh),
    };
  })()
`;

async function runSmoke() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  let win = null;
  for (let i = 0; i < 80; i++) {
    win = appModule.getWindow();
    if (win && !win.webContents.isLoading()) break;
    await sleep(200);
  }
  if (!win) throw new Error('main.js 没有创建窗口');
  await sleep(1800);

  const evalJS = (expr) => win.webContents.executeJavaScript(expr);

  // ------------------------------------------------------------
  console.log('\n=== 0. 渲染层就绪 ===');
  const st0 = await evalJS('window.__petDebug.state()');
  check('渲染层已就绪（动画循环在跑）',
    typeof st0.frames === 'number' && st0.frames > 0,
    `已渲染 ${st0.frames} 帧，画面 ${st0.innerW}x${st0.innerH}，dpr ${st0.dpr}`);
  check('立绘模式明确（矢量 / 贴图）',
    st0.mode === 'vector' || st0.mode === 'sprite',
    `mode = ${st0.mode}；${st0.spriteLoadNote}`);

  // 矢量模式要真的画出东西来。
  // 这一条是补的：命中判定是纯数学，不看画面，
  // 所以「小人一个像素都没画」这种事它能一路绿灯。
  if (st0.mode === 'vector') {
    const svgInfo = await evalJS(`
      (() => {
        const v = document.getElementById('vector');
        const cs = getComputedStyle(v);
        return {
          display: cs.display,
          opacity: cs.opacity,
          nodes: v.querySelectorAll('path, ellipse, rect, circle, g').length,
          parts: ['#v-eye-l', '#v-eye-r', '#v-mouth-idle', '#v-eyes-open', '#v-eyes-happy']
            .filter((s) => v.querySelector(s)).length,
          w: v.style.width, h: v.style.height,
        };
      })()
    `);
    check('★ 矢量小人真的可见（display 是打开的，不是空壳）',
      svgInfo.display !== 'none' && parseFloat(svgInfo.opacity) > 0.9 && svgInfo.w !== '' ,
      `display=${svgInfo.display}, opacity=${svgInfo.opacity}, 尺寸 ${svgInfo.w}x${svgInfo.h}`);
    check('★ 矢量小人画出了五官（眼睛 / 嘴这些节点存在）',
      svgInfo.nodes >= 15 && svgInfo.parts === 5,
      `${svgInfo.nodes} 个图形节点，5 个关键部件里找到 ${svgInfo.parts} 个`);
  }
  console.log(`       立绘尺寸 ${st0.petSize.w.toFixed(1)}x${st0.petSize.h.toFixed(1)}，` +
    `锚点 (${st0.anchor.x.toFixed(1)}, ${st0.anchor.y.toFixed(1)})`);

  // 帧要继续涨才算活着
  await evalJS('window.__waitFrames = true; true').catch(() => {});
  const f1 = await evalJS('window.__petDebug.state().frames');
  await sleep(500);
  const f2 = await evalJS('window.__petDebug.state().frames');
  check('动画循环持续推进（不是卡在第一帧）', f2 > f1, `${f1} -> ${f2}`);

  // ------------------------------------------------------------
  console.log('\n=== 1. 静置状态 ===');
  const cssKey = await win.webContents.insertCSS(BACKDROP);
  await sleep(300);
  saveShot(await win.webContents.capturePage(), '01-idle.png');

  // ------------------------------------------------------------
  console.log('\n=== 2. 命中判定（光标落在她身上）===');
  const probe = await evalJS(SCAN);
  if (!probe) throw new Error('扫描不到任何命中区域，立绘可能没有渲染出来');

  console.log(`       命中区域 x ${probe.x0}-${probe.x1}, y ${probe.y0}-${probe.y1}，中心 (${probe.cx}, ${probe.cy})`);
  console.log(`       命中格占网格 ${(probe.ratio * 100).toFixed(1)}%（${probe.filled}/${probe.gw * probe.gh}）`);

  check('能扫到命中区域（她确实在画面里，而且能被点到）',
    probe.filled > 0, `命中网格 ${probe.filled} 个`);

  // ★ 这条是 2D 版专属、也最重要的一条：
  //   如果判定退化成矩形，命中格占比会接近 100%。
  //   人形轮廓应该明显小于矩形。
  check('★ 命中判定是人形轮廓，不是一个大矩形',
    probe.ratio < 0.8,
    `命中格占比 ${(probe.ratio * 100).toFixed(1)}%（矩形判定会接近 100%）`);

  // 包围盒的四个角必须是「打不中」的 —— 人形不可能填满矩形
  const corners = await evalJS(`
    (() => {
      const pts = [
        [${probe.x0 + 2}, ${probe.y0 + 2}], [${probe.x1 - 2}, ${probe.y0 + 2}],
        [${probe.x0 + 2}, ${probe.y1 - 2}], [${probe.x1 - 2}, ${probe.y1 - 2}],
      ];
      return pts.map(([x, y]) => {
        window.__petDebug.setMouse(x, y);
        window.__petDebug.hitTestNow();
        return window.__petDebug.state().isCurrentlyHit;
      });
    })()
  `);
  const cornerHits = corners.filter(Boolean).length;
  check('★ 包围盒四角都是「未命中」（证明判定贴合轮廓）',
    cornerHits === 0,
    `四个角命中 ${cornerHits} 个：${JSON.stringify(corners)}`);

  await evalJS(`window.__petDebug.setMouse(${probe.cx}, ${probe.cy}); window.__petDebug.hitTestNow(); false`);
  await sleep(250);
  const hitState = await evalJS('window.__petDebug.state().isCurrentlyHit');
  const hudText = await evalJS('document.getElementById("hitState").textContent');
  check('光标落在她身上时判定为「命中」', hitState === true, `HUD 显示：${hudText}`);
  saveShot(await win.webContents.capturePage(), '02-hover-hit.png');

  // 透明区一定要「打不中」，否则桌面就点不动了
  await evalJS('window.__petDebug.setMouse(6, window.innerHeight - 6); window.__petDebug.hitTestNow(); false');
  const missState = await evalJS('window.__petDebug.state().isCurrentlyHit');
  check('左下角空白区判定为「未命中」（能穿透到桌面）', missState === false);

  // ------------------------------------------------------------
  console.log('\n=== 3. 点击反应 ===');
  // ★ 这里的行为现在由配置决定（reaction.pokeSquash / pokeBubble）：
  //   本项目这一版按需求把它们关掉了 —— 点一下只【换立绘】。
  //   所以断言不能硬编码「必须有形变和气泡」，而要：
  //     配置开了 -> 必须观察到形变/气泡
  //     配置关了 -> 必须【没有】形变/气泡，而且必须换了立绘
  //   两边都管住，才算真的验证了「开关生效」。
  //   （老写法是 check(name, true, ...) 硬编码真值那种假断言的反面：
  //     它至少能红。但硬编码「必须有」会让关掉开关的合法配置报假红。）
  const pokeCfg = await evalJS('window.__petDebug.config().reaction');
  const outfitBefore = await evalJS('window.__petDebug.outfit()');
  await evalJS('window.__petDebug.poke(); false');
  await sleep(420);            // 换装要读 5 个文件，多等一会儿
  const rAtShot = await evalJS('window.__petDebug.state().reaction');
  const moodAtShot = await evalJS('window.__petDebug.state().mood');
  const bubbleShown = await evalJS(
    'document.getElementById("bubble").classList.contains("show")');
  const bubbleText = await evalJS('document.getElementById("bubble").textContent');
  await evalJS('window.__petDebug.idle()');        // 等换装完成
  const outfitAfter = await evalJS('window.__petDebug.outfit()');
  saveShot(await win.webContents.capturePage(), '03-poke.png');
  console.log(`       截图时 reaction = ${JSON.stringify(rAtShot)}`);
  console.log(`       立绘：${outfitBefore.name} -> ${outfitAfter.name}`);

  if (pokeCfg.pokeSquash !== false) {
    check('点击后触发了形变反应（配置里开着 pokeSquash）',
      rAtShot.squash > 0.05 || rAtShot.jump > 0.05,
      `squash=${rAtShot.squash.toFixed(3)}, jump=${rAtShot.jump.toFixed(3)}`);
  } else {
    check('★ 配置关掉 pokeSquash 后，点击不再产生形变（如实执行配置）',
      rAtShot.squash < 0.05 && rAtShot.jump < 0.05,
      `squash=${rAtShot.squash.toFixed(3)}, jump=${rAtShot.jump.toFixed(3)}（都该接近 0）`);
  }

  if (pokeCfg.pokeBubble !== false) {
    check('点击后有对话气泡（配置里开着 pokeBubble）',
      bubbleShown === true, `文案：${bubbleText}`);
  } else {
    check('★ 配置关掉 pokeBubble 后，点击不再冒气泡',
      bubbleShown === false, `气泡 show = ${bubbleShown}`);
  }

  check('点击让心情值上升（第⑤步状态机雏形）', moodAtShot > 0,
    `mood = ${moodAtShot.toFixed(3)}`);

  // ★★ 这一条是本轮新增功能的核心验证：点一下必须换一套立绘。
  check('★★ 每点一下换一套立绘（换装功能生效）',
    outfitAfter.name !== outfitBefore.name && outfitAfter.name !== '',
    `点击前 ${outfitBefore.name} -> 点击后 ${outfitAfter.name}`);

  // ★ 回归检查（3D 版踩过的坑）：气泡不能压住左上角调试面板
  const overlap = await evalJS(`
    (() => {
      const b = document.getElementById('bubble').getBoundingClientRect();
      const h = document.getElementById('hud').getBoundingClientRect();
      const hit = !(b.right < h.left || b.left > h.right || b.bottom < h.top || b.top > h.bottom);
      return { hit,
        bubble: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)],
        hud: [Math.round(h.left), Math.round(h.top), Math.round(h.right), Math.round(h.bottom)] };
    })()
  `);
  check('★ 对话气泡与左上角面板不重叠',
    overlap.hit === false,
    `气泡 [${overlap.bubble}] vs 面板 [${overlap.hud}]`);

  // ★ 回归检查（3D 版踩过的坑）：压扁时立绘不能跑出窗口
  //
  // 注意这里的写法：先确认拿到的是一个【有面积的】矩形。
  // 一开始我没做这一步，结果立绘因为 display:none 没画出来时，
  // getBoundingClientRect() 返回全 0，断言「0 >= -2 且 0 <= 402」照样 PASS ——
  // 一个在「什么都没有」的情况下也会通过的断言，等于没写。
  const inside = await evalJS(`
    (() => {
      const s = document.getElementById('sprite');
      const v = document.getElementById('vector');
      const vis = getComputedStyle(s).display !== 'none' ? s : v;
      const b = vis.getBoundingClientRect();
      return {
        which: vis.id,
        body: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)],
        bw: Math.round(b.width), bh: Math.round(b.height),
        win: [window.innerWidth, window.innerHeight],
      };
    })()
  `);
  check('★ 立绘元素真的占了面积（不是 display:none 的空壳）',
    inside.bw > 40 && inside.bh > 60,
    `${inside.which} 尺寸 ${inside.bw}x${inside.bh}`);
  check('★ 立绘没有被窗口切掉（头顶和脚都完整）',
    inside.bw > 40 && inside.bh > 60 &&
    inside.body[1] >= -2 && inside.body[3] <= inside.win[1] + 2,
    `${inside.which} y ${inside.body[1]}~${inside.body[3]}，窗口高 ${inside.win[1]}`);

  // ------------------------------------------------------------
  console.log('\n=== 4. 拖拽途中 ===');
  const b0 = win.getBounds();
  global.__deskpetTestCursor = { x: b0.x + 170, y: b0.y + 200 };
  ipcMain.emit('drag-start', {});
  await sleep(150);

  const sizes = [];
  for (let i = 1; i <= 24; i++) {
    global.__deskpetTestCursor = { x: b0.x + 170 - i * 6, y: b0.y + 200 - i * 2 };
    await sleep(22);
    if (i % 6 === 0) sizes.push(win.getBounds());
  }
  await sleep(400);
  saveShot(await win.webContents.capturePage(), '04-dragging.png');

  const bEnd = win.getBounds();
  check('拖拽时窗口跟随光标（向左上移动了）',
    bEnd.x < b0.x - 100 && bEnd.y < b0.y - 20,
    `(${b0.x}, ${b0.y}) -> (${bEnd.x}, ${bEnd.y})`);
  check('★ 拖拽途中窗口尺寸恒定（没有越拖越大）',
    sizes.every((s) => s.width === sizes[0].width && s.height === sizes[0].height),
    `尺寸采样：${[...new Set(sizes.map((s) => `${s.width}x${s.height}`))].join(', ')}`);

  ipcMain.emit('drag-end', {});
  global.__deskpetTestCursor = null;
  await sleep(300);
  saveShot(await win.webContents.capturePage(), '05-after-drag.png');

  const stEnd = await evalJS('window.__petDebug.state()');
  check('★ 拖拽后立绘缩放仍在 1.0 附近（无累积放大）',
    Math.abs(stEnd.bodyScale[0] - 1) < 0.12 && Math.abs(stEnd.bodyScale[1] - 1) < 0.12,
    `scale = [${stEnd.bodyScale.map((n) => n.toFixed(4)).join(', ')}]`);
  check('★ 缩放值没有变成 NaN / Infinity',
    Number.isFinite(stEnd.bodyScale[0]) && Number.isFinite(stEnd.bodyScale[1]) &&
    Number.isFinite(stEnd.rotation),
    `scale=[${stEnd.bodyScale.map((n) => n.toFixed(4))}], rot=${stEnd.rotation.toFixed(3)}`);

  // ------------------------------------------------------------
  console.log('\n=== 5. ★ 透明性像素级验证 ===');
  win.webContents.removeInsertedCSS(cssKey);
  await evalJS('window.__petDebug.setMouse(5, 5); window.__petDebug.hitTestNow(); false');
  // ★ 从这里开始冻结时间轴，一直到第 7 步算完。
  //   下面 06（立绘）和 07（命中遮罩）两张图要做逐像素比对，
  //   而小人一直在呼吸摇摆 —— 不冻住的话两次采样姿态不同，
  //   比对结果里全是「假的没盖住」。详见 renderer.js 里 paused 的注释。
  await evalJS('window.__petDebug.setPaused(true); false');
  await sleep(400);

  const raw = await win.webContents.capturePage();
  saveShot(raw, '06-transparent-raw.png');

  // capturePage 给的是 BGRA，每 4 字节一个像素，第 4 个是 alpha
  const bmp = raw.toBitmap();
  const total = Math.floor(bmp.length / 4);
  let fullyTransparent = 0;
  let fullyOpaque = 0;
  for (let i = 3; i < bmp.length; i += 4) {
    const a = bmp[i];
    if (a < 16) fullyTransparent++;
    else if (a > 240) fullyOpaque++;
  }
  const tp = (fullyTransparent / total) * 100;
  const op = (fullyOpaque / total) * 100;
  console.log(`       总像素 ${total}，全透明 ${tp.toFixed(1)}%，全不透明 ${op.toFixed(1)}%`);

  check('★ 窗口大部分区域是真正透明的（桌宠能浮在桌面上）',
    tp > 55, `全透明像素占比 ${tp.toFixed(1)}%`);
  check('★ 立绘区域是不透明的（不是全透明空窗口）',
    op > 5, `全不透明像素占比 ${op.toFixed(1)}%`);

  // ★ 这条才是「有没有一块不该有的底板」的真正证明。
  //
  //   只统计「不透明占比」是不够的：0.1% 和 30% 都「> 3%」，
  //   一条画满整窗的灰底板会让它轻松通过。
  //   而四个角是最诚实的地方 —— 人形桌宠的四角一定什么都不是。
  //   有一处不透明，就说明有东西铺到了那儿。
  const SW = raw.getSize().width, SH = raw.getSize().height;
  const alphaAt = (x, y) => bmp[(y * SW + x) * 4 + 3];
  const ca = {
    tl: alphaAt(2, 2), tr: alphaAt(SW - 3, 2),
    bl: alphaAt(2, SH - 3), br: alphaAt(SW - 3, SH - 3),
  };
  check('★ 四个角都是全透明的（没有任何底板铺到边角）',
    ca.tl < 16 && ca.tr < 16 && ca.bl < 16 && ca.br < 16,
    `alpha 左上=${ca.tl} 右上=${ca.tr} 左下=${ca.bl} 右下=${ca.br}`);

  // 不透明像素的包围盒也不该接近整窗 —— 那是底板的另一个特征
  let oMinX = SW, oMaxX = -1, oMinY = SH, oMaxY = -1;
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      if (alphaAt(x, y) > 240) {
        if (x < oMinX) oMinX = x;
        if (x > oMaxX) oMaxX = x;
        if (y < oMinY) oMinY = y;
        if (y > oMaxY) oMaxY = y;
      }
    }
  }
  const obw = oMaxX - oMinX + 1, obh = oMaxY - oMinY + 1;
  console.log(`       不透明包围盒 ${obw}x${obh}（窗口 ${SW}x${SH}）`);
  check('★ 不透明区域没有铺满窗口（排除整块底板）',
    obw < SW * 0.95 || obh < SH * 0.95,
    `包围盒 ${obw}x${obh}，宽占 ${(obw / SW * 100).toFixed(1)}% 高占 ${(obh / SH * 100).toFixed(1)}%`);

  // ------------------------------------------------------------
  console.log('\n=== 6. 命中判定范围可视化 ===');
  // ★ 这一段原来是个【假断言】，值得记一笔：
  //   旧写法是「先给 canvas 加 .on class，再调用 redrawHitMask()」，
  //   但 drawHitMask() 第一行做的是「开关没开就把 .on 摘掉然后 return」
  //   —— 等于把刚加上去的 class 又摘了，什么都没画。
  //   而断言写的是 check(name, true, ...)，硬编码 true，永远不会失败。
  //   于是「07-hit-mask.png 里红色区域就是点了会有反应的范围」这句
  //   PASS 一直挂着，图里其实空无一物。
  //
  //   现在两头都补上：走运行时开关（不用刷新页面），
  //   并且真的数一遍红色像素（见下一步）。
  await evalJS(`(() => { window.__petDebug.setHitMaskVisible(true); return true; })()`);
  await sleep(300);
  const maskShot = await win.webContents.capturePage();
  saveShot(maskShot, '07-hit-mask.png');

  // 遮罩是 rgba(220,40,40,0.42)：红通道明显高于绿蓝。
  // 阈值取 1.35 倍而不是更严，是因为红色叠在肤色上时三通道会被拉近；
  // 而肤色本身 (248,216,192) 过不了 1.35 倍这一关，不会被误判成红。
  const countRed = (buf) => {
    let n = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const b = buf[i], g = buf[i + 1], r = buf[i + 2], a = buf[i + 3];
      if (a > 40 && r > 60 && r > g * 1.35 && r > b * 1.35) n++;
    }
    return n;
  };
  const mbmp = maskShot.toBitmap();
  const mtotal = Math.floor(mbmp.length / 4);
  const baseRed = countRed(bmp);      // 第 5 步那张，没开遮罩
  const maskRed = countRed(mbmp);
  const gained = ((maskRed - baseRed) / mtotal) * 100;
  const rp = (maskRed / mtotal) * 100;
  console.log(`       红色像素 ${baseRed} -> ${maskRed}（占窗口 ${rp.toFixed(1)}%，` +
              `净增 ${gained.toFixed(1)}%）`);

  check('★ 打开遮罩后红色区域明显变大（遮罩真的画出来了，不是空图）',
    gained > 5, `净增 ${gained.toFixed(1)}%（领结和鞋子本身自带一点红，所以看净增）`);
  check('★ 遮罩没有糊满整个窗口（判定没退化成满屏矩形）',
    rp < 60, `红色占窗口 ${rp.toFixed(1)}%`);

  // ------------------------------------------------------------
  console.log('\n=== 7. ★ 命中区域是否盖住了立绘 ===');
  //
  // 为什么要单独有这么一条：
  //   前面那些断言（命中占比 27.7%、包围盒四角不命中、光标在身上算命中）
  //   全都【发现不了「漏掉一块」】—— 「漏掉一条胳膊」和「判定贴合轮廓」
  //   在这些数字上长得一模一样。
  //   事实就是：最早那版把身体、胳膊、裙子全用椭圆近似，而它们画出来
  //   是矩形和梯形，椭圆在四角天然盖不到 —— 肩膀、胳膊外侧、裙摆两角
  //   点下去直接穿到桌面。而当时所有断言都是绿的。
  //   真能发现它的做法只有一个：拿立绘的不透明像素去比对命中区域。
  //
  // 为什么要先扣掉左上角那块调试面板：
  //   那是 DOM 元素，在截图上同样是「不透明像素」，但它不属于小人。
  //   不扣掉的话它会被算成一整块漏掉的区域（每行 250px、100% 漏）。
  //   这也算个教训：像素统计里混进 UI 元素，数字会变得没法解释。
  const hudBox = await evalJS(`
    (() => {
      const el = document.getElementById('hud');
      if (!el || getComputedStyle(el).display === 'none') return null;
      const r = el.getBoundingClientRect();
      return { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
    })()
  `);

  const mSW = maskShot.getSize().width, mSH = maskShot.getSize().height;
  // getBoundingClientRect 是 CSS 像素，截图是物理像素，要按比例换算
  const kx = mSW / (await evalJS('window.innerWidth')),
        ky = mSH / (await evalJS('window.innerHeight'));
  const hud = hudBox
    ? {
      x0: Math.floor(hudBox.x0 * kx) - 2, y0: Math.floor(hudBox.y0 * ky) - 2,
      x1: Math.ceil(hudBox.x1 * kx) + 2, y1: Math.ceil(hudBox.y1 * ky) + 2,
    }
    : null;
  const inHud = (x, y) =>
    !!hud && x >= hud.x0 && x <= hud.x1 && y >= hud.y0 && y <= hud.y1;

  const artAlphaAt = (x, y) => bmp[(y * SW + x) * 4 + 3];

  // ★ 覆盖率的尺子要用 hitRaster()（逐点问真实的 hitTest），
  //   不要用 07 那张图上的红色像素。
  //   07 是「给人看的可视化」，格子有 7x5 像素粗，边界会漏半格；
  //   拿它量覆盖率，量到的是可视化的分辨率，不是判定本身。
  //   （这个项目已经因为「代理指标」吃过一次亏了，见上面第 6 步。）
  const raster = await evalJS('window.__petDebug.hitRaster(1)');
  const rbits = Buffer.from(raster.bits, 'base64');

  // ★ 诊断：把「此刻是哪一套、摆在哪、脚底在哪」打出来。
  //   覆盖率一旦掉了，先要知道掉的是哪一套、以及它该在哪 ——
  //   否则只能靠猜（这个项目已经因为「不打印中间量」白查过一轮）。
  const geo = await evalJS(`
    (() => {
      const st = window.__petDebug.state();
      const s = document.getElementById('sprite');
      const r = s.getBoundingClientRect();
      return {
        outfit: window.__petDebug.outfit().name,
        petSize: st.petSize, anchor: st.anchor,
        spriteRect: { l: r.left, t: r.top, r: r.right, b: r.bottom },
        natural: [s.naturalWidth, s.naturalHeight],
        mask: st.maskInfo,
        innerW: window.innerWidth, innerH: window.innerHeight,
        dpr: window.devicePixelRatio,
      };
    })()
  `);
  console.log(`       当次套=${geo.outfit}  素材 ${geo.natural[0]}x${geo.natural[1]}`);
  console.log(`       立绘 ${geo.petSize.w.toFixed(1)}x${geo.petSize.h.toFixed(1)} CSSpx，` +
    `锚点 (${geo.anchor.x.toFixed(1)}, ${geo.anchor.y.toFixed(1)})  窗口 ${geo.innerW}x${geo.innerH} dpr=${geo.dpr}`);
  console.log(`       立绘盒 left=${geo.spriteRect.l.toFixed(1)} top=${geo.spriteRect.t.toFixed(1)} ` +
    `right=${geo.spriteRect.r.toFixed(1)} bottom=${geo.spriteRect.b.toFixed(1)}`);
  console.log(`       遮罩 ${geo.mask.w}x${geo.mask.h} ok=${geo.mask.ok}`);
  const shotH = maskShot.getSize().height, shotW = maskShot.getSize().width;
  console.log(`       截图 ${shotW}x${shotH}物理px，ky=${ky.toFixed(4)} ` +
    `(立绘底边对应物理 y=${(geo.spriteRect.b * ky).toFixed(1)})`);
  const rAt = (cx, cy) => {
    const c = Math.floor(cx / raster.step), r = Math.floor(cy / raster.step);
    if (c < 0 || r < 0 || c >= raster.cols || r >= raster.rows) return false;
    const i = r * raster.cols + c;
    return !!(rbits[i >> 3] & (128 >> (i & 7)));
  };
  console.log(`       命中栅格 ${raster.cols}x${raster.rows}（步长 ${raster.step}px），` +
              `命中点 ${raster.hits}`);

  // 两张截图理论上同尺寸，但窗口宽度在 125% 缩放下会差 1px（取整），
  // 一旦不一致，下面按行索引就会错位。取小的那个尺寸，并且报出来 ——
  // 静默错位比直接报错难查得多。
  const CW = Math.min(mSW, SW), CH = Math.min(mSH, SH);
  if (mSW !== SW || mSH !== SH) {
    console.log(`       ⚠ 两张截图尺寸不一致：立绘 ${SW}x${SH}，遮罩 ${mSW}x${mSH}` +
                ` —— 取较小的 ${CW}x${CH} 比对`);
  }

  // 容差 2 个物理像素 ≈ 1.6 个 CSS 像素（dpr 1.25）：
  // 立绘边缘抗锯齿、以及栅格采样点的取整都在这一档内。
  const TOL = 2;
  let artTotal = 0, artMiss = 0;
  const missRows = [];
  for (let y = 0; y < CH; y++) {
    let rowArt = 0, rowMiss = 0;
    for (let x = 0; x < CW; x++) {
      if (artAlphaAt(x, y) <= 200) continue;
      if (inHud(x, y)) continue;
      artTotal++;
      rowArt++;
      let covered = false;
      for (let dy = -TOL; dy <= TOL && !covered; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= CH) continue;
        for (let dx = -TOL; dx <= TOL; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= CW) continue;
          // 物理像素 -> CSS 像素（栅格是按 CSS 像素采样的）
          if (rAt(xx / kx, yy / ky)) { covered = true; break; }
        }
      }
      if (!covered) { artMiss++; rowMiss++; }
    }
    if (rowArt >= 12 && rowMiss / rowArt > 0.15) missRows.push(`${y}(${rowMiss}/${rowArt})`);
  }
  const cover = 100 - (artMiss * 100) / Math.max(artTotal, 1);
  console.log(`       立绘不透明像素（已扣除调试面板）${artTotal}，未被命中区域覆盖 ${artMiss}`);
  console.log(`       覆盖率 ${cover.toFixed(1)}%`);
  if (missRows.length) {
    console.log(`       漏得比较多的行(y(漏/总)): ${missRows.slice(0, 8).join(' ')}${
      missRows.length > 8 ? ` ... 共 ${missRows.length} 行` : ''}`);
  }

  check('★ 命中区域盖住了立绘（点她身上任何一处都该有反应）',
    cover >= 97,
    `覆盖率 ${cover.toFixed(1)}%（漏掉的都是「点下去穿到桌面」的地方）`);

  // 反向也要管住：判定区域【过于胖】是另一种坏。
  // 那种情况下桌宠周围一大圈空气都点不动，桌面被「偷」走了，
  // 而「盖住立绘」这条断言反而更容易通过 —— 只有看反方向才拦得住。
  const artCss = artTotal / (kx * ky);      // 立绘面积，换算回 CSS 像素
  const fat = raster.hits / Math.max(artCss, 1);
  console.log(`       命中面积 ${raster.hits} px²，立绘面积约 ${Math.round(artCss)} px²，` +
              `比值 ${fat.toFixed(2)}`);
  check('★ 命中区域没有比立绘胖太多（别把周围桌面也吃掉）',
    fat < 1.8, `命中面积是立绘的 ${fat.toFixed(2)} 倍（留点余量是好事，1.8 倍以上就是在吃桌面了）`);

  // 收尾：关掉遮罩、恢复时间轴
  await evalJS(`(() => { window.__petDebug.setHitMaskVisible(false); return true; })()`);
  await evalJS('window.__petDebug.setPaused(false); false');

  // ------------------------------------------------------------
  console.log('\n=== 8. 取消暂停后动画要真的恢复 ===');
  // 光断言「暂停生效」不够 —— 万一 setPaused(false) 没把状态还原，
  // 桌宠会永远停在那一帧，而测试还是绿的。所以这里正反都验一遍。
  const fBefore = await evalJS('window.__petDebug.state().frames');
  await sleep(600);
  const fAfter = await evalJS('window.__petDebug.state().frames');
  check('★ 恢复后动画循环继续推进（没有被永久冻在那一帧）',
    fAfter > fBefore + 1, `${fBefore} -> ${fAfter}`);

  // ------------------------------------------------------------
  console.log('\n=== 9. 运行期没有报错 ===');
  check('渲染进程无控制台报错', runtimeErrors.length === 0,
    runtimeErrors.length === 0
      ? '全程 0 条错误'
      : runtimeErrors.map((s) => `  ${s}`).join('\n'));

  // ------------------------------------------------------------
  console.log('\n=== 10. ★★ 换装：连点多套后仍然正确 ===');
  //
  // 换装这件事有几个地方很容易「看着好像对、其实坏了」，
  // 而且它们都不会报错，只会表现成「点起来有点歪」：
  //   ① 贴图换了、遮罩没换 -> 用 A 套的轮廓判 B 套的命中，点起来偏一边
  //   ② 宽高比没跟着换     -> 立绘被拉扯变形（或没变，两种都是错的）
  //   ③ 连点太快互相覆盖   -> 最后可能是 A 的图 + B 的遮罩
  //
  // 所以这里连着点好几轮，每轮都把「图/遮罩/宽高比」三者对一遍。
  const pool = (await evalJS('window.__petDebug.outfit()')).pool;
  console.log(`       可换装 ${pool.length} 套`);
  check('换装列表读到了（至少 2 套才有得换）', pool.length >= 2,
    `outfits = ${JSON.stringify(pool)}`);

  const seen = [];
  let mismatch = 0;
  const ROUNDS = pool.length * 2;     // 连点两轮，覆盖「发牌 + 重洗」
  for (let i = 0; i < ROUNDS; i++) {
    const before = await evalJS('window.__petDebug.outfit()');
    const stateBefore = await evalJS('window.__petDebug.state()');
    await evalJS('window.__petDebug.switchOutfit(); false');
    await evalJS('window.__petDebug.idle()');
    await sleep(60);
    const after = await evalJS('window.__petDebug.outfit()');
    const stateAfter = await evalJS('window.__petDebug.state()');
    seen.push(after.name);

    // ① 必须真的换了（除非只有 1 套）
    if (pool.length >= 2 && after.name === before.name) {
      console.log(`       [第${i + 1}次] 没有换套：${after.name}`);
      mismatch++;
    }
    // ② 换完之后遮罩必须是 ok 的，而且分辨率要跟着新套变
    if (!stateAfter.maskInfo.ok) {
      console.log(`       [第${i + 1}次] 换到 ${after.name} 后遮罩不可用：` +
        `${stateAfter.maskInfo.error}`);
      mismatch++;
    }
    // ③ 宽高比必须等于素材真实比例（图/遮罩/layout 三者同源）
    const ratioOK = await evalJS(`
      (() => {
        const s = document.getElementById('sprite');
        const st = window.__petDebug.state();
        const real = s.naturalWidth / s.naturalHeight;
        return { real, pet: st.petSize.w / st.petSize.h,
                 diff: Math.abs(st.petSize.w / st.petSize.h - real) };
      })()
    `);
    if (!(ratioOK.diff < 0.02)) {
      console.log(`       [第${i + 1}次] ${after.name} 宽高比不符：` +
        `素材 ${ratioOK.real.toFixed(3)} vs 摆位 ${ratioOK.pet.toFixed(3)}`);
      mismatch++;
    }
  }
  console.log(`       连点 ${ROUNDS} 次，依次是：${seen.join(' -> ')}`);
  check('★★ 连点换装后「立绘 / 遮罩 / 宽高比」三者始终自洽',
    mismatch === 0, mismatch === 0 ? `${ROUNDS} 次全部一致` : `${mismatch} 处不一致`);

  // ------------------------------------------------------------
  // ★ 这条断言第一版写错了两次，值得记一笔：
  //
  //   第一次：`seen.slice(0, pool.length)` 当成「一轮」，有重复就红。
  //     —— 但牌堆在【第 3 步的 poke()】里已经抽掉一张了，
  //        第 10 步循环的第 1 次并不是「一轮的开头」。
  //
  //   第二次：改成「任意连续 n 次窗口内不重复」，还是红。
  //     —— 因为它把【轮次交界】也算进去了：
  //        `zh2,zh3,zh5,zh1,zh3` 这种序列是合法的 ——
  //        前 4 个是上一轮的尾巴，最后那个 zh3 是新一轮的第一张，
  //        新一轮当然可以再出现上一轮出现过的套。
  //
  //   用纯逻辑脚本（2000 轮）验过：牌堆算法本身 0 重复、
  //   20000 次抽牌 0 次抽到当前套。**算法是对的，是断言写错了。**
  //
  //   ★ 正确的判据：直接问牌堆本身 —— 「当前还没发出去的牌里有没有重复」。
  //     这才是「随机不重复」的精确定义，而且不依赖从哪个位置开始观察。
  //     再补一条「相邻两次必不同」，覆盖用户最直接的感受。
  // ------------------------------------------------------------
  const deck = await evalJS('window.__petDebug.deck()');
  const deckDup = deck.length - new Set(deck).size;
  console.log(`       牌堆剩 ${deck.length} 张：${deck.join(', ') || '（空）'}`);
  check('★★ 牌堆内没有重复的套（发牌保证不重复）',
    deckDup === 0,
    deckDup === 0 ? `剩余 ${deck.length} 张互不重复`
      : `牌堆里有 ${deckDup} 张重复`);

  // 另一面：一个完整轮次（pool.length 次连续点击）里不该有重复。
  // ★ 但【不能从外面按 pool.length 切窗口】—— 这是这条断言写错两次的根因。
  //   轮与轮的交界允许新一轮包含上一轮出现过的套，
  //   而从外部根本判断不出「哪一次点击是新一轮的第一张」。
  //   实测踩到的例子：zh3 在第 7 次和第 9 次各出现一次，
  //   间隔只有 2 —— 看着像「一轮里重复了」，其实第 9 次已经是新一轮。
  //   正解：让渲染层把【轮号】一起记下来，按轮分组校验。
  const hist = await evalJS('window.__petDebug.history()');
  const byRound = new Map();
  for (const h of hist) {
    if (!byRound.has(h.round)) byRound.set(h.round, []);
    byRound.get(h.round).push(h.name);
  }
  let roundDup = null;
  for (const [rn, names] of byRound) {
    if (new Set(names).size !== names.length) { roundDup = { rn, names }; break; }
  }
  console.log(`       换装历史按轮分组：${
    [...byRound].map(([r, ns]) => `R${r}[${ns.length}]`).join(' ')}`);
  check('★★ 每一轮之内每套只出现一次（随机不重复）',
    roundDup === null,
    roundDup === null
      ? `${byRound.size} 轮、共 ${hist.length} 次，每轮内都无重复`
      : `第 ${roundDup.rn} 轮内有重复：${roundDup.names.join(' -> ')}`);

  // 相邻两次一定不同 —— 这是用户最直接的感受：
  // 「点一下必须看得出来变了」，否则会以为程序坏了。
  let adjSame = 0;
  for (let i = 1; i < seen.length; i++) if (seen[i] === seen[i - 1]) adjSame++;
  check('★ 相邻两次点的必定不是同一套（点一下一定看得出变化）',
    adjSame === 0, adjSame === 0 ? '0 次连击' : `${adjSame} 次点到同一套`);

  // 换装之后再看看小人还在不在画面里、能不能点到
  const afterScan = await evalJS(SCAN);
  check('换装之后立绘仍然在画面里、能被点到',
    !!afterScan && afterScan.filled > 0,
    afterScan ? `命中网格 ${afterScan.filled} 个` : '扫不到命中区域');
  check('换装之后命中判定仍然是人形轮廓（没有退化成矩形）',
    !!afterScan && afterScan.ratio < 0.8,
    afterScan ? `命中格占比 ${(afterScan.ratio * 100).toFixed(1)}%` : '—');
}

// ------------------------------------------------------------
// 换装专项：这个函数单独跑，不依赖前面的截图流程，
// 方便以后只验换装时单独调用。
// ------------------------------------------------------------
async function verifyOutfitSwitch(evalJS) {
  const pool = (await evalJS('window.__petDebug.outfit()')).pool;
  return pool.length;
}
