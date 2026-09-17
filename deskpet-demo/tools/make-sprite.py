# -*- coding: utf-8 -*-
"""把立绘素材处理成能直接用的形式，并烘焙命中判定遮罩。

用法（在 deskpet-demo 目录下）：
    python tools/make-sprite.py --idle raw/idle.png --happy raw/happy.png ^
                                --surprise raw/surprise.png --out assets/sprites

    # 素材是不透明底（比如纯品红背景）时，加 --key 把底色键掉
    python tools/make-sprite.py --idle raw/idle.png --key FF00FF --out assets/sprites

它做四件事：
    1. 抠底（可选）：把指定的底色变成透明，并修掉边缘残留的底色毛边
    2. 裁切：把这套里的所有图用【同一个】包围盒裁，保证换装时人不会跳
    3. 缩放：统一缩放到指定高度
    4. ★ 烘焙遮罩 mask.json —— 命中判定用的 0/1 网格

------------------------------------------------------------
★ 为什么要有遮罩这一步？不能直接读像素吗？

  不能。渲染层用的是 DOM + <img>，不是 canvas；而就算用 canvas，
  在 file:// 下把本地图片画上去再 getImageData 会被判「跨域污染」，
  直接抛 SecurityError。

  所以改成：**离线**在 Python 里把 alpha 通道降采样成一张粗网格，
  存成一个小 JSON 带给渲染层。运行时只需要按坐标查表，
  既没有跨域问题，也快得多，还顺带让命中判定变成一段可单独测试的纯数学。

------------------------------------------------------------
★ 遮罩格式（必须和 src/renderer.js 的 decodeBits 完全一致）：

  { "w": 64, "h": 96, "bits": "<base64>" }

  · bits 解出来是 (w×h) 个 bit，行优先，第 i 位对应 (i/w, i%w)
  · ★ 每行【不】补齐到字节边界，整张图连着排
  · 字节内 MSB 优先（第 0 位是最高位）

  这点很容易搞错：很多位图格式每行会补 0 到整字节。如果这边按补齐写、
  那边按连续解（或反过来），画面会整体斜掉 —— 而且斜得不多，特别难查。
"""
import argparse
import base64
import os
import sys

try:
    from PIL import Image
except ImportError:
    print("需要 Pillow：pip install pillow", file=sys.stderr)
    sys.exit(2)


# ------------------------------------------------------------
# 底色键控
#
# 做法不是「离底色多远就砍掉」那么简单，还得处理【毛边】：
# 抗锯齿的边缘像素是角色色和底色的混合，直接砍会留一圈底色描边；
# 用「按混合比例反推原色」的办法（despill）才能真正修干净。
# ------------------------------------------------------------
def chroma_key(img, hex_color, tol=60, despill=True):
    """把接近 hex_color 的像素变透明，并把边缘上的底色污染减掉。"""
    img = img.convert("RGBA")
    kr = int(hex_color[0:2], 16)
    kg = int(hex_color[2:4], 16)
    kb = int(hex_color[4:6], 16)
    px = img.load()
    w, h = img.size

    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            # 到目标色的距离（用切比雪夫距离，四舍五入无关紧要，够用）
            d = max(abs(r - kr), abs(g - kg), abs(b - kb))
            if d <= tol:
                px[x, y] = (0, 0, 0, 0)
            elif d <= tol * 2:
                # 边缘过渡带：按「离底色有多近」给一个透明度，
                # 让轮廓是渐隐的而不是锯齿状的硬边
                t = (d - tol) / float(tol)          # 0..1
                na = int(255 * t)
                if despill:
                    # 把这个像素里「底色的成分」拉回去。
                    # 底色越饱和（比如纯品红），这一步越重要。
                    r = int((r - kr * (1 - t)) / t) if t > 0.02 else r
                    g = int((g - kg * (1 - t)) / t) if t > 0.02 else g
                    b = int((b - kb * (1 - t)) / t) if t > 0.02 else b
                    r, g, b = (max(0, min(255, v)) for v in (r, g, b))
                px[x, y] = (r, g, b, na)
    return img


