# 桌面使用说明

返回 [项目首页](../README.md) · [开发说明](../deskpet-demo/README.md)

## 启动

| 文件 | 用途 |
| --- | --- |
| [启动桌宠.cmd](启动桌宠.cmd) | 日常启动 |
| [兼容模式启动.cmd](兼容模式启动.cmd) | 软件渲染，用于显卡兼容性问题 |
| [调试启动.cmd](调试启动.cmd) | 打开开发者工具并持续显示日志 |
| [_启动自检.cmd](_启动自检.cmd) | 排查启动脚本与运行环境 |
| [桌面自检说明.txt](桌面自检说明.txt) | 原有离线排查说明 |

启动器读取本目录的 `config.js`，并调用隔壁 `deskpet-demo/node_modules/electron/dist/electron.exe`。本机已具备依赖；新环境若提示缺少 Electron，按 [项目首页](../README.md) 安装依赖。

正常启动时控制台会短暂停留。右键单击人物可直接退出，左键单击换装，按住拖动可移动人物。

## 调整参数

编辑 [config.js](config.js)，保存后自动重启（由 `debug.watchConfig` 控制）。

| 目标 | 配置 |
| --- | --- |
| 调整人物大小 | `placement.heightRatio`；人物高度按该比例乘以窗口高度计算 |
| 调整初始位置 | `window.marginRight`、`window.marginBottom` |
| 添加或减少服装 | `sprite.outfits` |
| 固定显示某一套 | 将 `sprite.outfitSwitch.enabled` 设为 `false`，并修改 `sprite.dir` |
| 调整呼吸、摇摆、浮动 | `animation.breath`、`animation.sway`、`animation.float` |
| 启用点击气泡 | `reaction.pokeBubble = true` |
| 启用点击形变 | `reaction.pokeSquash = true` |
| 修改预设台词 | `reaction.bubbleLinesHappy`、`reaction.bubbleLinesNeutral` |
| 查看点击范围 | `debug.showHitMask = true` |
| 显示调试面板 | `debug.showHud = true` |
| 使用代码绘制的人物 | `sprite.enabled = false` |

当前两项点击反馈开关都是 `false`，调试面板也是关闭的；呼吸、摇摆、浮动照常运行。贴图模式不切换表情，也没有眨眼参数。完整参数定义见 [defaults.js](../deskpet-demo/config/defaults.js)。

`sprite.root` 和 `sprite.dir` 使用相对于 `deskpet-demo/src/` 的路径。例如运行素材根目录是 `../assets/sprites`。

## 故障排查

| 现象 | 检查方式 |
| --- | --- |
| 缺少 Electron | 在 `deskpet-demo` 安装依赖 |
| 桌宠未出现或日志有 GPU 错误 | 尝试兼容模式，再使用调试启动 |
| 配置修改没有生效 | 查看 `logs/desktop.log` 中的参数名、类型和范围提示 |
| 点不到人物或点空白也触发 | 打开命中范围显示，检查对应 `mask.json` 是否与 `idle.png` 匹配 |
| 换图后仍显示旧素材 | 退出桌宠后重新启动 |
| 启动脚本一闪而过 | 运行自检；检查文件编码及换行是否被编辑器改动 |

## 文件维护

`logs/` 是运行产物，不纳入版本控制。配置与启动器留在当前目录，与 `deskpet-demo` 保持相邻。

本项目现有 `.cmd` 文件使用 **GBK 编码和 CRLF 换行**；修改时保留原编码和换行，不插入切换代码页的命令。`.gitattributes` 已设置为保留这些文件的原始字节。本次整理未修改启动器或用户配置。
