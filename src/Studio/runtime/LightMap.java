package Studio.runtime;

import java.awt.image.BufferedImage;
import java.util.List;

/**
 * 2D 光照贴图的<b>纯 CPU</b> 实现（无 GL、无窗口、可在任何机器跑）。
 *
 * <p>唯一依据是 {@code docs/_fragments/lighting-contract.md} §2。编辑器的
 * {@code web/src/app/lightMath.ts} 与这里必须产出<b>逐像素一致</b>的结果，
 * 仲裁依据是 {@code test/fixtures/lighting-case.json}（第三方实现算出的 samples）。
 *
 * <h3>为什么数学要单独抽一个文件</h3>
 * 运行时（{@link Lighting}）每个动态帧都要重算这张图，而自检
 * （{@link LightMapTest}）要在<b>没有 GPU</b> 的机器上也能跑。把公式和 GL 画法分开，
 * 才能「数学对了」与「画出来了」两条线各自可验证 —— 之前踩过的坑正是
 * 「断言全绿但画面全黑」（只验指令数、不验像素）。
 *
 * <h3>采样约定（契约 §2.1）</h3>
 * <pre>
 *   texW = clamp(round(W * s), 1, 2048)，texH 同理；
 *   sEff = min(texW / W, texH / H)；        ← 实际「纹素/世界像素」，反推用这个
 *   纹素 (i,j) 的世界中心 = ((i + 0.5) / sEff, (j + 0.5) / sEff)
 * </pre>
 * 注意 {@code sEff} 是<b>反推</b>出来的、不是直接拿 {@code s}：尺寸被 round/截断后
 * 真实比例必然略有偏差，用 {@code s} 反推会让贴图整体错位（大地图尤其明显）。
 *
 * <h3>确定性（契约 §2.7）</h3>
 * 全程只用 IEEE 754 的 {@code double}/{@code float}，不用平台相关随机、不用 HashMap 遍历。
 * 累加顺序固定为 <b>lights 数组下标顺序</b>（契约 §2.3 末尾）：本实现按「逐光源 → 逐纹素」
 * 遍历（性能好得多），因为每个纹素看到的仍是同一个光源顺序，浮点尾数一致。
 */
final class LightMap {

    /** 烘焙算法版本（写进 {@code scene.lightmap.version}，两端对不上就不复用烘焙图）。 */
    static final int VERSION = 1;

    /** 贴图长边上限（契约 §2.1）。超了整张按同一比例缩小。 */
    static final int MAX_TEX = 2048;

    private static final double DEG = Math.PI / 180.0;

    private LightMap() {
    }

    /**
     * 一盏灯（烘焙与动态共用）。颜色已拆成 0..1 的 r/g/b，避免每纹素解析字符串。
     *
     * <p>{@code tickle} 的语义是「闪烁幅度在当前时刻<b>已算出</b>的倍率加成」：
     * 实际乘数是 {@code 1 + tickle}（{@code 0} = 不闪）。烘焙图里它恒为 0
     * （静态底图不闪，抖动交给运行时动态层，契约 §2.3 第 7 条）。
     */
    static final class Light {
        String id = "";
        float x, y;
        float radius = 140f;
        float r = 1f, g = 0.788f, b = 0.47f;   // #FFC978
        float intensity = 1f;
        boolean spot;
        float dirDeg = 0f;        // 0 = +x，90 = +y（向下），顺时针
        float angleDeg = 60f;     // 锥总角度
        float coneSoftDeg = 10f;
        float falloff = 2f;       // 1..4
        boolean shadow = true;
        float tickle = 0f;
        boolean dynamic;
    }

    /** 遮挡体（世界 AABB，中心 + 半宽半高）。 */
    static final class Occluder {
        float x, y, hw, hh;

        Occluder() {
        }

        Occluder(float x, float y, float hw, float hh) {
            this.x = x;
            this.y = y;
            this.hw = hw;
            this.hh = hh;
        }
    }

    /** 一张贴图的计算结果。{@code rgb} 长度 {@code texW*texH*3}，已 clamp 到 0..1。 */
    static final class Result {
        int texW, texH;
        float sEff;
        float[] rgb;
        long ms;
    }

