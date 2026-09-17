// ============================================================
// drag.js —— 拖拽控制器（独立模块）
//
// 为什么单独抽成一个文件？
//   1. 拖拽属于「窗口层」的职责，和 3D 渲染无关，本就该放在主进程
//   2. 抽成模块后可以脱离 Electron 单独测试（见 tests/drag.test.js）——
//      拖拽这种强依赖坐标的逻辑，不写测试非常容易反复出 bug
//
// 这里有【两个】坑，都是实测踩出来的，修复方式完全不同，别混淆：
//
// ------------------------------------------------------------
// 坑 1：不要用「鼠标位移增量」来移动窗口 —— 会导致高频闪烁
// ------------------------------------------------------------
//
// ❌ 错误做法（Demo 第一版就是这样的）：
//      在渲染进程里读 e.clientX（光标【相对窗口】的坐标），
//      算出和上一帧的差值 dx，然后把窗口移动 dx。
//
//    为什么必然出 bug？
//      clientX = 光标屏幕坐标 - 窗口左边
//      你把窗口往右移了 dx，等号右边第二项就变了，
//      下一帧读到的 clientX 也跟着变 —— 你追的是自己刚挪动的东西。
//
//      实测：窗口以「走一步、停一步」前进（速度只有光标的一半），
//      再加上取整误差会左右抖，看起来就是「高频闪烁」。
//
// ✅ 正确做法：按下时记录一次「光标屏幕坐标 - 窗口位置」的偏移量，
//    之后每隔 16ms 读一次光标的屏幕绝对坐标，把窗口摆到「光标 - 偏移量」。
//    绝对坐标不含任何「上一帧的值」，所以不存在反馈循环。
//
// ------------------------------------------------------------
// 坑 2（更隐蔽）：必须用 setBounds，不能用 setPosition —— 会导致「越拖越大」
// ------------------------------------------------------------
//
//    实测：在 125% 显示缩放的 Windows 上，反复调用 win.setPosition(x, y)
//    会让窗口【越拖越高】。每次移动后记录窗口高度，共移动 60 次：
//
//        setPosition              : 424 -> 437 -> 451 -> ... -> 504  （高了 80px）
//        setBounds + 显式宽高      : 424 -> 421 -> 421 -> ... -> 421  （完全稳定）
//        thickFrame:false+setPosition: 424 -> 437 -> ... -> 504       （无效）
//
//    为什么？setPosition 只声明位置、把尺寸留给系统决定，
//    而 Windows 在每次移动时会按当前 DPI 重新推算窗口矩形，
//    非客户区的取整方式来回不一致，误差就一点点累积上去了。
//    setBounds 每次把宽高一并写死，系统就没有自由发挥的余地。
//
//    这个 bug 的表现就是「拖动时模型体积不断变大」：
//    窗口变高 -> 画布变高 -> 相机垂直视场角固定 -> 模型在屏幕上显得越来越大。
//    所以这里必须显式带上 width/height。
//
// ============================================================

function createDragController({ getWindow, getCursor, interval = 16, onEnd }) {
  // 光标相对窗口左上角的偏移量。为 null 表示当前没有在拖拽。
  let offset = null;

  // 拖拽开始时锁定的窗口尺寸。每次移动都原样带上，防止被系统改动。
  let size = null;

  let timer = null;
  let totalMoved = 0;   // 本次拖拽光标走过的总距离，用于区分「点击」和「拖拽」
  let lastCursor = null;

  function tick() {
    const win = getWindow();
    if (!win || !offset || !size) return;

    const cursor = getCursor();

    // 累计光标走过的距离。注意累加的是「光标」的位移，不是窗口的位移，
    // 所以即使窗口因为性能原因跟不上，这个数字也是真实的手部移动量。
    if (lastCursor) {
      totalMoved += Math.hypot(cursor.x - lastCursor.x, cursor.y - lastCursor.y);
    }
    lastCursor = cursor;

    // ★ 关键：用 setBounds 并且显式带上宽高。
    //   —— 绝对定位（不用增量）解决了坑 1 的闪烁；
    //   —— 显式宽高解决了坑 2 的「越拖越大」。
    win.setBounds({
      x: Math.round(cursor.x - offset.x),
      y: Math.round(cursor.y - offset.y),
      width: size.width,
      height: size.height,
    });
  }

  function start() {
    const win = getWindow();
    if (!win) return;

    const cursor = getCursor();
    const b = win.getBounds();

    // 记录「光标在窗口内的相对位置」。之后窗口始终维持这个相对位置不变，
    // 等效于「光标粘住了窗口上的那个点」。
    offset = { x: cursor.x - b.x, y: cursor.y - b.y };

    // 锁定此刻窗口的真实尺寸（包含高 DPI 下的取整结果），
    // 这样拖拽全程不会有任何尺寸跳变。
    size = { width: b.width, height: b.height };

    totalMoved = 0;
    lastCursor = cursor;

    if (timer) clearInterval(timer);
    timer = setInterval(tick, interval);
    tick();   // 立刻执行一次，避免按下后第一帧迟钝
  }

  function end() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    const moved = totalMoved;
    offset = null;
    size = null;
    lastCursor = null;
    totalMoved = 0;
    if (onEnd) onEnd(moved);
    return moved;
  }

  return {
    start,
    end,
    isActive: () => timer !== null,
  };
}

module.exports = { createDragController };
