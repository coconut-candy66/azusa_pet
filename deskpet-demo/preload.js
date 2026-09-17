// ============================================================
// preload：主进程与渲染进程之间的安全桥梁
//
// 因为开了 contextIsolation，渲染进程不能直接 require('electron')。
// 所以这里用 contextBridge 只暴露「必要的几个函数」给页面用。
// 这样即使页面里有恶意脚本，也拿不到完整的 Node 能力。
//
// ★ 本次改造增加了「把配置送进页面」这件事。
//   注意：preload 跑在沙箱里，不能 require('fs') / require('path')，
//   所以它没法自己去读配置文件。配置由主进程读好后，
//   通过一个【同步】IPC 取过来（见 config/ipc.js 的详细说明）。
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

// ------------------------------------------------------------
// ★ 这里必须写字符串字面量，不能 require('../config/ipc')。
//
//   原因是 preload 跑在【沙箱】里（Electron 20 起默认开启），
//   沙箱里的 require 只能加载极少数内置模块（electron / events /
//   timers / url），**连项目里的相对路径文件都不让 require**。
//   踩过的报错长这样：
//       Error: module not found: ../config/ipc
//
//   代价是这个频道名写了两遍。为了不让两边写歪，
//   tests/config.test.js 里有一条断言专门核对它们一致。
// ------------------------------------------------------------
const CHANNEL = 'deskpet:get-config';

// ------------------------------------------------------------
// 取配置
//
// 用 sendSync 而不是 invoke，是因为 preload 必须在页面脚本
// 执行之前就把配置准备好 —— renderer.js 第一行就要用。
// 异步的话得在页面里 await，会逼着 renderer.js 整个包一层 async。
//
// 兜底：万一主进程没注册这个频道（比如某个测试只加载了页面、
// 没加载 main.js），sendSync 会拿到 undefined。这时候给一个
// 带 _missing 标记的空对象，renderer.js 会明确地报出来，
// 而不是抛一堆 "Cannot read property of undefined" 让人猜。
// ------------------------------------------------------------
let config;
try {
  config = ipcRenderer.sendSync(CHANNEL);
} catch (err) {
  config = null;
}

if (!config || typeof config !== 'object') {
  config = {
    _missing: true,
    _reason: '没有从主进程拿到配置（config/ipc.js 的频道没有注册）',
  };
}

contextBridge.exposeInMainWorld('petConfig', config);

contextBridge.exposeInMainWorld('petAPI', {
  // 告诉主进程：光标现在是否落在模型上
  // true  = 在模型上，窗口接收鼠标事件
  // false = 在透明区，窗口忽略鼠标事件（穿透到桌面）
  setIgnoreMouse: (hit) => ipcRenderer.send('set-ignore-mouse', hit),

  // 拖拽开始 / 结束。
  // 注意这里不传任何坐标 —— 位移的计算完全由主进程负责，
  // 渲染进程只负责「通知开始」和「通知结束」。
  // 这样职责清晰，也不会再出现坐标反馈死循环（详见 drag.js）。
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),

  // 退出应用（右键菜单用）
  quit: () => ipcRenderer.send('quit-app'),

  // 调试用：F12 开关开发者工具、Ctrl+R 重载渲染层
  toggleDevTools: () => ipcRenderer.send('toggle-devtools'),
  reloadRenderer: () => ipcRenderer.send('reload-renderer'),
});