    // ---------------- 尺寸推导 ----------------

    /**
     * 契约 §2.1 的尺寸推导：给定世界宽高与 {@code texelsPerPixel}，返回 {@code {texW, texH, sEff}}。
     *
     * <p>Java 侧刻意不返回数组（每个动态帧都会调，数组分配没必要），直接返回 {@link Result}。
     * 世界宽高 {@code <= 0} 时返回 {@code texW=texH=1、sEff=1、rgb} 长度 3 的全 0 —— 调用方
     * （{@link Lighting}）在场景还没载入/尺寸为 0 时靠这个兜底，不必自己判空。
     */
    static Result sizeFor(float worldW, float worldH, float texelsPerPixel) {
        Result res = new Result();
        if (!(worldW > 0f) || !(worldH > 0f)) {
            // 非法/未就绪世界尺寸：不返回 null，给一张 1x1 的黑图（契约 §3 sizeFor 条款）。
            res.texW = 1;
            res.texH = 1;
            res.sEff = 1f;
            res.rgb = new float[3];
            return res;
        }
        float s = texelsPerPixel;
        if (!(s > 0f) || Float.isNaN(s) || Float.isInfinite(s)) {
            s = 0.25f;   // 契约缺省 texelsPerPixel
        }
        // ⚠ 用 float 参与 Math.round(float)，别让表达式升级成 double 再落 int 重载：
        //   Math.round(double) 返回 long，多一次 cast 与精度差，两边取整结果会在 .5 上分叉。
        int texW = Math.max(1, Math.round(worldW * s));
        int texH = Math.max(1, Math.round(worldH * s));
        float sEff = Math.min(texW / worldW, texH / worldH);
        if (texW > MAX_TEX || texH > MAX_TEX) {
            // 超上限：整张按同一比例缩小（保持长边 <= 2048），再按新尺寸反推 sEff。
            float shrink = Math.min(MAX_TEX / (float) texW, MAX_TEX / (float) texH);
            texW = Math.max(1, Math.round(texW * shrink));
            texH = Math.max(1, Math.round(texH * shrink));
            sEff = Math.min(texW / worldW, texH / worldH);
        }
        res.texW = texW;
        res.texH = texH;
        res.sEff = sEff;
        return res;
    }

    // ---------------- 烘焙主入口 ----------------

    /**
     * 烘焙主入口：<b>不含模糊</b>（模糊由 {@link #blur} 单独跑，半径 = {@code softness * sEff}）。
     *
     * <p>不返回 {@code null}；世界宽高 {@code <= 0} ⇒ 返回 {@code texW=texH=1、sEff=1、rgb} 全 0。
     * {@code ambientRgb} 长度不足时缺的通道按 0（不抛异常）；{@code lights}/{@code occluders}
     * 允许 {@code null}（视为空表）。
     *
     * <p>累加 = {@code ambient} + Σ（按 lights 下标顺序）每盏灯的贡献，最后逐通道 clamp 到 0..1。
     * 逐光源遍历纹素（不是逐纹素遍历光源）—— 性能从「每纹素遍历全部光源」变成
     * 「每盏灯只碰自己半径包围盒里的纹素」，而每个纹素的累加顺序仍是光源下标顺序，
     * 所以浮点结果与逐纹素写法<b>逐位一致</b>（契约 §2.3 明确允许这种实现）。
     */
    static Result bake(float worldW, float worldH, float texelsPerPixel,
                       float[] ambientRgb, List<Light> lights,
                       List<Occluder> occluders) {
        long t0 = System.nanoTime();
        Result res = sizeFor(worldW, worldH, texelsPerPixel);
        if (!(worldW > 0f) || !(worldH > 0f)) {
            res.ms = ms(t0);
            return res;
        }
        final int texW = res.texW;
        final int texH = res.texH;
        final float sEff = res.sEff;
        final float[] rgb = new float[texW * texH * 3];

        // ① 环境光作基底。缺通道按 0（契约 §2.2：ambient = color * intensity，不在这一步 clamp）。
        float ar = ambientRgb != null && ambientRgb.length > 0 ? ambientRgb[0] : 0f;
        float ag = ambientRgb != null && ambientRgb.length > 1 ? ambientRgb[1] : 0f;
        float ab = ambientRgb != null && ambientRgb.length > 2 ? ambientRgb[2] : 0f;
        for (int k = 0; k < rgb.length; k += 3) {
            rgb[k] = ar;
            rgb[k + 1] = ag;
            rgb[k + 2] = ab;
        }

        if (lights != null && !lights.isEmpty()) {
            final int occN = occluders == null ? 0 : occluders.size();
            for (int li = 0; li < lights.size(); li++) {
                Light L = lights.get(li);
                // 契约 §2.3：radius <= 0 跳过；intensity <= 0 整盏跳过（不参与累加，避免 -0 之类的差异）。
                if (L == null || !(L.radius > 0f) || !(L.intensity > 0f)) {
                    continue;
                }
                addLight(rgb, texW, texH, sEff, L, occluders, occN);
            }
        }

        // ② 逐通道 clamp（契约 §2.3 末尾：最后一起 clamp）。
        for (int k = 0; k < rgb.length; k++) {
            float v = rgb[k];
            if (v < 0f) {
                rgb[k] = 0f;
            } else if (v > 1f) {
                rgb[k] = 1f;
            }
        }
        res.rgb = rgb;
        res.ms = ms(t0);
        return res;
    }

