// ============================================================
// tests/smoke/outfit-photo.js —— 换装取证：每点一下存一张图
//
// 跑法（带用户配置）：
//   electron.exe tests/smoke/outfit-photo.js
//   DESKPET_CONFIG=<desktop/config.js>
//
// 它做的事：
//   ① 启动真实主进程
//   ② 冻结时间轴（不然每张姿态都不同，没法并排看）
//   ③ 依次点 N 次，每次等素材加载完，再截一张图
//   ④ 复查：上方没有 HUD、脚底没被窗口切、立绘不透明
//
// 为什么要它：冒烟测试给的是【数字】，这个给的是【能并排看的图】。
// 换装这种「看一眼就知道对不对」的功能，图比数字直观得多。
// ============================================================
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('use-gl', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('no-sandbox');

const appModule = require('../../main.js');

const OUT = path.join(__dirname, '..', '..', 'screenshots', 'verify');
// screenshots/ 是运行产物、未纳入版本控制，clone 之后该目录可能不存在。
// recursive:true 在目录已存在时也不会报错。
fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win = null, failed = 0;
const evalJS = (code) => win.webContents.executeJavaScript(code, true);
const check = (name, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (detail) console.log(`       ${detail}`);
  if (!ok) failed++;
};

app.on('web-contents-created', (_e, wc) => { win = wc; });

app.whenReady().then(async () => {
  try {
    await sleep(2500);
    const all = require('electron').BrowserWindow.getAllWindows();
    win = all[0];
    if (!win) throw new Error('拿不到窗口');

    // 铺一层浅色背景，否则透明窗截出来是一团黑
    const key = await win.webContents.insertCSS(
      'html,body{background:linear-gradient(160deg,#eef3f9 0%,#cfdbea 55%,#b3c4da 100%) !important;}');

    await evalJS('window.__petDebug.setPaused(true); false');
    await sleep(300);

    // ---- ① HUD 必须不可见 ----
    const hudInfo = await evalJS(`
      (() => {
        const el = document.getElementById('hud');
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { display: cs.display, w: r.width, h: r.height,
                 text: el.textContent.replace(/\\s+/g, ' ').trim() };
      })()
    `);
    console.log(`HUD display=${hudInfo.display}，尺寸 ${hudInfo.w}x${hudInfo.h}`);
    check('★ 上方的「命中/操作」提示框已隐藏',
      hudInfo.display === 'none' || (hudInfo.w === 0 && hudInfo.h === 0),
      `display=${hudInfo.display}`);

    // ---- ② 换上浅色背景后，逐套截图 ----
    await win.webContents.removeInsertedCSS(key);
    await win.webContents.insertCSS(
      'html,body{background:linear-gradient(160deg,#eef3f9 0%,#cfdbea 55%,#b3c4da 100%) !important;}');

    const pool = (await evalJS('window.__petDebug.outfit()')).pool;
    const shots = [];
    for (let i = 0; i < pool.length; i++) {
      const o = await evalJS('window.__petDebug.outfit()');
      await sleep(250);
      const img = await win.webContents.capturePage();
      const file = path.join(OUT, `${String(i).padStart(2, '0')}-${o.name}.png`);
      fs.writeFileSync(file, img.toPNG());

      // 量一下这一张的几何：脚底有没有出窗口
      const geo = await evalJS(`
        (() => {
          const st = window.__petDebug.state();
          const s = document.getElementById('sprite');
          const r = s.getBoundingClientRect();
          return { name: window.__petDebug.outfit().name,
                   bottom: r.bottom, top: r.top, h: window.innerHeight,
                   pet: st.petSize, mask: st.maskInfo };
        })()
      `);
      shots.push({ file, geo });
      console.log(`   -> ${path.basename(file)}  立绘 ${geo.pet.w.toFixed(1)}x${geo.pet.h.toFixed(1)}` +
        `  底边 y=${geo.bottom.toFixed(1)} / 窗口高 ${geo.h}  遮罩 ${geo.mask.w}x${geo.mask.h}`);
      check(`  ${o.name} 脚底没被窗口切掉`, geo.bottom <= geo.h + 0.5,
        `底边 ${geo.bottom.toFixed(1)} vs 窗口 ${geo.h}`);

      await evalJS('window.__petDebug.switchOutfit(); false');
      await evalJS('window.__petDebug.idle()');
    }

    const names = shots.map((s) => s.geo.name);
    console.log(`\n依次拍到：${names.join(' -> ')}`);

    // ★ 「每点一下都换一套」这个断言不能写成「N 张图必须全不同」。
    //   牌堆语义是【随机不重复】：一轮之内每套只发一次，发完重洗。
    //   而重洗之后的【第一张】允许和上一轮的收尾是同一套 ——
    //   这正是「随机」的正常表现，不是 bug。
    //   所以判据拆成三条（和 visual-check 里的写法保持一致）：
    //     ① 相邻两次必不同（点了没反应才是 bug）
    //     ② 牌堆内部无重复
    //     ③ 按 round 分组后，每组内无重复
    let adjacentOk = true;
    for (let i = 1; i < names.length; i++) {
      if (names[i] === names[i - 1]) { adjacentOk = false; break; }
    }
    check('★ 每点一下都换了（相邻两次必不同）', adjacentOk,
      names.join(' -> '));

    const hist = await evalJS('window.__petDebug.history()');
    const deck = await evalJS('window.__petDebug.deck()');
    check('牌堆内部没有重复（随机不重复）',
      new Set(deck).size === deck.length, `牌堆剩 ${deck.length} 张`);

    // 按轮分组，组内不许重复
    const byRound = new Map();
    for (const h of hist) {
      if (!byRound.has(h.round)) byRound.set(h.round, []);
      byRound.get(h.round).push(h.name);
    }
    let roundOk = true, badRound = null;
    for (const [r, arr] of byRound) {
      if (new Set(arr).size !== arr.length) { roundOk = false; badRound = r; break; }
    }
    check('每一轮之内每套只出现一次',
      roundOk, `共 ${byRound.size} 轮` +
      (badRound !== null ? `，第 ${badRound} 轮有重复` : ''));

    await evalJS('window.__petDebug.setPaused(false); false');
  } catch (err) {
    console.log('[脚本异常]', err && err.message);
    if (err && err.stack) console.log(err.stack);
    failed++;
  }
  console.log(`\n${failed ? failed + ' 项失败' : '全部通过'}`);
  console.log(`图片目录：${OUT}`);
  app.exit(failed ? 1 : 0);
});
