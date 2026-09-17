# 2D 桌宠

Windows 桌面上的 Q 版中野梓桌宠。支持透明置顶、拖拽、点击穿透，以及点击切换 5 套立绘。当前使用普通双马尾立绘，不显示猫耳。

## 启动与操作

本机已包含 Electron 运行依赖，双击 [启动桌宠.cmd](desktop/启动桌宠.cmd) 即可。

| 操作 | 效果 |
| --- | --- |
| 左键单击人物 | 更换一套服装；每轮不重复，相邻两次不同 |
| 按住人物拖动 | 移动桌宠 |
| 右键单击人物 | 直接退出 |
| F12 | 切换开发者工具 |
| Ctrl+R | 重载页面 |

人物持续播放呼吸、摇摆和浮动动画。当前配置关闭了点击气泡与点击压扁效果，也没有眨眼、自动表情切换、AI 对话或长期记忆。

启动异常时使用 [兼容模式启动.cmd](desktop/兼容模式启动.cmd) 或 [调试启动.cmd](desktop/调试启动.cmd)。更多操作见 [桌面使用说明](desktop/README.md)。

### 新复制或克隆的项目

若缺少 `deskpet-demo/node_modules/electron/dist/electron.exe`，先安装 Node.js 与 npm，在 PowerShell 中进入 `2D/deskpet-demo` 执行：

```powershell
npm install
```

依赖安装完成后，日常双击启动器不需要单独调用 Node.js。复制项目时应保留 `desktop` 与 `deskpet-demo` 的相对位置。

## 目录导航

```text
2D/
├── README.md                       项目入口
├── desktop/                        启动器、用户配置、运行日志
├── deskpet-demo/                    Electron 程序、运行素材、工具与测试
│   ├── assets/sprites/              程序实际读取的 5 套立绘
│   ├── config/                      默认配置、校验、IPC
│   ├── src/                         页面和渲染逻辑
│   ├── tools/                       通用素材工具与本次抠图脚本
│   ├── tests/                       单元、集成、截图与诊断测试
│   ├── screenshots/                 测试生成的截图
│   └── node_modules/                本地运行依赖
├── docs/                            技术说明、路线图、整理记录
├── art/                             本地美术资料
│   ├── final/                       当前成品的美术归档
│   ├── backups/                     修改前的素材与文档备份
│   └── reports/                     抠图检查稿、预览、验证报告
└── refs/                            角色参考图
```

| 要做的事 | 从这里开始 |
| --- | --- |
| 调整大小、位置、动画、换装 | [desktop/README.md](desktop/README.md) |
| 修改代码或运行测试 | [deskpet-demo/README.md](deskpet-demo/README.md) |
| 了解坐标、命中判定与不做眨眼的原因 | [技术说明](docs/technical-notes.md) |
| 查看立绘、备份和处理记录 | [美术资料索引](art/README.md) |
| 查看后续开发方向 | [路线图](docs/roadmap.md) |
| 查看这次目录迁移与核验 | [整理记录](docs/organization-20260917.md) |

## 修改配置

编辑 [desktop/config.js](desktop/config.js)。当前已启用 `debug.watchConfig`，保存配置后程序自动重启。完整默认值和校验逻辑分别在 `deskpet-demo/config/defaults.js` 与 `deskpet-demo/config/index.js`。

常用参数为 `placement.heightRatio`（人物大小）、`sprite.outfits`（换装列表）、`animation`（动作）和 `reaction`（点击反馈）。修改 PNG 后应退出并重新启动桌宠，避免仍显示缓存的图片。

## 当前立绘

共 5 套服装：冬制服围巾贝雷帽、水手服领巾、女仆装蕾丝围裙、冬休闲牛角扣大衣、休闲粉卫衣。

每套目录包含 `idle.png`、`happy.png`、`surprise.png` 和 `mask.json`。当前只有 `idle.png` 实际显示，另外两张是备用表情；`mask.json` 用于人物轮廓的点击判定。

2026-09-17 已完成 15 张 PNG 的透明边缘清理，并去除水手服裙子右侧多余部分。保留原图尺寸与 RGB 数据，更新透明通道和 5 份点击遮罩。处理结果、原图备份和验证日志见 [美术资料索引](art/README.md)。

## 素材说明

角色与参考图涉及原作品权利，本项目不包含这些素材的授权声明。项目沿用自用、不公开分发角色素材的管理约定。运行素材与参考资料的存放方式见 `.gitignore` 和美术资料索引。
