// ============================================================
// config/index.js —— 配置加载器
//
// 三件事：
//   1. 找到用户配置文件（只看 DESKPET_CONFIG 环境变量，由启动器设置）
//   2. 把它和默认值【深度合并】—— 所以用户只写想改的那几项也完全没问题
//   3. ★ 出错了绝不能崩：退回默认值，并把错误原样交出去给人看
//
// 为什么配置来源只认环境变量，不去自动找 ../desktop/config.js？
//   因为测试必须不受用户配置影响。
//   如果你把窗口宽度从 320 改成 400，而 app.test.js 里断言的是 320，
//   一旦自动去读那份配置，测试就会莫名其妙地红 —— 那种「改配置导致测试挂」
//   的耦合最难查。所以规则定死：
//     启动器设置 DESKPET_CONFIG → 读用户配置
//     没设置                    → 只用内置默认值（测试就是这条路径）
// ============================================================

const fs = require('fs');
const path = require('path');
const DEFAULTS = require('./defaults');

// ------------------------------------------------------------
// 深度合并：把 user 的值盖到 base 上
//
// 规则：
//   - 两边都是「普通对象」-> 递归合并（所以漏写的项会自动保留默认值）
//   - 其他情况（数字/字符串/数组/布尔）-> 直接用 user 的，整个替换
//   - user 里值为 undefined -> 视为没写，保留默认值
//
// 数组是「整份替换」而不是逐项合并 —— 因为气泡台词这类数组
// 你多半是想整体换掉，而不是把默认台词和新台词掺在一起。
// ------------------------------------------------------------
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, user) {
  if (!isPlainObject(user)) return base;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);

  for (const key of Object.keys(user)) {
    const uv = user[key];
    if (uv === undefined) continue;              // 没写 -> 保留默认
    const bv = out[key];
    out[key] = isPlainObject(bv) && isPlainObject(uv) ? deepMerge(bv, uv) : uv;
  }
  return out;
}

// ------------------------------------------------------------
// 找出用户写了但默认值里没有的键，以及类型明显不对的项
//
// 这不是为了「拦住」用户，而是为了「告诉他」。
// 打错一个字母（peroid 而不是 period）在 JS 里不会报任何错，
// 只会表现为「我明明改了怎么没效果」—— 那是最耗时间的一种 bug。
// 所以这里主动收集一份清单，启动时打印出来。
// ------------------------------------------------------------
function collectIssues(defaults, user, prefix, out) {
  if (!isPlainObject(user)) return out;

  for (const key of Object.keys(user)) {
    const p = prefix ? `${prefix}.${key}` : key;

    if (!(key in defaults)) {
      out.push(`未知参数 ${p} —— 拼写错了？还是已经改名了？这一项会被忽略`);
      continue;
    }

    const dv = defaults[key];
    const uv = user[key];

    if (isPlainObject(dv)) {
      collectIssues(dv, uv, p, out);
    } else if (isPlainObject(uv)) {
      out.push(`参数 ${p} 应该是 ${typeof dv}，但你写了一个对象`);
    } else if (Array.isArray(dv) && !Array.isArray(uv)) {
      out.push(`参数 ${p} 应该是一个数组`);
    } else if (typeof dv === 'number' && typeof uv !== 'number') {
      out.push(`参数 ${p} 应该是数字，但你写的是 ${typeof uv}（是不是加了引号？）`);
    } else if (typeof dv === 'boolean' && typeof uv !== 'boolean') {
      out.push(`参数 ${p} 应该是 true / false，但你写的是 ${typeof uv}`);
    } else if (typeof dv === 'string' && typeof uv !== 'string') {
      out.push(`参数 ${p} 应该是字符串`);
    }
  }
  return out;
}

// ------------------------------------------------------------
// 解析配置文件路径。只看环境变量，理由见文件头的说明。
// ------------------------------------------------------------
function resolveConfigPath() {
  const fromEnv = process.env.DESKPET_CONFIG;
  if (fromEnv) {
    const abs = path.resolve(fromEnv);
    return fs.existsSync(abs) ? abs : null;
  }
  return null;
}

