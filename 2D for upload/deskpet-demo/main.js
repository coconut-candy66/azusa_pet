// ============================================================
// 主进程：负责「桌面容器」这一层
//
// 它要解决四件事：
//   1. 窗口透明         -> transparent: true
//   2. 窗口置顶         -> alwaysOnTop: true
//   3. 点击穿透（核心） -> setIgnoreMouseEvents + 渲染进程回传命中结果
//   4. 拖拽移动窗口     -> 主进程跟随光标 setBounds
//
// 注意：本文件不碰任何 3D 逻辑，3D 全部在 src/renderer.js 里。
// 这种「窗口层 / 渲染层」分离是刻意的，后面接真实模型时不用改这里。
//
// ★ 本次改造新增：一切都从 config/ 里读，不再有写死的数字。
//   参数从哪来？看 DESKPET_CONFIG 环境变量（由 desktop/启动桌宠.cmd 设置）。
//   没设置就用 config/defaults.js 的内置默认值 —— 测试走的就是这条路。
// ============================================================

const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { createDragController } = require('./drag');
const { loadConfig, validate } = require('./config');
const { registerConfigIpc } = require('./config/ipc');

// ------------------------------------------------------------
// 一、先把配置读进来
// ------------------------------------------------------------
const loaded = loadConfig();
const CONFIG = loaded.config;

// 把配置挂到 IPC 频道上，供 preload 同步取用。
// 必须在窗口创建【之前】注册，否则 preload 先跑会取到 undefined。
registerConfigIpc(CONFIG);

// 命令行开关：让「调试启动.cmd」能强制打开开发者工具，
// 不用为此去改配置文件。
const FORCE_DEVTOOLS = process.argv.includes('--deskpet-devtools');

// ------------------------------------------------------------
// 二、日志
//
// 为什么桌宠需要一个日志文件？
//   因为窗口是无边框透明的，一旦它没出来，你连「它是不是启动了」都判断不了。
//   有个日志文件，至少能回答「它跑到哪一步了」。
//
// 只在「由启动器带配置文件启动」时才写文件，避免跑测试时到处留垃圾。
// ------------------------------------------------------------
let logStream = null;
let logPath = null;

function logFilePath() {
  return logPath || '（本次没有写日志文件）';
}