def content_bbox(img, alpha_min=8):
    """不透明内容的包围盒。"""
    return img.getchannel("A").point(lambda v: 255 if v >= alpha_min else 0).getbbox()


def bake_mask(ref_path, out_json, mask_h, threshold=128, alpha_min=128):
    """从参考图烘焙遮罩。"""
    img = Image.open(ref_path).convert("RGBA")
    w, h = img.size
    mask_w = max(1, int(round(mask_h * w / float(h))))

    # 缩小用 BOX（区域平均）而不是最近邻 ——
    # 平均之后「边缘半透明」的位置会落在中间值上，配合阈值就是一条平滑的边。
    # 最近邻会让边缘随机地整格有/整格没有，判定区看起来像被啃过。
    small = img.getchannel("A").resize((mask_w, mask_h), Image.BOX)

    # ★ 用 tobytes() 而不是 getdata()：
    #   getdata() 在 Pillow 14（2027）会被移除，而且它是 O(n) 返回一个序列，
    #   在大图上很慢；tobytes() 是稳定接口，直接给一段 bytes，快得多。
    #   "L" 模式下正好是一像素一字节。
    alphas = small.tobytes()

    bits = bytearray((mask_w * mask_h + 7) // 8)
    on = 0
    for i in range(mask_w * mask_h):
        if alphas[i] >= threshold:
            bits[i >> 3] |= 1 << (7 - (i & 7))     # MSB 优先
            on += 1

    b64 = base64.b64encode(bytes(bits)).decode("ascii")
    with open(out_json, "w", encoding="utf-8") as f:
        f.write('{\n')
        f.write('  "w": %d,\n' % mask_w)
        f.write('  "h": %d,\n' % mask_h)
        f.write('  "source": "%s",\n' % os.path.basename(ref_path))
        f.write('  "filledRatio": %.4f,\n' % (on / float(mask_w * mask_h)))
        f.write('  "bits": "%s"\n' % b64)
        f.write('}\n')

    return mask_w, mask_h, on / float(mask_w * mask_h)


# ------------------------------------------------------------
# 编码器自检 —— 不靠「看起来对」
#
# 把烘好的遮罩按渲染层的规则解回来，和直接降采样的结果逐个像素比。
# 只要打包/解包有任何一处不对（比如行是否补齐、MSB 还是 LSB），
# 这里立刻就能发现，不用等到画面歪了再回头猜。
# ------------------------------------------------------------
def verify_mask(out_json, ref_path, mask_h, threshold=128):
    import json
    with open(out_json, "r", encoding="utf-8") as f:
        data = json.load(f)
    mw, mh = data["w"], data["h"]
    raw = base64.b64decode(data["bits"])

    # 按渲染层的规则解
    decoded = []
    for i in range(mw * mh):
        byte = raw[i >> 3]
        decoded.append((byte >> (7 - (i & 7))) & 1)

    # 直接算一遍作为对照
    img = Image.open(ref_path).convert("RGBA")
    w, h = img.size
    mw2 = max(1, int(round(mask_h * w / float(h))))
    small = img.getchannel("A").resize((mw2, mh), Image.BOX).tobytes()
    expect = [1 if v >= threshold else 0 for v in small]

    if mw != mw2:
        return False, "宽高对不上：json %d vs 计算 %d" % (mw, mw2)
    diff = sum(1 for a, b in zip(decoded, expect) if a != b)
    return diff == 0, "%d 个格子，不一致 %d 个" % (len(expect), diff)


def flood_bg(img, tol=32, base_out=None, base=None):
    """从画面【四边】向内泛洪，把连通的背景变透明。

    ★ 什么时候必须用它、不能只用 chroma_key（全局抠色）？
      当角色身上有和背景同色的部分时。
      这一版立绘就是典型：背景是白的，而她的衬衫领子也是白的 ——
      全局抠色会把领子一起抠掉，人就没脖子了。
      泛洪只吃「和画面边缘连通」的那片区域，被角色围住的白色领子
      碰不到边缘，所以安全。
      （顺带也能处理模型画上去的「假透明棋盘格」——那种格子是规则
        两色图案，泛洪照样能吃干净。）

    用显式栈而不是递归，避免大图爆栈。
    """
    img = img.convert("RGBA")
    W, H = img.size
    px = img.load()

    # 以四角的【中位色】当背景基准 —— 取中位数而不是平均值，
    # 这样万一某一角被水印或阴影占了，也不会把基准色带偏。
    # ★ 也允许调用方直接传 base：第二次泛洪（清被阴影封住的口袋）时，
    #   四角已经被抠成 (0,0,0,0)，再读四角会把基准色读成纯黑，
    #   近黑的人物描边 / 黑袜就会被当成背景吃掉（踩过）。
    if base is not None:
        br, bg, bb = base
    else:
        cs = [px[0, 0], px[W - 1, 0], px[0, H - 1], px[W - 1, H - 1]]
        br = sorted(c[0] for c in cs)[1]
        bg = sorted(c[1] for c in cs)[1]
        bb = sorted(c[2] for c in cs)[1]
    # ★ 把基准色回传给调用方：后面「带内泛洪」还要用它。
    #   如果那时候再去读四角，读到的是已经被抠成 (0,0,0) 的透明角，
    #   基准色就变成纯黑，近黑的人物描边 / 黑袜会被当成背景吃掉（踩过）。
    if base_out is not None:
        base_out.append((br, bg, bb))

    def dist(p):
        return abs(p[0] - br) + abs(p[1] - bg) + abs(p[2] - bb)

    removed = bytearray(W * H)
    seen = bytearray(W * H)
    stack = []
    for x in range(W):
        stack.append((x, 0))
        stack.append((x, H - 1))
    for y in range(H):
        stack.append((0, y))
        stack.append((W - 1, y))

    limit = tol * 3
    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= W or y >= H:
            continue
        i = y * W + x
        if seen[i]:
            continue
        seen[i] = 1
        p = px[x, y]
        if p[3] >= 16 and dist(p) > limit:
            continue          # 碰到角色了，停在这一格
        px[x, y] = (0, 0, 0, 0)
        removed[i] = 1
        stack.append((x + 1, y))
        stack.append((x - 1, y))
        stack.append((x, y + 1))
        stack.append((x, y - 1))

    # 收尾：抗锯齿会在人物边上留一圈「半背景色」的像素，缩下去之后
    # 就是一圈白边。只对【紧挨着被抠掉区域】的像素做处理，
    # 按「离背景色有多远」折算 alpha ——
    # ★ 必须限定在这一圈里，不能全图做：她的裙子和领子本来就浅，
    #   全图做会把裙子和领子一起削成半透明。
    fixed = 0
    for y in range(H):
        for x in range(W):
            i = y * W + x
            if removed[i] or px[x, y][3] < 16:
                continue
            near = False
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                xx, yy = x + dx, y + dy
                if 0 <= xx < W and 0 <= yy < H and removed[yy * W + xx]:
                    near = True
                    break
            if not near:
                continue
            p = px[x, y]
            d = dist(p)
            if d < limit:
                px[x, y] = (p[0], p[1], p[2], int(p[3] * d / float(limit)))
                fixed += 1
    print("  泛洪抠底：背景基准 #%02x%02x%02x，容差 %d，清掉边缘残留 %d px"
          % (br, bg, bb, tol, fixed))
    return img


def flood_bg_band(img, y_frac=0.80, tol=95, base=None):
    """在画面【最下面一条带】里，用更大的容差再泛洪一次 —— 专治脚下阴影。

    ★ 为什么泛洪清不掉阴影？
      正常泛洪按「到背景色的距离」判定，阴影（尤其是带一点蓝调的）
      离背景色可能更远，走到阴影边缘就停了，脚下留一团灰 blob。

    ★ 为什么不能全图直接放大容差？
      因为她【浅灰蓝的百褶裙】本身离背景色也不远，容差一放大，
      裙子会被一起吃掉（裙子变成白的/透明 —— 试过，很难看）。

    ★ 为什么限定在带里就安全？
      两把锁：
        位置：量过素材，裙摆落在画面 68%~75% 处，而这条带从 80% 才开始，
              泛洪根本够不着裙子。
        描边：带内的人物部件（腿 / 黑袜 / 皮鞋）都被深色描边包住，
              泛洪走到描边就停，吃不到人物本体。
      所以带内可以放心用大容差。
    ★ 还得注意：已经抠掉的像素 RGB 被写成了 (0,0,0)，如果按「离背景色距离」
      判定，它们会被当成「离背景极远」而挡住泛洪。所以判定必须【先看 alpha】，
      透明的格子无条件可通行。
    """
    img = img.convert("RGBA")
    W, H = img.size
    px = img.load()
    y0 = int(H * y_frac)

    cs = [px[0, H - 1], px[W - 1, H - 1]]
    if base is None:
        br = sorted(c[0] for c in cs)[0]
        bgc = sorted(c[1] for c in cs)[0]
        bb = sorted(c[2] for c in cs)[0]
    else:
        br, bgc, bb = base

    def dist(p):
        return abs(p[0] - br) + abs(p[1] - bgc) + abs(p[2] - bb)

    # ★ 和 fill_pockets 同样的安全闸：底色偏色时，带内的大容差（tol*3 = 285）
    #   会把腿上的肤色一起吃掉 —— 实测暖米底 #e3d0ba 离肤色只有 ~20，
    #   结果把小腿整段抠成了透明。这时宁可留着脚下阴影，也不能把腿抠没。
    chroma = max(abs(br - bgc), abs(bgc - bb), abs(br - bb))
    if chroma > 28:
        print("  ★ 带内泛洪：底色偏色（chroma %d，#%02x%02x%02x），"
              "大容差会误伤腿部，本次【跳过】" % (chroma, br, bgc, bb))
        return img

    limit = tol * 3
    seen = bytearray(W * H)
    stack = [(x, H - 1) for x in range(W)]
    for y in range(y0, H):
        stack.append((0, y))
        stack.append((W - 1, y))

    removed = 0
    while stack:
        x, y = stack.pop()
        if x < 0 or y < y0 or x >= W or y >= H:
            continue
        i = y * W + x
        if seen[i]:
            continue
        seen[i] = 1
        p = px[x, y]
        if p[3] > 0 and dist(p) > limit:
            continue                      # 碰到人物描边了，停
        if p[3] > 0:
            removed += 1
        px[x, y] = (0, 0, 0, 0)
        stack.append((x + 1, y))
        stack.append((x - 1, y))
        stack.append((x, y + 1))
        stack.append((x, y - 1))

    print("  带内泛洪：%.0f%%~100%%、容差 %d，清掉阴影 / 背景残留 %d px"
          % (y_frac * 100, tol, removed))
    return img


def keep_largest_blob(img, min_ratio=0.02):
    """只保留最大的一块连通区域，扔掉其它零碎。

    ★ 为什么需要它：AI 生成的立绘经常自带
      「脚下一团落影」或者「右下角一个签名水印」。
      泛洪抠底只吃和画面边缘连通的背景，而阴影/水印是背景上的【孤岛】，
      会被完整保留下来 —— 贴到桌面上就是脚边飘着一团灰影。
      按面积比丢掉小岛，顺便把这类问题一次清干净。
    """
    img = img.convert("RGBA")
    W, H = img.size
    px = img.load()
    seen = bytearray(W * H)
    comps = []
    for sy in range(H):
        for sx in range(W):
            if seen[sy * W + sx] or px[sx, sy][3] < 16:
                continue
            seen[sy * W + sx] = 1
            stack = [(sx, sy)]
            cells = []
            while stack:
                x, y = stack.pop()
                cells.append((x, y))
                # 八邻域：抗锯齿的细线用四邻域会被切碎
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        xx, yy = x + dx, y + dy
                        if 0 <= xx < W and 0 <= yy < H:
                            j = yy * W + xx
                            if not seen[j] and px[xx, yy][3] >= 16:
                                seen[j] = 1
                                stack.append((xx, yy))
            comps.append(cells)
    if len(comps) <= 1:
        print("  连通块：只有 1 块，没有孤岛")
        return img
    comps.sort(key=len, reverse=True)
    biggest = len(comps[0])
    dropped = 0
    kept = 1
    for comp in comps[1:]:
        if len(comp) < biggest * min_ratio:
            for (x, y) in comp:
                px[x, y] = (0, 0, 0, 0)
            dropped += 1
        else:
            kept += 1
    print("  连通块：最大 %d px；保留 %d 块，丢掉 %d 块（阴影 / 水印这类孤岛）"
          % (biggest, kept, dropped))
    return img


def fill_pockets(img, seed=20, expand=34, base=None, max_ratio=0.10):
    """清掉【被角色围住的底色小块】（两腿之间、腋下、手臂与身体之间…）。
    max_ratio 是【单块】面积上限（相对人物实心面积）：一块超过它就不清，
    宁可留着 —— 那说明它不是口袋，是被误当成口袋的人物本体。

    ★ 为什么泛洪抠底清不掉它们？
      泛洪是从画面【四边】往里走的，只能吃到「和边缘连通」的背景。
      但角色的姿势会在一些地方把背景【整个围起来】：最典型的是
      两腿之间那一块（被两条腿 + 脚下阴影封死），还有腋下的小三角。
      这些口袋碰不到画面边缘 → 泛洪够不着 → 抠完底色后它们留成一坨
      灰块糊在身上（实测「两腿之间」那块很大，缩略图上一眼就能看见）。

    ★ 为什么不能简单地「离底色近就砍掉」（全局键控）？
      因为角色的【肤色】离背景色并不远（实测约 50~55），而口袋约 0~30。
      两者挨得很近，一刀切的阈值要么切不掉口袋、要么把脸和腿挖空。
      （试过：阈值稍大一点，脸和胳膊上直接出现透明洞。）

    ★ 所以用【两个阈值 + 连通性】：
      seed   ：只把「颜色几乎等于底色」（默认 0~20）的像素当种子 ——
               肤色到不了这么近，所以种子一定落在口袋里。
      expand ：从种子往外扩张时放宽到默认 0~34 —— 够吃干净口袋边缘，
               但 < 肤色的 50，扩张到人物实色就停。
      口袋内部本来就是连续的一整块，所以种子一定够用。
      人物哪怕有零星像素落在 expand 范围内，只要它不是种子、
      也不和口袋相连，就不会被波及。

    seed / expand 是「到背景色的曼哈顿距离」阈值（0~765）。
    """
    img = img.convert("RGBA")
    W, H = img.size
    px = img.load()

    if base is None:
        cs = [px[0, 0], px[W - 1, 0], px[0, H - 1], px[W - 1, H - 1]]
        br = sorted(c[0] for c in cs)[1]
        bgc = sorted(c[1] for c in cs)[1]
        bb = sorted(c[2] for c in cs)[1]
    else:
        br, bgc, bb = base

    def dist(p):
        return abs(p[0] - br) + abs(p[1] - bgc) + abs(p[2] - bb)

    opaque_total = 0
    for y in range(H):
        for x in range(W):
            if px[x, y][3] >= 16:
                opaque_total += 1
    # ★★ 两档处理：大口袋一档，「发绳里 / 发丝之间」的小缝单独一档。
    #
    #   为什么小缝要单独一档？
    #     它的像素绝大多数是【抗锯齿混色】——蓝底和深蓝头发混在一起，
    #     离底色的距离远不止 seed=20。而且这个角色【头发本身就是深蓝的】
    #     （实测深蓝 #2b3141 离蓝底只有 ~168），所以「离底色近就砍」这类判据
    #     在这一档天然分不开头发和缝隙 —— 第一档因此完全够不着这些小缝。
    #
    #   那放宽阈值为什么不会咬到人？靠【面积】兜底：
    #     这类小缝必然极小，所以第二档把单块上限收到 0.5%。
    #     人物自己的深蓝头发离底色 ~168，而外轮廓那一圈抗锯齿虽然颜色也近，
    #     却是连成一长条的 —— 两者都会被面积上限挡在门外。
    TIERS = (
        (seed, expand, max_ratio, "大口袋"),
        (60, 90, 0.005, "小缝"),
    )
    for (sd, ex, cap, tag) in TIERS:
        limit = max(16, int(opaque_total * cap))
        visited = bytearray(W * H)
        removed = 0
        done_blocks = 0
        skipped = 0
        biggest_skip = 0
        for sy in range(H):
            for sx in range(W):
                i = sy * W + sx
                if visited[i]:
                    continue
                p = px[sx, sy]
                if p[3] < 16 or dist(p) > sd:
                    continue
                cells = []
                stack = [(sx, sy)]
                visited[i] = 1
                while stack:
                    x, y = stack.pop()
                    q = px[x, y]
                    if q[3] < 16 or dist(q) > ex:
                        continue                    # 碰到人物实色，停在这一格
                    cells.append((x, y))
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        xx, yy = x + dx, y + dy
                        if 0 <= xx < W and 0 <= yy < H:
                            j = yy * W + xx
                            if not visited[j] and px[xx, yy][3] >= 16:
                                visited[j] = 1
                                stack.append((xx, yy))
                if not cells:
                    continue
                if len(cells) > limit:
                    skipped += 1
                    biggest_skip = max(biggest_skip, len(cells))
                    continue                        # 太大 —— 整块放过，宁可留着
                for (x, y) in cells:
                    px[x, y] = (0, 0, 0, 0)
                removed += len(cells)
                done_blocks += 1
        print("  口袋填补[%s]：清掉 %d px（%d 块）；单块上限 %d px，放弃 %d 块%s"
              % (tag, removed, done_blocks, limit, skipped,
                 ("（最大放弃块 %d px）" % biggest_skip) if skipped else ""))
    return img


def despill_edges(img, base):
    """去掉边缘上混进来的背景色（色溢 / dematte）。

    ★ 为什么必须要有这一步：
      抗锯齿出来的边缘像素本来就是「人物色 + 背景色」的混合。
      抠底只是给了它们一个透明度，RGB 里仍然留着背景色 ——
      蓝底上就是一圈蓝边、浅灰底上就是一圈灰边。
      叠到桌面上看着就是「糊」加上「脏」，而且放大之后特别明显。

    ★ 做法（标准的 unpremultiply）：
      设边缘像素 = 原色 × a + 背景色 × (1 − a)（a 为该像素的 alpha/255），
      反解 原色 = (c − 背景色 × (1 − a)) / a。

    ★ 必须在【缩放之前】做：一旦重采样，这里每个像素的 alpha 都不再等于
      它自己那条混合式的系数，反推就不成立了。
    """
    img = img.convert("RGBA")
    px = img.load()
    W, H = img.size
    br, bgc, bb = base
    n = 0
    for y in range(H):
        for x in range(W):
            r, g, b, a = px[x, y]
            if a == 0 or a >= 250:
                continue
            t = a / 255.0
            k = 1.0 - t
            px[x, y] = (
                max(0, min(255, int((r - br * k) / t))),
                max(0, min(255, int((g - bgc * k) / t))),
                max(0, min(255, int((b - bb * k) / t))),
                a,
            )
            n += 1
    print("  边缘去色溢：还原 %d 个半透明像素的原色" % n)
    return img


def main():
    ap = argparse.ArgumentParser(description="立绘素材处理 + 遮罩烘焙")
    ap.add_argument("--idle", required=True, help="平常表情（必填，作为基准）")
    ap.add_argument("--blink", help="闭眼")
    ap.add_argument("--happy", help="开心笑")
    ap.add_argument("--surprise", help="被戳到（睁大眼）")
    ap.add_argument("--out", required=True, help="输出目录（比如 assets/sprites）")
    ap.add_argument("--bg", choices=["auto", "key", "flood", "none"], default="auto",
                    help="抠底方式。auto=给了 --key 就键控、没给就不抠；"
                         "key=全局键控（纯色幕布）；"
                         "flood=从画面边缘泛洪 ★ 角色身上有和背景同色的部分时"
                         "（比如白衬衫配白底）必须用它，否则会把衬衫一起抠掉")
    ap.add_argument("--key", default=None,
                    help="要键掉的底色，六位十六进制，比如 FF00FF（--bg key 时用）")
    ap.add_argument("--tol", type=int, default=60, help="键控 / 泛洪容差（默认 60）")
    ap.add_argument("--drop-shadow", action="store_true",
                    help="清掉脚下那团软阴影（在最下面一条带里用大容差再泛洪一次，"
                         "泛洪清不掉它、全图调容差又会误伤裙子）")
    ap.add_argument("--no-fill-pockets", action="store_true",
                    help="不清理被角色围住的底色小块（两腿之间 / 腋下）。"
                         "默认会清 —— 不清的话那里会留一坨灰块糊在身上")
    ap.add_argument("--pocket-seed", type=int, default=20,
                    help="口袋种子的颜色阈值（默认 20）。只有离底色这么近的像素"
                         "才会被当作「口袋」的起点；肤色约 50，所以很安全")
    ap.add_argument("--pocket-expand", type=int, default=34,
                    help="口袋扩张阈值（默认 34）。要大于 seed、又明显小于肤色(约 50)")
    ap.add_argument("--drop-loose", action="store_true",
                    help="只保留最大连通块，扔掉地面阴影 / 水印这类孤岛")
    ap.add_argument("--height", type=int, default=640,
                    help="输出高度（像素，默认 640）。640 在 125%% 缩放的屏上够清晰")
    ap.add_argument("--mask-h", type=int, default=96,
                    help="遮罩网格的行数（默认 96）。判定不准就调大，比如 144")
    ap.add_argument("--no-crop", action="store_true",
                    help="不裁切，保留原始取景")
    args = ap.parse_args()

    bg_mode = args.bg
    if bg_mode == "auto":
        bg_mode = "key" if args.key else "none"

    states = [("idle", args.idle), ("blink", args.blink),
              ("happy", args.happy), ("surprise", args.surprise)]
    states = [(n, p) for n, p in states if p]

    for n, p in states:
        if not os.path.isfile(p):
            print("找不到文件：%s（%s）" % (p, n), file=sys.stderr)
            return 2

    os.makedirs(args.out, exist_ok=True)

    # ---- 1. 读图 + 抠底 + 清孤岛 ----
    imgs = {}
    for name, p in states:
        im = Image.open(p).convert("RGBA")
        print("%-9s %-40s %dx%d" % (name, os.path.basename(p), im.size[0], im.size[1]))
        bg_base = []
        if bg_mode == "key" and args.key:
            im = chroma_key(im, args.key, args.tol)
        elif bg_mode == "flood":
            im = flood_bg(im, args.tol, bg_base)
            # ★ 先清脚下阴影：它会把「两腿之间」那块底色封成一个死口袋
            #   （碰不到画面边缘），阴影清掉之后那块才和边缘连通 ——
            #   所以紧接着用同一个基准色再泛洪一次，顺手把它带走。
            if args.drop_shadow:
                im = flood_bg_band(im, base=bg_base[0])
                im = flood_bg(im, args.tol, base=bg_base[0])
            # ★ 再清「不是被阴影封住、而是被角色姿势围住」的死口袋（腋下等）
            if not args.no_fill_pockets:
                im = fill_pockets(im, seed=args.pocket_seed,
                                  expand=args.pocket_expand, base=bg_base[0])
        # ★ 边缘去色溢要在缩放开之前做（缩放会让 alpha 不再等于混合系数）
        if bg_mode == "flood" and bg_base:
            im = despill_edges(im, bg_base[0])

        if args.drop_loose:
            im = keep_largest_blob(im)
        # ★ 安全闸：抠底失败最典型的样子 —— 不透明像素几乎铺满整张图。
        #   成因：底色不平（白底带渐变 / 柔光晕 / 大范围投影），
        #   泛洪走两步就被渐变挡住，于是整个背景被当成人物留下。
        #   这种情况【彩度安全阀拦不住】（白/灰都是中性色），只能靠这个面积比发现。
        #   踩过：一张女仆装白底带晕，泛洪 0 效果，成品成了 662x640 的不透明方块。
        _a = im.getchannel("A").tobytes()
        _frac = sum(1 for v in _a if v >= 16) / float(im.size[0] * im.size[1])
        if _frac > 0.55:
            print("  ★★ 提醒：%s 处理完仍有 %.0f%% 的不透明像素（快铺满画面）——"
                  % (name, _frac * 100))
            print("      底色多半不平（渐变 / 柔光边 / 大投影），泛洪没吃动，"
                  "这张素材不可用，建议重新生成。")
        imgs[name] = im

    # ---- 2. 包围盒：所有表情取【并集】 ----
    #
    # ★ 为什么用并集而不是只用 idle 的？
    #   因为「换表情时人不能跳」的前提是所有表情裁到同一块区域。
    #   用并集就保证谁都不会被切掉。
    #   但并集有个盲点：万一某张图抠底没抠干净（留了一大片底色），
    #   并集会变得巨大，人反而变小了。所以下面要把每张的包围盒打出来，
    #   一眼就能看出哪张不对劲。
    boxes = {}
    for name, im in imgs.items():
        b = content_bbox(im)
        boxes[name] = b
        print("  %-9s 内容包围盒 %s" % (name, b if b else "★ 全透明！"))

    if not args.no_crop:
        valid = [b for b in boxes.values() if b]
        if not valid:
            print("★ 所有图都是全透明的 —— 抠底参数是不是选错了？", file=sys.stderr)
            return 1
        left = min(b[0] for b in valid)
        top = min(b[1] for b in valid)
        right = max(b[2] for b in valid)
        bottom = max(b[3] for b in valid)

        # 各图包围盒差异太大就提醒 —— 那说明表情之间「人跑了」，
        # 换表情时会一跳一跳，这是最破坏观感的一种素材问题。
        for name, b in boxes.items():
            if not b:
                continue
            dw = abs((b[2] - b[0]) - (boxes["idle"][2] - boxes["idle"][0]))
            dh = abs((b[3] - b[1]) - (boxes["idle"][3] - boxes["idle"][1]))
            if dw > (right - left) * 0.08 or dh > (bottom - top) * 0.08:
                print("  ★ 提醒：%s 的轮廓比 idle 差得有点多（宽差 %dpx，高差 %dpx）。"
                      % (name, dw, dh))
                print("     如果是「只改了眼睛和嘴」的图生图结果，通常不会差这么多；")
                print("     差太多说明两张图不是同一姿势同一取景，换表情时人会跳。")
    else:
        g = imgs["idle"].size
        left, top, right, bottom = 0, 0, g[0], g[1]

    print("裁切区域 (%d, %d) - (%d, %d)  尺寸 %dx%d"
          % (left, top, right, bottom, right - left, bottom - top))

    # ---- 3. 统一缩放 ----
    scale = args.height / float(bottom - top)
    out_w = max(1, int(round((right - left) * scale)))
    print("缩放系数 %.4f -> 输出 %dx%d" % (scale, out_w, args.height))

    for name, im in imgs.items():
        # ★ 用 LANCZOS 而不是默认的最近邻：立绘是要长期挂在桌面上的，
        #   半年都盯着它，边缘锯齿会很显眼。
        out = im.crop((left, top, right, bottom)).resize(
            (out_w, args.height), Image.LANCZOS)
        dst = os.path.join(args.out, name + ".png")
        out.save(dst, "PNG", optimize=True)
        print("  写出 %-28s %d 字节" % (os.path.basename(dst), os.path.getsize(dst)))

    # ---- 4. 烘焙遮罩 ----
    ref = os.path.join(args.out, "idle.png")
    mask_path = os.path.join(args.out, "mask.json")
    mw, mh, ratio = bake_mask(ref, mask_path, args.mask_h)
    print("遮罩 %dx%d，实心占比 %.1f%% -> %s（%d 字节）"
          % (mw, mh, ratio * 100, os.path.basename(mask_path),
             os.path.getsize(mask_path)))

    ok, detail = verify_mask(mask_path, ref, args.mask_h)
    print("编码器自检：%s  （%s）" % ("通过" if ok else "★ 失败", detail))
    if not ok:
        print("★ 遮罩打包规则和 renderer.js 的 decodeBits 对不上，判定区会歪。",
              file=sys.stderr)
        return 1

    print("")
    print("完成。接下来把 desktop/config.js 里的 sprite.enabled 改成 true 即可。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