    /** 把一盏灯的贡献加进 {@code rgb}（只碰它半径包围盒内的纹素）。 */
    private static void addLight(float[] rgb, int texW, int texH, float sEff,
                                 Light L, List<Occluder> occluders, int occN) {
        final double lx = L.x;
        final double ly = L.y;
        final double radius = L.radius;
        final double intensity = L.intensity;
        final double cr = L.r;
        final double cg = L.g;
        final double cb = L.b;
        // 契约 §2.3 第 3 条：falloff 允许 1..4（越界按边界值，不抛异常）。
        double falloff = L.falloff;
        if (!(falloff >= 1.0)) {
            falloff = 1.0;
        } else if (falloff > 4.0) {
            falloff = 4.0;
        }
        final boolean spot = L.spot;
        final double halfRad = (L.angleDeg / 2.0) * DEG;
        final double dirRad = L.dirDeg * DEG;
        double coneSoftRad = L.coneSoftDeg * DEG;
        if (!(coneSoftRad >= 0.0)) {
            coneSoftRad = 0.0;         // 负值/NaN 视为无软化，别让下面的除法产生 NaN
        }
        // 闪烁：乘数 = 1 + tickle（烘焙图 tickle 恒 0，动态层才是非 0）。
        final double scale0 = intensity * (1.0 + L.tickle);
        if (!(scale0 > 0.0)) {
            return;                     // 闪烁恰好把强度压到 0：这盏灯本帧不贡献
        }
        final boolean shadow = L.shadow;

        // ---- 精确裁剪：先按「AABB 到光源的距离 > radius」筛掉必定照不到的遮挡体 ----
        // 这不是近似：若点 p 在半径内，则线段 (l→p) 全长 <= radius；任何 AABB 上离 l 最近的点
        // 距离 > radius，整段都不可能碰到它（契约 §2.3 第 5 条明确允许这种裁剪）。
        Occluder[] occ = null;
        int occCount = 0;
        if (shadow && occN > 0) {
            Occluder[] tmp = new Occluder[occN];
            int n = 0;
            for (int i = 0; i < occN; i++) {
                Occluder o = occluders.get(i);
                if (o == null || !(o.hw > 0f) || !(o.hh > 0f)) {
                    continue;           // 退化遮挡体（零面积）：永远不该挡光
                }
                double ox = Math.max(0.0, Math.abs(lx - o.x) - o.hw);
                double oy = Math.max(0.0, Math.abs(ly - o.y) - o.hh);
                if (ox * ox + oy * oy > radius * radius) {
                    continue;           // 必定不相交
                }
                tmp[n++] = o;
            }
            if (n == 0) {
                // shadow=true，但半径内没有任何遮挡体可达 ⇒ 这盏灯不会被挡：
                // 不要在这里 return（否则整盏灯的光都没了），只要不开阴影分支即可。
                occ = null;
                occCount = 0;
            } else {
                occ = tmp;
                occCount = n;
            }
        }

        // ---- 包围盒：只遍历半径内的纹素 ----
        // 纹素中心 x = (i + 0.5) / sEff ⇒ 条件 |x - lx| <= radius
        // 取 floor/ceil 后各放宽 1 个纹素（多算的纹素 t >= 1，贡献必为 0，等价且安全）。
        int i0 = (int) Math.floor((lx - radius) * sEff - 0.5) - 1;
        int i1 = (int) Math.ceil((lx + radius) * sEff - 0.5) + 1;
        int j0 = (int) Math.floor((ly - radius) * sEff - 0.5) - 1;
        int j1 = (int) Math.ceil((ly + radius) * sEff - 0.5) + 1;
        if (i0 < 0) {
            i0 = 0;
        }
        if (j0 < 0) {
            j0 = 0;
        }
        if (i1 > texW - 1) {
            i1 = texW - 1;
        }
        if (j1 > texH - 1) {
            j1 = texH - 1;
        }
        if (i0 > i1 || j0 > j1) {
            return;                     // 灯完全在地图外
        }

        final double invS = 1.0 / sEff;
        final double radius2 = radius * radius;
        for (int j = j0; j <= j1; j++) {
            double py = (j + 0.5) * invS;
            double dy0 = py - ly;
            int rowBase = (j * texW) * 3;
            for (int i = i0; i <= i1; i++) {
                double px = (i + 0.5) * invS;
                double dx = px - lx;
                double d2 = dx * dx + dy0 * dy0;
                if (d2 >= radius2) {
                    continue;           // 契约 §2.3：t >= 1 ⇒ 贡献 0（半径外不参与）
                }
                double d = Math.sqrt(d2);
                double t = d / radius;
                double atten = Math.pow(1.0 - t, falloff);

                if (spot) {
                    double angRad = Math.atan2(dy0, dx);
                    double diff = Math.abs(normalizeToPi(angRad - dirRad));
                    if (diff > halfRad) {
                        continue;       // 锥外
                    }
                    // 锥边软化：只在内侧 coneSoft 范围内线性衰减到 0。
                    if (coneSoftRad > 0.0 && diff > halfRad - coneSoftRad) {
                        double f = (halfRad - diff) / coneSoftRad;
                        if (f < 0.0) {
                            f = 0.0;
                        } else if (f > 1.0) {
                            f = 1.0;
                        }
                        atten *= f;
                    }
                }

                if (shadow && occCount > 0) {
                    boolean blocked = false;
                    for (int k = 0; k < occCount; k++) {
                        Occluder o = occ[k];
                        if (segmentHitsBox(lx, ly, px, py, o.x, o.y, o.hw, o.hh)) {
                            blocked = true;
                            break;
                        }
                    }
                    if (blocked) {
                        continue;       // 契约 §2.3 第 5 条：被挡 ⇒ 贡献 0
                    }
                }

                // 颜色 * 强度 * 衰减 * 锥因子，三个通道各乘一次同一标量（保证通道独立性）。
                double s = scale0 * atten;
                float fr = (float) (cr * s);
                int o = rowBase + i * 3;
                // ⚠ 显式「贡献为 0 时不写」：避免 0 + -0 产生 -0（契约 §2.3 明确要求）。
                if (fr != 0f) {
                    rgb[o] = rgb[o] + fr;
                }
                float fg = (float) (cg * s);
                if (fg != 0f) {
                    rgb[o + 1] = rgb[o + 1] + fg;
                }
                float fb = (float) (cb * s);
                if (fb != 0f) {
                    rgb[o + 2] = rgb[o + 2] + fb;
                }
            }
        }
    }

