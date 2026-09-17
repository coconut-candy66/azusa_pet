// ============================================================
// config/ipc.js —— 把配置从主进程送到渲染进程的通道
//
// 为什么需要这么一个文件？
//
//   渲染进程是「沙箱」的（Electron 20 起默认开启），preload 里
//   虽然能 require('electron')，但**不能 require('fs') / require('path')**。
//   而我们的 config 加载器要读文件 —— 所以它没法在 preload 里跑。
//
//   解法：主进程先把配置读好，preload 用一个【同步】IPC 把它取过来。
//   同步是必须的 —— preload 必须在页面脚本运行之前就拿到配置，
//   否则 renderer.js 一上来就要用，会读到 undefined。
//
// 单独抽成模块还有第二个好处：测试可以复用同一个通道，
// 保证「测试环境」和「真实环境」用的是一模一样的握手协议。
// ============================================================

const { ipcMain } = require('electron');

// 频道名统一放这里，避免主进程和 preload 两边各写一遍字符串写错
const CHANNEL = 'deskpet:get-config';

function registerConfigIpc(config) {
  ipcMain.removeAllListeners(CHANNEL);
  ipcMain.on(CHANNEL, (event) => {
    // sendSync 的约定：把返回值写进 event.returnValue
    event.returnValue = config;
  });
}

module.exports = { registerConfigIpc, CHANNEL };