// ------------------------------------------------------------
// 加载配置
//
// 返回值：
//   config     —— 合并后的最终配置（永远可用，出错时就是默认值）
//   configPath —— 实际读到的配置文件路径；null 表示用的是内置默认值
//   error      —— 读取出错时的原始 Error；正常为 null
//   issues     —— 拼写/类型问题清单（只是提醒，不影响运行）
// ------------------------------------------------------------
function loadConfig() {
  const configPath = resolveConfigPath();

  if (!configPath) {
    return { config: DEFAULTS, configPath: null, error: null, issues: [] };
  }

  let userConfig;
  try {
    // 清掉 require 缓存，否则热重载时读到的还是上一次的内容
    delete require.cache[require.resolve(configPath)];
    userConfig = require(configPath);
  } catch (err) {
    // 配置写坏了（少个括号、多个逗号……）不要让它把整个应用带走。
    // 退回默认值，把错误原样带出去，由 main.js 显示给人看。
    return { config: DEFAULTS, configPath, error: err, issues: [] };
  }

  if (!isPlainObject(userConfig)) {
    return {
      config: DEFAULTS,
      configPath,
      error: new Error('配置文件必须导出一个对象，例如 module.exports = { ... }'),
      issues: [],
    };
  }

  const config = deepMerge(DEFAULTS, userConfig);
  const issues = collectIssues(DEFAULTS, userConfig, '', []);

  return { config, configPath, error: null, issues };
}

// ------------------------------------------------------------
// 二次校验：合并后的值有没有明显不合理的
//
// 这类错误（比如窗口宽度写成 0）不会抛异常，但会让窗口变成
// 一个你看不见的细条，排查起来很费劲。这里提前拦一道。
// ------------------------------------------------------------
function validate(config) {
  const problems = [];

  const requirePositive = (v, name) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      problems.push(`${name} 必须是大于 0 的数字，当前是 ${JSON.stringify(v)}`);
      return false;
    }
    return true;
  };

  // 必须是 0~1 的比例值。写成 88 这种「百分比」是很常见的笔误，
  // 后果是立绘被放大 88 倍、整个屏幕都是她，所以值得单独拦一道。
  const requireRatio = (v, name) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1) {
      problems.push(
        `${name} 应该是 0~1 之间的比例（比如 0.88），当前是 ${JSON.stringify(v)}` +
          '——是不是把百分比写成整数了？'
      );
      return false;
    }
    return true;
  };

  requirePositive(config.window.width, 'window.width');
  requirePositive(config.window.height, 'window.height');
  requirePositive(config.window.dragIntervalMs, 'window.dragIntervalMs');

  requireRatio(config.placement.centerX, 'placement.centerX');
  requireRatio(config.placement.groundY, 'placement.groundY');
  requireRatio(config.placement.heightRatio, 'placement.heightRatio');
  requireRatio(config.vector.headHeightRatio, 'vector.headHeightRatio');

  requirePositive(config.animation.breath.period, 'animation.breath.period');
  requirePositive(config.animation.sway.period, 'animation.sway.period');
  requirePositive(config.animation.float.period, 'animation.float.period');
  if (config.sprite.enabled && !config.sprite.files.idle) {
    problems.push('sprite.enabled 打开了，但 sprite.files.idle 是空的 —— 没有图可显示');
  }

  // ★ 这条一开始写错了，值得记下来：
  //   我最初写的是「groundY + heightRatio > 1.6 就报警」，
  //   本意是「立绘别比窗口还大」。但那两个数一个是「脚底位置」、
  //   一个是「身高」，相加没有意义 —— 结果它对出厂默认值
  //   (0.96 + 0.76 = 1.72) 直接报假警。
  //   一条会对自己默认值报警的校验规则，比没有校验更糟：
  //   你会开始习惯性忽略它，真出问题时也看不见。
  //
  //   有意义的量是【头顶位置】= groundY - heightRatio：
  //     小于 0        -> 头顶冒出窗口外，会被切掉
  //     小于 0.08     -> 头顶离窗口顶太近，气泡没地方放
  const headroom = config.placement.groundY - config.placement.heightRatio;
  if (headroom < 0) {
    problems.push(
      `placement 的 groundY(${config.placement.groundY}) 比 heightRatio` +
        `(${config.placement.heightRatio}) 还小，立绘的头顶会冒出窗口外面被切掉。` +
        '要么调小 heightRatio，要么调大 groundY。'
    );
  } else if (headroom < 0.08) {
    problems.push(
      `placement 头顶离窗口顶部只剩 ${(headroom * 100).toFixed(1)}% 的空档，` +
        '气泡和左上角面板会没地方放。建议把 heightRatio 调到 ' +
        `groundY - 0.2 左右（当前约 ${(config.placement.groundY - 0.2).toFixed(2)}）。`
    );
  }

  if (!Array.isArray(config.reaction.bubbleLinesHappy) || config.reaction.bubbleLinesHappy.length === 0) {
    problems.push('reaction.bubbleLinesHappy 不能是空数组，否则开心时没台词可说');
  }
  if (!Array.isArray(config.reaction.bubbleLinesNeutral) || config.reaction.bubbleLinesNeutral.length === 0) {
    problems.push('reaction.bubbleLinesNeutral 不能是空数组');
  }

  return problems;
}

module.exports = { DEFAULTS, loadConfig, resolveConfigPath, deepMerge, validate, collectIssues };