    /** 把角度归一化到 {@code (-π, π]}（契约 §2.3 第 4 条的 normalizeToPi）。 */
    static double normalizeToPi(double a) {
        double v = a;
        // 用循环而不是 %：输入范围一般只有 [-4π, 4π]，但循环语义与契约字面一致，且不会被大数骗。
        while (v > Math.PI) {
            v -= Math.PI * 2.0;
        }
        while (v <= -Math.PI) {
            v += Math.PI * 2.0;
        }
        return v;
    }

    /**
     * 契约 §2.4 的 slab 法线段 / AABB 相交判定。交点参数必须落在 {@code (0,1)} <b>内部</b>：
     * 端点贴着盒子边缘不算遮挡 —— 否则「灯贴在墙上」时整盏灯会瞬间全灭。
     */
    static boolean segmentHitsBox(double ax, double ay, double bx, double by,
                                  double cx, double cy, double hw, double hh) {
        double dx = bx - ax;
        double dy = by - ay;
        double tmin = 0.0;
        double tmax = 1.0;
        if (Math.abs(dx) < 1e-9) {
            if (ax < cx - hw || ax > cx + hw) {
                return false;
            }
        } else {
            double t1 = (cx - hw - ax) / dx;
            double t2 = (cx + hw - ax) / dx;
            if (t1 > t2) {
                double tmp = t1;
                t1 = t2;
                t2 = tmp;
            }
            if (t1 > tmin) {
                tmin = t1;
            }
            if (t2 < tmax) {
                tmax = t2;
            }
            if (tmin > tmax) {
                return false;
            }
        }
        if (Math.abs(dy) < 1e-9) {
            if (ay < cy - hh || ay > cy + hh) {
                return false;
            }
        } else {
            double t1 = (cy - hh - ay) / dy;
            double t2 = (cy + hh - ay) / dy;
            if (t1 > t2) {
                double tmp = t1;
                t1 = t2;
                t2 = tmp;
            }
            if (t1 > tmin) {
                tmin = t1;
            }
            if (t2 < tmax) {
                tmax = t2;
            }
            if (tmin > tmax) {
                return false;
            }
        }
        // 端点贴边不算（1e-5 与 fixture 生成器同一阈值，保证两端在临界像素上不抖）
        return tmax > 1e-5 && tmin < 1.0 - 1e-5;
    }

