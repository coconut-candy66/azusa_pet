// ============================================================
// tests/diagnostics/alpha-profile.js —— 「截图里到底画了什么」
//
// 跑法：node tests/diagnostics/alpha-profile.js（在主进程里跑 electron）
//
// 为什么需要它：
//   smoke 的像素统计只回答「透明占多少、不透明占多少」。
//   但如果有个东西在画一个不该画的大方块，那条断言照样会过 ——
//   0.1% 和 30% 的不透明都「> 3%」。
//
//   这个工具把不透明像素的【分布】打出来：
//     · 不透明像素的包围盒（如果它几乎等于整个窗口，那就是画了底板）
//     · 逐行剖面（人形应该是中间宽、两头窄；一个矩形会是上下等宽）
//     · 几个关键位置的实测 RGBA（直接看像素，不猜）
//
// 它是「用眼睛之外的办法看画面」的最后一道保险。
// ============================================================

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('use-gl', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('no-sandbox');

const appModule = require('../../main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    await run();
  } catch (e) {
    console.log('[异常]', e && e.message, e && e.stack);
  }
  app.exit(0);
});

async function run() {
  let win = null;
  for (let i = 0; i < 80; i++) {
    win = appModule.getWindow();
    if (win && !win.webContents.isLoading()) break;
    await sleep(200);
  }
  await sleep(2500);

  // 把光标挪到角落，免得 HUD 的命中状态影响判断
  await win.webContents.executeJavaScript(
    'window.__petDebug.setMouse(2,2); window.__petDebug.hitTestNow(); false');

  const img = await win.webContents.capturePage();
  const size = img.getSize();
  const bmp = img.toBitmap();          // BGRA
  const W = size.width, H = size.height;

  console.log(`窗口截图 ${W}x${H}`);
  const st = await win.webContents.executeJavaScript('window.__petDebug.state()');
  console.log(`mode=${st.mode}  立绘 ${st.petSize.w.toFixed(1)}x${st.petSize.h.toFixed(1)}  ` +
    `锚点 (${st.anchor.x.toFixed(1)}, ${st.anchor.y.toFixed(1)})`);
  console.log('');

  // ---- 收集不透明像素 ----
  const rowCount = new Array(H).fill(0);
  let minX = W, maxX = -1, minY = H, maxY = -1;
  const ALPHA_OPAQUE = 240;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = bmp[(y * W + x) * 4 + 3];
      if (a > ALPHA_OPAQUE) {
        rowCount[y]++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const totalOpaque = rowCount.reduce((a, b) => a + b, 0);
  console.log(`不透明像素 ${totalOpaque}（占 ${(totalOpaque / (W * H) * 100).toFixed(1)}%）`);

  if (maxX < 0) {
    console.log('★ 一个不透明像素都没有 —— 画面上什么都没画出来。');
    return;
  }

  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  console.log(`不透明区域包围盒 x ${minX}~${maxX}, y ${minY}~${maxY}  (${bw}x${bh})`);
  console.log(`占窗口：宽 ${(bw / W * 100).toFixed(1)}%  高 ${(bh / H * 100).toFixed(1)}%`);
  console.log('');

  // ★ 判据：如果包围盒几乎铺满整个窗口，那多半是画了一块底板。
  const fillsWindow = bw > W * 0.95 && bh > H * 0.95;
  console.log(fillsWindow
    ? '★ 警告：不透明区域几乎铺满整个窗口 —— 很可能有一块不该有的底板！'
    : '包围盒明显小于窗口 —— 不是整块底板，正常。');
  console.log('');

  // ---- 逐行剖面（每 5% 高度采一行）----
  console.log('逐行剖面（这一行的不透明像素数 / 该行占比）：');
  for (let p = 0; p <= 100; p += 5) {
    const y = Math.min(H - 1, Math.round(p / 100 * (H - 1)));
    const n = rowCount[y];
    const bar = '#'.repeat(Math.round(n / W * 60));
    console.log(`  y=${String(y).padStart(3)} (${String(p).padStart(3)}%)  ${String(n).padStart(4)}  ${bar}`);
  }
  console.log('');

  // ---- 关键位置的实测像素 ----
  const probe = (x, y, label) => {
    const i = (y * W + x) * 4;
    const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2], a = bmp[i + 3];
    console.log(`  ${label.padEnd(22)} (${String(x).padStart(3)},${String(y).padStart(3)})  ` +
      `rgba(${r},${g},${b},${a})`);
  };
  console.log('实测像素：');
  probe(3, 3, '左上角（应为全透明）');
  probe(W - 4, 3, '右上角（应为全透明）');
  probe(3, H - 4, '左下角（应为全透明）');
  probe(W - 4, H - 4, '右下角（应为全透明）');
  probe(Math.round(st.anchor.x), Math.round(st.anchor.y - st.petSize.h * 0.5), '立绘身体中央');
  probe(Math.round(st.anchor.x), Math.round(st.anchor.y - st.petSize.h * 0.9), '立绘头部');
  probe(Math.round(st.anchor.x - st.petSize.w * 0.48), Math.round(st.anchor.y - st.petSize.h * 0.4),
    '立绘左侧留白（应透明）');

  const out = path.join(__dirname, '..', '..', 'screenshots', 'diag-alpha-profile.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  console.log('');
  console.log('裸图已存 ->', out);
}
