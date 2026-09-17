// ============================================================
// tests/config.test.js —— 「参数真的生效了吗」验证（2D 版）
//
// 跑法：npm run test:config
//
// 前面那些测试在验证「行为对不对」。这个测试验证的是另一件事：
//   你在 desktop/config.js 里改一个数字，它到底有没有真的走到该去的地方？
//
// 为什么值得单独测？因为「配置不生效」是原型阶段最烦人的一类问题 ——
// 它不报错、不崩溃，只是安静地什么都不做。你改了大小、颜色、速度，
// 画面纹丝不动，然后开始怀疑人生：
//   是我改错文件了？是缓存没刷？还是这段代码根本不读配置？
//
// 所以这里用一组【明显区别于默认值】的参数启动应用，然后验证：
//   1. 窗口尺寸、位置真的按配置来了
//   2. 渲染层读到的不只是数字，而是真的作用到了画面上
//   3. 配置写坏时能安全退回默认值，而不是崩溃
//
// 顺带核对一件小事：preload.js 里的 IPC 频道名和 config/ipc.js
// 里写的是否一致（那个字符串因为沙箱限制没法共用，只能各写一遍）。
// ============================================================

const { app, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.commandLine.appendSwitch('use-gl', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('no-sandbox');

const { loadConfig, deepMerge, collectIssues, validate, DEFAULTS } = require('../config');
const { CHANNEL } = require('../config/ipc');

// ------------------------------------------------------------
// 造一份临时配置。每个值都故意取得很怪，
// 一旦没生效，断言立刻就能看出来。
// ------------------------------------------------------------
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet2d-cfg-'));
const GOOD_CONFIG = path.join(TMP_DIR, 'config.js');
const BROKEN_CONFIG = path.join(TMP_DIR, 'broken.js');

const MARK = {
  window: { width: 444, height: 300, marginRight: 12, marginBottom: 18 },
  placement: { heightRatio: 0.62, groundY: 0.94, centerX: 0.42 },
  vector: {
    colors: { hair: 0x00ff00 },   // 头发改成纯绿，一眼能认出来
    headHeightRatio: 0.5,         // 基准是 0.38 → 头应该放大 1.3158 倍
  },
  animation: { breath: { period: 9.9, amplitudeY: 0.099, amplitudeX: 0.011 } },
  reaction: { moodGainPerPoke: 0.111, bubbleLinesHappy: ['测试台词甲'] },
  debug: { showHud: false },
};

fs.writeFileSync(GOOD_CONFIG, 'module.exports = ' + JSON.stringify(MARK) + ';\n', 'utf8');
// 故意漏掉一个右大括号，制造语法错误
fs.writeFileSync(BROKEN_CONFIG, 'module.exports = { window: { width: 999, };\n', 'utf8');

// ★ 必须在 require main.js 之前设置好 ——
//   main.js 在模块加载时就会读配置，晚一步就来不及了。
process.env.DESKPET_CONFIG = GOOD_CONFIG;

// 加载真实主进程：它会用上面的临时配置建窗口
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
    runPureTests();
    await runWindowTests();
  } catch (err) {
    console.log('\n[测试脚本异常]', err && err.message);
    if (err && err.stack) console.log(err.stack);
    failed++;
  }
  console.log('');
  console.log(failed === 0 ? '全部通过' : `${failed} 项失败`);
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed === 0 ? 0 : 1);
});

