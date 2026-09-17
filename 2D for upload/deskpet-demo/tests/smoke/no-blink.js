// ============================================================
// tests/smoke/no-blink.js —— 「不点击时立绘不许闪」+「眨眼已删除」
//
// 起因（用户报的 bug，前后两轮）：
//   ① 鼠标完全不动、不点击，也偶尔闪一下「同一套衣服、但表情不同」的图。
//      根因：早期想用【换图】做表情，给每套准备了 4 张（idle/blink/happy/
//      surprise）。但 AI 生成的这 4 张【不是同一姿势只换表情】，
//      而是【分别重画的整身立绘】—— 实测 idle↔blink 的像素差异遍布整个
//      轮廓（占画面 14%），帽子/围巾/姿势/大小都不同。
//      于是每 2~4.5 秒眨一次眼，整只小人就「换了个样」闪一下。
//   ② 改成「压扁眼睛条」之后，又变成「上下两端往中间缩一下马上恢复」。
//      根因是眼睑层的盒子做成了整张立绘，scaleY 压扁压到的是整只小人。
//
// 最终的决定：眨眼整个删掉。
//   只保留「展示立绘」+「点击换装」。立绘上不再有任何覆盖层，
//   「眼睛开合度」这个概念也一并从代码里去掉了。
//
// 这个脚本就是这道闸：
//   ① 静置 8 秒（不点击、不动鼠标），断言立绘 src 【一次都不能变】
//      ← 用户报的 bug 的直接判据
//   ② 断言 #eyelids 元素不存在、__petDebug 上不再有眨眼相关的接口
//      ← 防止有人把眨眼加回来却没同步测试
//   ③ 断言 frames 一直在涨
//      ← ★ 关键的反假绿：万一主循环卡死了，① 当然也「没变化」，
//         那是死掉不是修好。必须证明画面是活的。
//   ④ 断言点一下【还能】换装
//      ← 双向验证：src 「该变的时候得变」，否则①可能只是换装也一起坏掉了
//
// ★ 为什么【从主进程轮询】而不是在页面里用 rAF 采样：
//   这个窗口是隐藏的（测试模式），隐藏窗里 rAF 会被降频到 ~1fps、
//   setInterval 的最小间隔被钳到 ≥1000ms，页面内采样器经常拿到 0 个样本。
//   从主进程主动 executeJavaScript 不受这套节流影响。
//   （在页面里采样是踩过的坑，别改回去。）
// ============================================================
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('use-gl', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('no-sandbox');

require('../../main.js');

const OUT = path.join(__dirname, '..', '..', 'screenshots', 'no-blink');
// screenshots/ 是运行产物、未纳入版本控制，clone 之后该目录可能不存在。
// recursive:true 在目录已存在时也不会报错。
fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win = null;
const evalJS = (code) => win.webContents.executeJavaScript(code, true);

const runtimeErrors = [];
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (_ev, level, message) => {
    if (level >= 3) runtimeErrors.push(message);
  });
});

const failures = [];
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  —— ' + detail : ''}`);
  if (!ok) failures.push(label);
};

