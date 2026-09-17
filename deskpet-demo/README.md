# 程序与开发说明

本目录为 Electron 应用。日常运行请看 [项目首页](../README.md) 和 [桌面使用说明](../desktop/README.md)。

## 代码入口

| 路径 | 职责 |
| --- | --- |
| `main.js` | 窗口、置顶、鼠标穿透、拖拽通信、配置重载 |
| `drag.js` | 拖拽控制逻辑 |
| `preload.js` | 配置桥接及受限 API |
| `config/defaults.js` | 默认参数 |
| `config/index.js` | 配置加载、合并、校验与回退 |
| `config/ipc.js` | 配置通信 |
| `src/index.html` | 页面结构与样式 |
| `src/renderer.js` | 动画、换装、几何与命中判定 |
| `assets/sprites/` | 运行素材：5 套服装、15 张 PNG、5 份遮罩 |
| `tools/` | 素材处理脚本 |
| `tests/` | 单元、集成、截图与诊断测试 |

坐标约定、换装流程和测试经验见 [技术说明](../docs/technical-notes.md)。

## 安装与开发启动

以下命令在本目录的 PowerShell 中运行：

```powershell
npm install
$env:DESKPET_CONFIG = (Resolve-Path ..\desktop\config.js).Path
npm start
```

兼容模式使用 `npm run start:safe`。没有设置 `DESKPET_CONFIG` 时加载内置默认配置，可能显示矢量人物，与桌面启动器的立绘配置不同。

## 测试

四个基础测试套件按内置默认配置运行，先清除当前终端中的用户配置变量：

```powershell
Remove-Item Env:DESKPET_CONFIG -ErrorAction SilentlyContinue
npm test
```

| npm 脚本 | 覆盖内容 |
| --- | --- |
| `test:drag` | 拖拽逻辑，使用 Node.js |
| `test:ui` | 渲染几何、命中、动画与交互，使用 Electron |
| `test:app` | 主进程拖拽集成，使用 Electron |
| `test:config` | 配置对实际画面的影响，使用 Electron |

立绘相关检查需要加载桌面配置：

```powershell
$env:DESKPET_CONFIG = (Resolve-Path ..\desktop\config.js).Path
npm run smoke
& .\node_modules\.bin\electron.cmd tests/smoke/outfit-photo.js
& .\node_modules\.bin\electron.cmd tests/smoke/no-blink.js
& .\node_modules\.bin\electron.cmd tests/diagnostics/alpha-profile.js
```

这些脚本依赖 Electron，不使用 `node tests/smoke/...` 运行。截图写入 `screenshots/`，目录会自动创建。只有拖拽纯逻辑套件不需要 Electron；不要把整套测试描述为纯 Node.js 测试。

## 立绘维护

每套素材使用一个子目录，包含：

| 文件 | 当前用途 |
| --- | --- |
| `idle.png` | 实际显示的透明立绘 |
| `happy.png`、`surprise.png` | 备用素材，当前不用于表情切换 |
| `mask.json` | 从 idle 的透明通道生成的点击遮罩 |

当前运行目录以 `zh1_` 至 `zh5_` 开头；美术成品归档在 `../art/final/`，对应目录沿用 `yq1_` 至 `yq5_`。这两套命名有对应关系，勿直接混用。

### 新增素材

通用工具依赖 Python 与 Pillow：

```powershell
python -m pip install pillow
python tools/make-sprite.py --help
```

已带透明通道的原图，可输出到新的临时目录检查：

```powershell
python tools/make-sprite.py --idle raw/idle.png --bg none --out raw/prepared --height 719
```

对白色等平色背景，可尝试 `--bg flood --tol 30`；洋红幕布可使用 `--bg key --key FF00FF`。角色衣服与底色接近时应逐张检查，不能只提高容差。工具可能裁切和缩放素材，已有精细抠图无需再跑通用抠底。

检查透明背景、发丝、衣料和脚底后，把输出目录放入 `assets/sprites/`，在 `../desktop/config.js` 的 `sprite.outfits` 中添加目录名。更新 idle 时同步重建遮罩。为避免切换跳动，统一人物高度、脚底和中线；若以后使用表情图，各帧还应保持相同姿势。

### 复现 2026-09-17 抠图

专用脚本依赖 Pillow、NumPy、SciPy，从固定备份读取原图，仅修改透明通道：

```powershell
python -m pip install pillow numpy scipy
python tools/clean-sprites-20260917.py
```

默认写入 `../art/reports/2026-09-17-cutout/`，不替换运行素材。确认检查稿后，使用 `--install` 同步到运行目录和 `art/final`。脚本包含针对这批图片的坐标与服装保护区域，不能直接套用到新立绘。

详细结果与原图位置见 [美术资料索引](../art/README.md)。