// ============================================================
// 第一部分：纯逻辑（不需要窗口，秒出结果）
// ============================================================
function runPureTests() {
  console.log('\n=== 1. 深度合并：漏写的项要保留默认值 ===');
  // ★ 先给默认值拍一张快照，merge 完再比 —— 这样测的是「有没有被改」。
  //   原来这条断言里写死了 0x303040，于是「按官方人设图更新配色」
  //   这种正常操作也会把它弄红，而红的原因跟 merge 毫无关系。
  //   测试里不该抄一份默认值的副本：那等于把「默认值改没改」和
  //   「merge 有没有出问题」两件事绑死在一起，改哪个都会误报。
  const snap = JSON.stringify(DEFAULTS);

  const merged = deepMerge(DEFAULTS, {
    window: { width: 400 },
    vector: { colors: { hair: 0x00ff00 } },
  });
  check('用户写了的项被覆盖', merged.window.width === 400, `width = ${merged.window.width}`);
  check('★ 用户没写的项保留默认值',
    merged.window.height === DEFAULTS.window.height &&
    merged.placement.groundY === DEFAULTS.placement.groundY,
    `height = ${merged.window.height}, groundY = ${merged.placement.groundY}`);
  check('★ 嵌套对象也能正确合并（不是整块替换）',
    merged.vector.colors.skin === DEFAULTS.vector.colors.skin,
    `vector.colors.skin = ${merged.vector.colors.skin.toString(16)}（用户只改了 hair）`);
  const same = JSON.stringify(DEFAULTS) === snap;
  check('★ 不会污染默认值本身', same,
    same
      ? `默认值整份没变（width=${DEFAULTS.window.width}，` +
        `hair=#${DEFAULTS.vector.colors.hair.toString(16)}）`
      : '默认值被 merge 改掉了');

  console.log('\n=== 2. 拼写错 / 类型错能被指出来 ===');
  const issues = collectIssues(DEFAULTS, {
    window: { widht: 999 },
    vector: { colors: { hair: '蓝色' } },
    reaction: { bubbleLinesHappy: 1 },
  }, '', []);
  const joined = issues.join('\n');
  check('能发现拼错的参数名', /widht/.test(joined),
    issues.find((s) => /widht/.test(s)) || '(没发现)');
  check('能发现该写数字却写了字符串', /vector\.colors\.hair/.test(joined),
    issues.find((s) => /vector\.colors\.hair/.test(s)) || '(没发现)');
  check('能发现该写数组却不是数组', /bubbleLinesHappy/.test(joined),
    issues.find((s) => /bubbleLinesHappy/.test(s)) || '(没发现)');

  console.log('\n=== 3. 明显不合理的值能被拦下 ===');
  const badValues = deepMerge(DEFAULTS, {
    window: { width: 0 },
    animation: { breath: { period: -2 } },      // 负的动画周期，明显不合理
    reaction: { bubbleLinesNeutral: [] },
    placement: { heightRatio: 88 },          // ★ 把「百分比」写成整数，最常见的笔误
  });
  const problems = validate(badValues);
  check('宽度为 0 会被拦下', problems.some((s) => /window\.width/.test(s)),
    problems.find((s) => /window\.width/.test(s)) || '(什么都没拦到)');
  check('呼吸周期为负会被拦下', problems.some((s) => /breath\.period/.test(s)),
    problems.find((s) => /breath\.period/.test(s)) || '(没拦到)');
  check('台词数组为空会被提醒', problems.some((s) => /bubbleLinesNeutral/.test(s)));
  check('★ 把比例写成整数（88 而不是 0.88）会被拦下并点破',
    problems.some((s) => /placement\.heightRatio/.test(s) && /百分比/.test(s)),
    problems.find((s) => /placement\.heightRatio/.test(s)) || '(没拦到)');
  check('★ 出厂默认值本身必须一条问题都没有',
    validate(DEFAULTS).length === 0,
    validate(DEFAULTS).join(' / ') || '0 条问题');

  console.log('\n=== 4. 配置写坏时安全退回默认值 ===');
  process.env.DESKPET_CONFIG = BROKEN_CONFIG;
  const broken = loadConfig();
  check('★ 语法错误的配置不会让应用崩溃',
    broken.error !== null && broken.config === DEFAULTS,
    broken.error ? `捕获到：${broken.error.message.split('\n')[0]}` : '没有捕获到错误');
  check('出错时仍然给出了可用的配置对象',
    broken.config.window.width === 340 &&
    typeof broken.config.placement.heightRatio === 'number',
    `退回后的 window.width = ${broken.config.window.width}`);

  console.log('\n=== 5. 没设环境变量时用内置默认值 ===');
  delete process.env.DESKPET_CONFIG;
  const none = loadConfig();
  check('★ 测试环境不会被用户配置影响',
    none.configPath === null && none.config.window.width === DEFAULTS.window.width,
    `configPath = ${none.configPath}，width = ${none.config.window.width}`);

  console.log('\n=== 6. IPC 频道名两处写法一致 ===');
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const m = preloadSrc.match(/const\s+CHANNEL\s*=\s*'([^']+)'/);
  check('★ preload.js 与 config/ipc.js 的频道名一致（沙箱限制导致没法共用，只能靠断言兜住）',
    !!m && m[1] === CHANNEL,
    `preload.js: ${m ? m[1] : '(没找到)'}  vs  config/ipc.js: ${CHANNEL}`);

  // 还原，后面的窗口测试还要用
  process.env.DESKPET_CONFIG = GOOD_CONFIG;
}