    // ---------------- 柔化 ----------------

    /**
     * 契约 §2.5：<b>2 遍</b>方框模糊（每遍 = 先横后纵两次一维模糊），边界按「当前半径内
     * 有效像素数」归一（不做边缘外推 —— 外推会让贴图四周凭空发亮，看起来像「屏幕边缘漏光」）。
     *
     * <p>{@code radiusTexels <= 0} 时原样返回输入（不做无意义的两遍拷贝）。
     * 只应作用于<b>光源累加部分</b>：调用方的做法是先 bake 出整张图（含环境光）再模糊 ——
     * 因为环境光是常数，方框模糊对常数是恒等运算，所以结果等价于「只模糊光源部分」，
     * 这是本实现与 {@code lightMath.ts} 共用同一条路径的关键（少一个中间缓冲）。
     */
    static float[] blur(float[] rgb, int texW, int texH, int radiusTexels) {
        int r = radiusTexels;
        if (r <= 0 || rgb == null || texW <= 0 || texH <= 0 || rgb.length < texW * texH * 3) {
            return rgb;
        }
        // 半径超过短边时方框退化为「整张平均」，仍安全（有效像素数归一保证不越界）。
        float[] src = new float[rgb.length];
        System.arraycopy(rgb, 0, src, 0, rgb.length);
        float[] dst = new float[rgb.length];

        for (int pass = 0; pass < 2; pass++) {
            // 横向：读 src → 写 dst
            for (int j = 0; j < texH; j++) {
                int row = j * texW;
                for (int i = 0; i < texW; i++) {
                    float sr = 0f, sg = 0f, sb = 0f;
                    int n = 0;
                    int x0 = Math.max(0, i - r);
                    int x1 = Math.min(texW - 1, i + r);
                    for (int x = x0; x <= x1; x++) {
                        int o = (row + x) * 3;
                        sr += src[o];
                        sg += src[o + 1];
                        sb += src[o + 2];
                        n++;
                    }
                    int o = (row + i) * 3;
                    dst[o] = sr / n;
                    dst[o + 1] = sg / n;
                    dst[o + 2] = sb / n;
                }
            }
            // 纵向：读 dst → 写 src
            for (int j = 0; j < texH; j++) {
                int y0 = Math.max(0, j - r);
                int y1 = Math.min(texH - 1, j + r);
                for (int i = 0; i < texW; i++) {
                    float sr = 0f, sg = 0f, sb = 0f;
                    int n = 0;
                    for (int y = y0; y <= y1; y++) {
                        int o = (y * texW + i) * 3;
                        sr += dst[o];
                        sg += dst[o + 1];
                        sb += dst[o + 2];
                        n++;
                    }
                    int o = ((j * texW) + i) * 3;
                    src[o] = sr / n;
                    src[o + 1] = sg / n;
                    src[o + 2] = sb / n;
                }
            }
        }
        return src;
    }