function initLogging() {
  if (!CONFIG.debug.logToFile) return;
  if (!loaded.configPath) return;

  try {
    const logDir = path.join(path.dirname(loaded.configPath), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logPath = path.join(logDir, 'desktop.log');
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
  } catch (err) {
    // 日志写不了不是致命问题，别让它影响启动
    console.log('[日志初始化失败]', err.message);
  }
}

function log(...args) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${args.join(' ')}`;
  console.log(line);
  if (logStream) logStream.write(line + '\n');
}

initLogging();

log('========================================');
log(`启动。配置文件：${loaded.configPath || '（未指定，使用内置默认值）'}`);
log(`启动参数：${JSON.stringify(process.argv.slice(1))}`);

// ------------------------------------------------------------
// 三、把配置的问题报告出来
//
// 配置写错最气人的地方是「它一声不吭」。打错一个字母、数字加了引号，
// JS 不会报任何错，只会表现为「我明明改了怎么没用」。
// 所以这里主动把所有问题打出来，让人一眼看到。
// ------------------------------------------------------------
if (loaded.error) {
  log('[配置错误]', loaded.error.message);
  log('          配置文件读不了，已退回内置默认值运行。');
  log('          常见原因：少了括号 / 多了逗号 / module.exports 写错了');
} else {
  const problems = validate(CONFIG);
  const allIssues = problems.concat(loaded.issues);

  if (allIssues.length) {
    log(`[配置提醒] 发现 ${allIssues.length} 个可疑之处（不影响启动，但多半不是你想要的）：`);
    allIssues.forEach((s) => log('          - ' + s));
  } else if (loaded.configPath) {
    log('[配置] 全部参数检查通过');
  }
}

// ------------------------------------------------------------
// 环境变量说明（保留原注释）：
//
// 极少数机器上（虚拟机、老显卡、驱动异常）GPU 进程会启动失败，报：
//   FATAL:gpu_data_manager_impl_private.cc GPU process isn't usable.
// 遇到这个就用 desktop/调试启动.cmd，或者给 electron 加：
//   --use-gl=swiftshader --enable-unsafe-swiftshader --no-sandbox
// 正常机器上不需要，加了反而可能降低渲染性能。
// ------------------------------------------------------------

let win = null;

function createWindow() {
  // 把窗口放在屏幕右下角，离边缘留一点距离，符合桌宠的常见位置
  const { workArea } = screen.getPrimaryDisplay();
  const w = CONFIG.window.width;
  const h = CONFIG.window.height;
  const startX = workArea.x + workArea.width - w - CONFIG.window.marginRight;
  const startY = workArea.y + workArea.height - h - CONFIG.window.marginBottom;

  win = new BrowserWindow({
    width: w,
    height: h,
    x: startX,
    y: startY,

    // --- 关键配置，一个都不能少 ---
    transparent: CONFIG.window.transparent,   // 窗口背景透明，桌宠能「浮」在桌面上的前提
    frame: CONFIG.window.frame,               // 去掉标题栏和边框
    alwaysOnTop: CONFIG.window.alwaysOnTop,   // 始终置顶
    skipTaskbar: CONFIG.window.skipTaskbar,   // 不出现在任务栏
    resizable: CONFIG.window.resizable,       // 固定尺寸，交给拖拽来移动
    hasShadow: CONFIG.window.hasShadow,       // 关掉窗口阴影，否则透明区会出现灰边
    // ----------------------------

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 让窗口在最顶层，包括全屏应用之上
  if (CONFIG.window.alwaysOnTop) {
    win.setAlwaysOnTop(true, CONFIG.window.alwaysOnTopLevel);
  }

  // 一开始先忽略鼠标事件，等渲染进程告诉我们「光标是否落在模型上」。
  // 默认设为穿透是更安全的选择：万一渲染进程挂了，也不会把桌面点不动。
  win.setIgnoreMouseEvents(CONFIG.window.ignoreMouseOnStart, { forward: true });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // ----------------------------------------------------------
  // 启动失败的兜底：一定要让人看得见
  //
  // 桌宠是个「没有窗口的窗口」—— 它要是没起来，屏幕上什么都不会发生，
  // 你只能对着桌面发呆，完全不知道是哪儿出了问题。
  // 所以页面加载失败或渲染进程崩溃时，主动弹一个框说清楚。
  //
  // 只在「由启动器指定了配置文件」时弹，避免打断自动化测试。
  // ----------------------------------------------------------
  const reportFatal = (title, detail) => {
    log(`[启动失败] ${title} —— ${detail}`);
    if (loaded.configPath) {
      dialog.showErrorBox(title, detail + `\n\n详细日志：\n${logFilePath()}`);
    }
  };

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    reportFatal('页面加载失败', `错误码 ${code}：${desc}\n地址：${url}`);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    reportFatal('渲染进程崩溃', `原因：${details.reason}（退出码 ${details.exitCode}）`);
  });

  if (CONFIG.debug.openDevTools || FORCE_DEVTOOLS) {
    win.webContents.openDevTools({ mode: 'detach' });
    log('[调试] 已打开开发者工具');
  }

  // 兜底：窗口失焦或关闭时强制结束拖拽，避免定时器一直空转。
  win.on('blur', () => {
    if (dragController) {
      dragController.end();
      dragController = null;
    }
  });

  win.on('closed', () => {
    if (dragController) {
      dragController.end();
      dragController = null;
    }
    win = null;
  });

  log(`窗口已创建：${w}x${h} @ (${startX}, ${startY})`);
}

app.whenReady().then(() => {
  // 配置读坏了的话，弹一个框告诉人 —— 不然他会一直纳闷为什么改参数没反应。
  // 只在「由启动器指定了配置文件」时才弹，测试不会被打断。
  if (loaded.error && loaded.configPath) {
    dialog.showErrorBox(
      '配置文件有问题',
      `读不了这个文件：\n${loaded.configPath}\n\n${loaded.error.message}\n\n` +
        '已退回内置默认值运行。改好之后保存，应用会自动重启。'
    );
  }

  createWindow();
  startConfigWatcher();
});

app.on('window-all-closed', () => {
  // 桌宠是单窗口应用，关掉就退出
  app.quit();
});

// ============================================================
// 四、★ 配置热重载 —— 这是「不一锤定音」的关键
//
// 你改完 desktop/config.js 保存，不用关窗口、不用回终端敲命令，
// 应用会自己重启并应用新参数。
//
// 为什么是「重启」而不是「就地生效」？
//   因为窗口尺寸、透明、置顶这些参数在窗口创建时就固定了，
//   Electron 没有提供「改一个属性让它重新生效」的接口。
//   重启是最可靠的做法 —— 而且它足够快（大约一秒），
//   比「改参数 → 切到终端 → 敲命令 → 切回来」快得多。
//
// 一个坑：监视【文件】在 Windows 上不可靠。
//   VS Code 等编辑器保存时用的是「先写临时文件、再改名覆盖」的原子写法，
//   文件一改名，指向原文件的 watch 就失效了，之后再也收不到通知。
//   所以这里改成监视【目录】，再按文件名过滤 —— 这样改名保存也能抓到。
// ============================================================
let configWatcher = null;

// ------------------------------------------------------------
// 重启自己
//
// ★ 这里踩过两个坑，都值得记下来。
//
// 坑一：一开始用 Electron 自带的 app.relaunch()。结果发现如果你启动时
//   带了命令行开关（比如无显卡环境下必须加的 --use-gl=swiftshader），
//   重启后那些开关【丢了】，新进程起来就撞上 GPU 初始化失败，
//   一秒内静默退出 —— 表现是「改了配置保存，窗口直接消失，什么都没发生」。
//   所以改成自己 spawn 一个新进程，把 process.argv 里的参数原样带过去。
//
// 坑二：无脑「启动新进程 → 立刻退出旧进程」是有风险的。
//   万一新进程因为任何原因没能起来（参数错、权限、被杀），
//   你就会两只手里都空了 —— 旧窗口关了，新窗口没有。
//   所以现在的做法是：
//     1. 先把旧窗口藏起来（避免两个桌宠同时出现在屏幕上）
//     2. 启动新进程
//     3. ★ 等它站稳（2 秒内没有退出）才真正退出自己
//     4. 如果它退了，就把旧窗口重新显示出来，并弹框告诉你
//   这样「自动重启」最坏的结果也只是「没重启成功」，而不会「得到一片空白」。
// ------------------------------------------------------------
function relaunchSelf() {
  const args = process.argv.slice(1);

  log(`[重启] ${process.execPath} ${args.join(' ')}`);

  // 先藏起旧窗口，避免两个桌宠同时出现
  if (win) win.hide();

  let child = null;
  try {
    child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
      env: process.env,
    });
    // unref 让新进程脱离当前进程独立存活，
    // 否则父进程一退，子进程会被一起带走。
    child.unref();
  } catch (err) {
    log('[重启] 启动新进程失败：' + err.message);
    if (win) win.show();
    if (loaded.configPath) {
      dialog.showErrorBox('自动重启失败', `没能启动新进程：\n${err.message}\n\n原来的窗口已恢复，可以继续使用。`);
    }
    return;
  }

  log(`[重启] 新进程 pid = ${child.pid}，等它站稳…`);

  let settled = false;

  // 新进程提前退出了 -> 说明重启失败，保住当前这个还能用的实例
  child.on('exit', (code, signal) => {
    if (settled) return;
    settled = true;
    log(`[重启] 新进程没能存活（code=${code}, signal=${signal}），继续使用当前进程`);
    if (win) win.show();
    if (loaded.configPath) {
      dialog.showErrorBox(
        '自动重启失败',
        '新进程没能启动成功，已经保住你原来的窗口。\n\n' +
          '可以直接关掉它、重新双击启动器；\n' +
          '详细原因看桌面上的 logs/desktop.log。'
      );
    }
  });

  // 站稳了 -> 交接完成，自己可以退了
  setTimeout(() => {
    if (settled) return;
    settled = true;
    log('[重启] 新进程已站稳，本进程退出');
    app.exit(0);
  }, 2000);
}

function startConfigWatcher() {
  if (!CONFIG.debug.watchConfig) {
    log('[配置] 热重载已关闭（debug.watchConfig = false）');
    return;
  }
  if (!loaded.configPath) {
    log('[配置] 没有指定配置文件，热重载不启用');
    return;
  }

  const configDir = path.dirname(loaded.configPath);
  const configFile = path.basename(loaded.configPath);
  let timer = null;

  try {
    configWatcher = fs.watch(configDir, { persistent: false }, (_event, filename) => {
      // filename 在个别平台上可能是 null，那就一律当作相关处理
      if (filename && filename !== configFile) return;

      // 一次保存往往会触发好几个事件（写入、属性变化、改名……），
      // 全部丢掉，只处理最后一次。
      clearTimeout(timer);
      timer = setTimeout(() => {
        log('[配置] 检测到配置文件变化，正在重启以应用新参数…');
        if (configWatcher) configWatcher.close();
        relaunchSelf();
      }, 400);
    });
    log(`[配置] 已开始监视 ${configFile}，保存后会自动重启`);
  } catch (err) {
    log('[配置] 监视失败（不影响使用，只是不能自动重启）：' + err.message);
  }
}

// ============================================================
// 五、IPC：渲染进程 -> 主进程
// ============================================================

// 【点击穿透的核心】
// 渲染进程每一帧（或在鼠标移动时）都会判断：光标现在是否落在模型的实体部分上。
//   hit = true  -> 光标在模型上，窗口要「接收」鼠标事件，这样点击才能触发交互
//   hit = false -> 光标在透明区域，窗口要「忽略」鼠标事件，让点击穿透到桌面
//
// forward: true 的作用：即使窗口忽略了鼠标事件，仍然把 mousemove 事件转发给页面，
// 这样渲染进程才能继续做射线检测。没有这个参数，鼠标一移到透明区就收不到事件，
// 也就再也没机会重新变回「接收」状态，等于桌宠卡死在穿透模式。
ipcMain.on('set-ignore-mouse', (event, hit) => {
  if (!win) return;
  win.setIgnoreMouseEvents(!hit, { forward: true });
});

// 【拖拽移动】—— 修复版
//
// 这里不再接收渲染进程算好的「位移增量」，而是由主进程自己每隔一段时间
// 读一次光标的屏幕绝对坐标，把窗口摆到「光标 - 偏移量」的位置。
//
// 为什么这么改？看 drag.js 顶部的详细说明。简单说：
// 渲染进程里的 e.clientX 是「光标相对窗口」的坐标，窗口一动它就跟着变，
// 用它算位移会形成反馈死循环，表现为窗口「走一步停一步」地闪。
//
// 主进程负责拖拽还有一个好处：位置计算在同一个坐标空间里（都是 DIP），
// 不会出现高 DPI 缩放下「屏幕坐标」和「窗口坐标」单位不一致的偏差。

let dragController = null;

// 光标位置的读取入口。
//
// 单独抽成函数是为了让拖拽逻辑可测试：
// 自动化测试可以通过设置 global.__deskpetTestCursor 来模拟光标移动，
// 从而在「不真的移动你的鼠标」的前提下验证窗口是否精确跟随。
// 正常运行时这个全局变量根本不存在，读到的永远是真实光标位置。
function readCursorPosition() {
  return global.__deskpetTestCursor || screen.getCursorScreenPoint();
}

ipcMain.on('drag-start', () => {
  if (!win) return;

  // 拖拽期间强制让窗口接收鼠标事件。否则如果此前处于穿透状态，
  // 鼠标松开的那一刻事件会穿到桌面，mouseup 收不到，拖拽就卡住了。
  win.setIgnoreMouseEvents(false);

  dragController = createDragController({
    getWindow: () => win,
    getCursor: readCursorPosition,
    interval: CONFIG.window.dragIntervalMs,
  });
  dragController.start();
});

ipcMain.on('drag-end', () => {
  if (dragController) {
    dragController.end();
    dragController = null;
  }
});

// 右键退出
ipcMain.on('quit-app', () => {
  app.quit();
});

// 【调试】F12 开关开发者工具 / Ctrl+R 重载页面
//
// 用页面里的按键事件而不是全局快捷键，是为了不抢占系统级的 F12。
// 窗口被点过之后就有焦点了，按 F12 就能开。
ipcMain.on('toggle-devtools', () => {
  if (!win) return;
  if (win.webContents.isDevToolsOpened()) {
    win.webContents.closeDevTools();
  } else {
    win.webContents.openDevTools({ mode: 'detach' });
  }
});

ipcMain.on('reload-renderer', () => {
  if (!win) return;
  // 注意：重载只重跑渲染层，改 config 请让它自动重启（或手动重启），
  // 因为主进程的配置在进程启动时就固定了。
  win.webContents.reload();
});

// 导出窗口引用与配置，供自动化测试（tests/*.test.js）使用。
// 正常运行时不涉及，不会有任何影响。
module.exports = {
  getWindow: () => win,
  getConfig: () => CONFIG,
  getLoaded: () => loaded,
};