// ============================================================
// 第二部分：真窗口 —— 参数有没有真的作用到画面上
// ============================================================
async function runWindowTests() {
  let win = null;
  for (let i = 0; i < 80; i++) {
    win = appModule.getWindow();
    if (win && !win.webContents.isLoading()) break;
    await sleep(200);
  }
  if (!win) throw new Error('main.js 没有创建窗口');
  await sleep(1800);

  const evalJS = (expr) => win.webContents.executeJavaScript(expr);

  console.log('\n=== 7. 窗口按配置建立 ===');
  const bounds = win.getBounds();
  check('窗口尺寸来自配置（444x300，而不是默认的 340x400）',
    Math.abs(bounds.width - MARK.window.width) <= 6 &&
    Math.abs(bounds.height - MARK.window.height) <= 6,
    `实际 ${bounds.width}x${bounds.height}，配置 ${MARK.window.width}x${MARK.window.height}`);

  const { workArea } = screen.getPrimaryDisplay();
  const expectX = workArea.x + workArea.width - MARK.window.width - MARK.window.marginRight;
  const expectY = workArea.y + workArea.height - MARK.window.height - MARK.window.marginBottom;
  check('窗口位置来自配置的边距（离右下角 12 / 18 px）',
    Math.abs(bounds.x - expectX) <= 4 && Math.abs(bounds.y - expectY) <= 4,
    `实际 (${bounds.x}, ${bounds.y})，期望 (${expectX}, ${expectY})`);

  console.log('\n=== 8. 渲染层真的读到了这份配置 ===');
  const cfg = await evalJS('window.__petDebug.config()');
  check('渲染层拿到的就是用户那份配置',
    cfg && cfg.window.width === MARK.window.width &&
    cfg.placement.heightRatio === MARK.placement.heightRatio,
    `window.width = ${cfg && cfg.window.width}, ` +
    `placement.heightRatio = ${cfg && cfg.placement.heightRatio}`);

  console.log('\n=== 9. ★ 参数真的作用到画面上（不只是读到了）===');
  const st = await evalJS('window.__petDebug.state()');

  // (a) heightRatio 真的决定了立绘的高度
  const expectH = MARK.placement.heightRatio * st.innerH;
  check('placement.heightRatio 真的决定了立绘高度',
    Math.abs(st.petSize.h - expectH) < 2,
    `实际 ${st.petSize.h.toFixed(1)}px，期望 ${MARK.placement.heightRatio} × ${st.innerH} = ${expectH.toFixed(1)}px`);

  // (b) centerX 真的决定了横向位置
  const expectAX = MARK.placement.centerX * st.innerW;
  check('placement.centerX 真的决定了锚点横坐标',
    Math.abs(st.anchor.x - expectAX) < 2,
    `实际 ${st.anchor.x.toFixed(1)}，期望 ${expectAX.toFixed(1)}`);

  // (c) ★ 颜色参数真的画到了 SVG 上。
  //     这一条和 3D 版的「身体颜色按配置生效」是同一个意思：
  //     光看 state 里的数字不算数，要去看画面上那个元素的实际属性。
  const svgPaints = await evalJS(`
    (() => {
      const v = document.getElementById('vector');
      const fills = [...v.querySelectorAll('[fill]')].map((e) => e.getAttribute('fill'));
      return {
        hasGreen: fills.some((f) => f === '#00ff00'),
        fillCount: fills.length,
        viewBox: v.getAttribute('viewBox'),
      };
    })()
  `);
  check('★ 头发颜色按配置生效（SVG 上真的出现了 #00ff00）',
    svgPaints.hasGreen,
    `SVG 里 ${svgPaints.fillCount} 处填充，viewBox=${svgPaints.viewBox}，` +
    `找到 #00ff00：${svgPaints.hasGreen}`);

  // (d) ★ headHeightRatio 是不是真的生效
  //
  //   这一条是专门补上的：这个参数以前是个【死参数】——
  //   config/index.js 会校验它、desktop/README.md 还写着
  //   「调到 0.16 就变成写实比例的大人」，但渲染层根本没人读它，
  //   用户改了完全没反应。刚好就是这个项目最想避免的那类坑。
  //   现在断言改成两条：头真的被缩放了，而且【命中判定也跟着缩放】
  //   （只缩头不缩判定的话，头变大就等于「点脸没反应」）。
  const headK = MARK.vector.headHeightRatio / 0.38;
  const headInfo = await evalJS(`
    (() => {
      const g = document.getElementById('v-head');
      return g ? (g.getAttribute('transform') || '') : null;
    })()
  `);
  check('★ headHeightRatio 真的作用到头上了（它以前是个死参数）',
    typeof headInfo === 'string' && headInfo.indexOf('scale(' + headK.toFixed(4)) >= 0,
    `#v-head 的 transform = "${(headInfo || '(找不到 #v-head)').trim()}"，` +
    `期望含 scale(${headK.toFixed(4)})`);

  const shapes = await evalJS('window.__petDebug.vectorHitShapes()');
  const headShape = shapes && shapes[0];
  check('★ 头的【命中判定】跟着一起放大了（不然头变大 = 点脸没反应）',
    !!headShape && Math.abs(headShape.ry * 300 - 72 * headK) < 0.6,
    `判定椭圆 ry = ${headShape ? (headShape.ry * 300).toFixed(1) : '?'}` +
    `（期望 ${(72 * headK).toFixed(1)}）`);

  // (e) HUD 开关
  const hudDisplay = await evalJS(
    'getComputedStyle(document.getElementById("hud")).display');
  check('HUD 按配置隐藏（debug.showHud = false）',
    st.hudVisible === false && hudDisplay === 'none',
    `hudVisible = ${st.hudVisible}，computed display = ${hudDisplay}`);

  console.log('\n=== 10. 未在配置里出现的项仍然使用默认值 ===');
  check('sway 周期没写 -> 用默认的 4.1',
    cfg.animation.sway.period === DEFAULTS.animation.sway.period,
    `sway.period = ${cfg.animation.sway.period}`);
  check('窗口的 resizable 没写 -> 用默认的 false',
    cfg.window.resizable === DEFAULTS.window.resizable,
    `resizable = ${cfg.window.resizable}`);
  check(`肤色没写 -> 用默认的 #${DEFAULTS.vector.colors.skin.toString(16)}`,
    cfg.vector.colors.skin === DEFAULTS.vector.colors.skin,
    `skin = #${cfg.vector.colors.skin.toString(16)}`);

  const f1 = await evalJS('window.__petDebug.state().frames');
  await sleep(600);
  const f2 = await evalJS('window.__petDebug.state().frames');
  check('动画循环仍在正常运行（改配置没把渲染搞坏）', f2 > f1, `${f1} -> ${f2}`);
}