    // ---------------- 输出 ----------------

    /** 契约 §2.6：float rgb(0..1) → <b>不透明</b> {@link BufferedImage}（A=255）。 */
    static BufferedImage toImage(float[] rgb, int texW, int texH) {
        int w = Math.max(1, texW);
        int h = Math.max(1, texH);
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        boolean has = rgb != null && rgb.length >= w * h * 3;
        for (int j = 0; j < h; j++) {
            for (int i = 0; i < w; i++) {
                int o = (j * w + i) * 3;
                float fr = has ? rgb[o] : 0f;
                float fg = has ? rgb[o + 1] : 0f;
                float fb = has ? rgb[o + 2] : 0f;
                img.setRGB(i, j, (255 << 24) | (channel(fr) << 16) | (channel(fg) << 8) | channel(fb));
            }
        }
        return img;
    }

    /** 全黑不透明贴图（「没有烘焙图」时的加光层兜底，避免 upload 空指针）。 */
    static BufferedImage black(int texW, int texH) {
        int w = Math.max(1, texW);
        int h = Math.max(1, texH);
        return toImage(null, w, h);
    }

    /** 0..1 float → 0..255 整数（clamp + round，与契约 §2.6 / fixture 的 toByte 一致）。 */
    static int channel(float v) {
        if (!(v > 0f)) {
            return 0;      // 含 NaN / -0：当作 0，避免 NaN 扩散成 255
        }
        if (v >= 1f) {
            return 255;
        }
        // Math.round(float) 走 int 重载：与 JS Math.round 在正数上同一语义（floor(x + 0.5)）。
        int b = Math.round(v * 255f);
        return b < 0 ? 0 : (b > 255 ? 255 : b);
    }

    /**
     * 契约 §2.7 的 {@code hash01(id)}：{@code h = h * 31 + code}（32 位无符号回绕），
     * 取 {@code (h % 100000) / 100000.0}。
     *
     * <p>⚠ 契约正文写「按字节 / codePoint」，而 fixture 生成器（JS 侧）用的是
     * {@code charCodeAt}。两者对纯 ASCII 的 id（编辑器生成的 uuid、{@code L1}/{@code S1}）
     * <b>完全相同</b>，这也是契约真正依赖的场景（flicker 相位）。这里取 UTF-16 code unit，
     * 与 JS 侧逐字符一致；中文 id 也因此在两端得到同一相位（若按 UTF-8 字节会分叉）。
     * 已在 {@link LightMapTest} 里对 ASCII 与 JS 公式做等式断言。
     */
    static float hash01(String id) {
        String s = id == null ? "" : id;
        long h = 0L;
        for (int i = 0; i < s.length(); i++) {
            h = (h * 31L + s.charAt(i)) & 0xFFFFFFFFL;
        }
        return (float) ((h % 100000L) / 100000.0);
    }

    private static long ms(long t0) {
        return (System.nanoTime() - t0) / 1000000L;
    }
}