app.whenReady().then(async () => {
  try {
    await sleep(2500);
    win = require('electron').BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('拿不到窗口');
    await sleep(1500);   // 等贴图加载完

    const st0 = await evalJS('window.__petDebug.state()');
    console.log(`模式 ${st0.mode}  ${st0.spriteLoadNote}`);

    // ------------------------------------------------------------
    // ① 静置 8 秒，主进程每 200ms 采一次立绘 src
    // ------------------------------------------------------------
    console.log('\n① 静置采样 8 秒（不点击、不动鼠标、不暂停）...');
    const seen = new Set();
    let f0 = st0.frames;
    for (let i = 0; i < 40; i++) {
      const s = await evalJS(
        "document.getElementById('sprite').getAttribute('src') || '(无)'");
      seen.add(s);
      await sleep(200);
    }
    const st1 = await evalJS('window.__petDebug.state()');
    const names = [...seen].map((s) => String(s).split('/').pop());
    console.log(`     出现过 ${seen.size} 个 src：${names.join(', ')}`);
    check(seen.size === 1,
      '★ 静置 8 秒立绘一次都没换过（不闪）',
      seen.size === 1 ? `全程只有 ${names[0]}` : `变了 ${seen.size - 1} 次`);

    // ------------------------------------------------------------
    // ③ 反假绿：主循环得是活的
    // ------------------------------------------------------------
    console.log(`\n② 帧计数：${f0} -> ${st1.frames}`);
    check(st1.frames > f0 + 30,
      '★ 主循环一直在跑（「没变化」不是因为卡死了）',
      `8 秒推进了 ${st1.frames - f0} 帧`);

    // ------------------------------------------------------------
    // ② 眨眼相关的东西必须全部不存在
    // ------------------------------------------------------------
    const gone = await evalJS(`(() => {
      const d = window.__petDebug;
      const st = d.state();
      return {
        lidEl: !!document.getElementById('eyelids'),
        hasLidInfo: typeof d.lidInfo === 'function',
        hasLidScaleY: typeof d.lidScaleY === 'function',
        hasSetEyesOpen: typeof d.setEyesOpen === 'function',
        stateHasEyes: 'eyesOpen' in st,
        cfgBlink: !!(d.config().animation && d.config().animation.blink),
        cfgEyelids: !!(d.config().animation && d.config().animation.eyelids),
      };
    })()`);
    console.log(`\n③ 眨眼残留检查：${JSON.stringify(gone)}`);
    check(!gone.lidEl, '★ #eyelids 元素已从页面上删掉');
    check(!gone.hasLidInfo && !gone.hasLidScaleY && !gone.hasSetEyesOpen,
      '★ 眨眼的调试接口（lidInfo / lidScaleY / setEyesOpen）已删掉');
    check(!gone.stateHasEyes, '★ 状态里不再有 eyesOpen（眨眼状态机已删）');
    check(!gone.cfgBlink && !gone.cfgEyelids,
      '★ 配置里不再有 animation.blink / animation.eyelids',
      gone.cfgBlink || gone.cfgEyelids ? '还有残留参数' : '两项都已移除');

    // ------------------------------------------------------------
    // ④ 反向验证：点一下该换的时候得换
    // ------------------------------------------------------------
    console.log('\n④ 反向验证 —— 点一下应该换一套');
    let switched = { before: '(无)', now: '(无)' };
    if (st0.mode !== 'sprite') {
      console.log('     ⚠ 当前不是贴图模式（没找到素材），跳过换装验证。');
    } else {
      switched = await evalJS(`(async () => {
        const before = document.getElementById('sprite').getAttribute('src');
        await window.__petDebug.switchOutfit();
        await window.__petDebug.idle();
        const now = document.getElementById('sprite').getAttribute('src');
        return { before, now };
      })()`);
      console.log(`     ${String(switched.before).split('/').pop()}` +
        ` -> ${String(switched.now).split('/').pop()}`);
      check(switched.before !== switched.now,
        '★ 点击（换装）时立绘【确实会变】（src 不是死的一张）');
    }

    // ------------------------------------------------------------
    // 留一张截图当证据
    // ------------------------------------------------------------
    const img = await win.webContents.capturePage();
    const f = path.join(OUT, 'still.png');
    fs.writeFileSync(f, img.toPNG());
    console.log(`\n截图：${f}`);

    console.log(`\n渲染层报错：${runtimeErrors.length ? runtimeErrors.join(' | ') : '0 条'}`);
    if (runtimeErrors.length) failures.push('渲染层有报错');

    console.log(`\n${failures.length ? '✗ 失败 ' + failures.length + ' 项：' + failures.join('；')
                                      : '✓ 全部通过 —— 静置时立绘纹丝不动，眨眼已彻底移除'}`);
    app.exit(failures.length ? 1 : 0);
  } catch (err) {
    console.log('[脚本异常]', err && err.message);
    if (err && err.stack) console.log(err.stack);
    app.exit(1);
  }
});
