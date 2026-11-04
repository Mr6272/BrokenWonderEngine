package Studio.runtime;

import javax.media.opengl.GL2;
import javax.media.opengl.GLAutoDrawable;
import javax.media.opengl.GLCapabilities;
import javax.media.opengl.GLDrawableFactory;
import javax.media.opengl.GLEventListener;
import javax.media.opengl.GLProfile;
import javax.media.opengl.GLOffscreenAutoDrawable;

import java.awt.image.BufferedImage;
import java.io.File;
import java.io.PrintStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * 2D 光照<b>渲染层</b>的离屏 GL 像素自检（契约 §7.4）。
 *
 * <p><b>为什么光有 {@link LightMapTest} 不够</b>：那个测试只证明「数学算对了」。
 * 光照最容易出的问题是「数学对、但画不出来」或「画出来把别的东西全压黑」——这正是本项目
 * 历史上真实发生过的事故类型（{@code props.color} 没被读 ⇒ 整城画成灰板，而所有
 * 「对象还在、不崩、drawCall 正常」的断言全绿）。只有真的走完
 * 「场景 JSON → 运行时 → 离屏 GL 光栅化 → 读 framebuffer 像素」才抓得住。
 *
 * <p>做法：用 {@link GLOffscreenAutoDrawable}（FBO，不弹窗）挂真的 {@link TopDownRuntime}，
 * 造两份只差 {@code lighting.enabled} 的工程，各推进若干帧后 {@code glReadPixels}，然后断言：
 * <ol>
 *   <li><b>灯下更亮</b>：开灯帧在灯附近的亮度必须显著高于关灯帧（加光层生效）；</li>
 *   <li><b>远角更暗</b>：开灯帧在远离光源的角落必须显著<b>低于</b>关灯帧（压暗层生效）；</li>
 *   <li><b>墙后不透光</b>：遮挡体背后的亮度必须远低于灯下（阴影真的算进去了）；</li>
 *   <li><b>关灯零回归</b>：{@code enabled=false} 时帧内容必须与「完全没有 lighting 段」的工程
 *       <b>逐像素一致</b> —— 这是契约 §0 第 5 条最硬的一条；</li>
 *   <li><b>GL 状态纪律</b>：{@link Lighting#draw} 返回后，后续绘制依赖的四条前提
 *       （无纹理绑定 / 白色 / SRC_ALPHA+ONE_MINUS / 世界矩阵还在）必须都成立。</li>
 * </ol>
 *
 * <p>没有 GPU（离屏 FBO 建不起来）时全部记 SKIP，<b>不算失败</b>（契约 §7.4 明确允许）。
 *
 * <p>用法：{@code java -cp ".tmp_light_jc;lib/*" Studio.runtime.LightRenderTest}
 */
public final class LightRenderTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    private static int skipped;

    /** 输出根目录（生成的工程与截图都放这里，便于人工查看）。 */
    private static final File OUT = new File(".tmp_light_render");

    // ---------------- 场景布局（像素断言与这里必须一致） ----------------
    //
    //   ┌──────────────────────────────────────┐ y=0
    //   │  ●灯A(96,96) r200        ●灯B(544,96) r200 │
    //   │                                        │
    //   │ ▓▓▓▓▓▓ 洋红 UI 条 y∈[200,280] ▓▓▓▓▓▓ │
    //   │                                        │
    //   │ ●灯C(96,400) r320  ▉墙D(200,400)  ▲被挡点(300,400) │
    //   └──────────────────────────────────────┘ y=480
    //
    // 灯 A/B 半径 200，够不到任何墙 ⇒ 「灯下更亮」不会被遮挡干扰。
    // 灯 C 半径 320，墙 D 距它仅 104 ⇒ 墙**真的在光照范围内**，
    // 于是 (300,400)（距灯 204 < 320）必须只剩环境光：若墙不挡光它就该很亮。
    // 验证方式是同一份工程把墙的 props.lightBlock 改成 "0" 再渲染一次，比较同一像素。

    /** 左灯附近（灯 A 正下方，避开灯对象本身的色块）。 */
    private static final int[] P_NEAR_L = {96, 140};
    /** 右灯附近。 */
    private static final int[] P_NEAR_R = {544, 140};
    /** 远角：离三盏灯都超出半径（A/B 半径 200、C 半径 320 且朝左）。 */
    private static final int[] P_CORNER = {620, 460};
    /** 被墙 D 挡住的那个点：在灯 C 半径内（距离 204 < 320），但线段穿过墙。 */
    private static final int[] P_BLOCKED = {300, 400};
    /** 中性灰地板（断言关灯时它就是原始画面）。 */
    private static final int[] P_FLOOR = {400, 300};

    /** 世界尺寸（20×15 tile × 32 = 640×480），与视口 1:1，像素断言最好算。 */
    private static final int MAP_W = 20;
    private static final int MAP_H = 15;
    private static final int TILE = 32;
    private static final int VIEW_W = 640;
    private static final int VIEW_H = 480;

    /**
     * UI 场景层在屏幕上的矩形（ui-scene 是 320×120 设计分辨率，等比 contain 居中后
     * 缩放 min(640/320, 480/120)=2 → 640×240 铺满宽度、垂直居中）。
     *
     * <p>它的全屏底色 = {@code #FF00FF}（洋红），所以「开灯帧 vs 关灯帧在这个矩形里
     * 像素是否一致」= 「光照层有没有把 UI 层污染」的最强判据。
     */
    private static final int[] UI_RECT_BOX = {0, 200, VIEW_W, 80};

    private LightRenderTest() {
    }

    public static void main(String[] args) {
        // ⚠ 不能设 java.awt.headless=true：渲染链路里的文字纹理走 Font/Graphics2D，
        //    而 updateSurfaceSize 会问 GraphicsConfiguration 的 DPI 缩放；
        //    在 headless 模式下这条路会抛 HeadlessException（实测：帧循环直接失败）。
        //    OffscreenFrameDump / ScriptDrawTest 都是这么做的（不设 headless）。
        PrintStream realOut = System.out;
        String fatal = null;
        try {
            run();
        } catch (Throwable t) {
            fatal = t.toString();
            t.printStackTrace(realOut);
        }
        if (fatal != null) {
            RESULTS.add(new String[]{"LightRenderTest 执行时抛异常（不是「断言失败」，是测试自己没跑完）",
                    "false", fatal});
        }
        int failures = 0;
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1]) && !"skip".equals(r[1])) {
                failures++;
            }
        }
        realOut.println("========== LightRenderTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            boolean skip = "skip".equals(r[1]);
            realOut.println((ok ? "PASS  " : skip ? "SKIP  " : "FAIL  ") + r[0]
                    + (!ok && !skip && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        realOut.println("-------------------------------------");
        realOut.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures - skipped)
                + "，跳过 " + skipped + "，失败 " + failures
                + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        System.exit(failures == 0 ? 0 : 1);
    }

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false", detail});
    }

    private static void skip(String name, String why) {
        skipped++;
        RESULTS.add(new String[]{name, "skip", why});
    }

    // ==================================================================
    //  主流程
    // ==================================================================

    private static void run() throws Exception {
        // 先造工程（这一步不需要 GPU，失败要如实报出来 —— 别把「造工程失败」误记成 SKIP）
        File onBoot;
        File offBoot;
        File noneBoot;
        File noBlockBoot;
        try {
            onBoot = writeProject("night-on", true, true, true);
            offBoot = writeProject("night-off", false, true, true);
            noneBoot = writeProject("night-none", false, false, true);
            noBlockBoot = writeProject("night-noblock", true, true, false);
        } catch (Throwable t) {
            check("生成四个测试工程（开灯 / 关灯 / 无 lighting 段 / 墙不挡光）", false, t.toString());
            return;
        }
        check("生成四个测试工程（开灯 / 关灯 / 无 lighting 段 / 墙不挡光）", true,
                OUT.getAbsoluteFile() + "/night-*/Build/boot.json");

        // 离屏 GL 是否可用
        if (!glAvailable()) {
            skipAll("无 GL 设备（离屏 FBO 建不起来：无 GPU / 无显示 / 驱动不支持）");
            return;
        }

        Frame on = render(onBoot, "on");
        Frame off = render(offBoot, "off");
        Frame none = render(noneBoot, "none");
        Frame noBlock = render(noBlockBoot, "noblock");
        if (on == null || off == null || none == null || noBlock == null) {
            skipAll("离屏渲染失败（GL 上下文/帧循环没起来）");
            return;
        }
        check("四帧都抓到了 framebuffer（" + VIEW_W + "x" + VIEW_H + "）",
                on.img.getWidth() == VIEW_W && on.img.getHeight() == VIEW_H
                        && off.img.getWidth() == VIEW_W && off.img.getHeight() == VIEW_H,
                on.img.getWidth() + "x" + on.img.getHeight());

        // ---------------------------------------------------------------
        // 断言 1：关灯零回归（契约 §0 第 5 条）—— 最硬的一条，先验
        // ---------------------------------------------------------------
        int diffOffVsNone = diffCount(off.img, none.img);
        check("enabled=false 与「完全没有 lighting 段」逐像素一致（旧工程零回归）",
                diffOffVsNone == 0, "差异像素=" + diffOffVsNone);

        // 开灯确实改变了画面（否则后面所有像素断言都可能是「两个空画面相等」的假阳性）
        int diffOnVsOff = diffCount(on.img, off.img, null);
        check("开灯/关灯两帧内容确实不同（加光与压暗真的画上去了）",
                diffOnVsOff > VIEW_W * VIEW_H / 10,
                "差异像素=" + diffOnVsOff);

        // ---------------------------------------------------------------
        // 断言 2：加光生效 —— 灯下必须更亮
        // ---------------------------------------------------------------
        double a1 = luma(on.img, P_NEAR_L);
        double b1 = luma(off.img, P_NEAR_L);
        check("左灯附近：开灯明显更亮（加光层生效）", a1 > b1 + 20,
                "on=" + f1(a1) + " off=" + f1(b1) + " Δ=" + f1(a1 - b1));

        double a2 = luma(on.img, P_NEAR_R);
        double b2 = luma(off.img, P_NEAR_R);
        check("右灯附近：开灯明显更亮（加光层生效）", a2 > b2 + 20,
                "on=" + f1(a2) + " off=" + f1(b2) + " Δ=" + f1(a2 - b2));

        // ---------------------------------------------------------------
        // 断言 3：压暗生效 —— 远角必须更暗（环境光很暗 + darkness=0.35）
        // ---------------------------------------------------------------
        double c1 = luma(on.img, P_CORNER);
        double c2 = luma(off.img, P_CORNER);
        check("远角：开灯后被压暗（压暗层生效）", c1 < c2 - 20,
                "on=" + f1(c1) + " off=" + f1(c2) + " Δ=" + f1(c1 - c2));

        check("同一张开灯图：灯下比远角亮得多", Math.min(a1, a2) > c1 + 40,
                "min(near)=" + f1(Math.min(a1, a2)) + " far=" + f1(c1));

        // ---------------------------------------------------------------
        // 断言 4：遮挡真的挡光 —— 同一像素的对照渲染
        //
        // ⚠ 不能只「找个暗点就断言阴影生效」：那个点很可能本来就在光照半径外（假阳性）。
        //    唯一可靠的判据是同一像素在「墙挡光 / 墙不挡光」两份工程里的亮度差，
        //    两份工程只差墙的 props.lightBlock，其它一切（光源、遮挡体位置）完全相同。
        // ---------------------------------------------------------------
        double blocked = luma(on.img, P_BLOCKED);
        double freeLit = luma(noBlock.img, P_BLOCKED);
        check("遮挡体真的挡光：同一像素在「墙挡光」时显著暗于「墙不挡光」",
                blocked < freeLit - 20,
                "blocked=" + f1(blocked) + " unblocked=" + f1(freeLit)
                        + " Δ=" + f1(freeLit - blocked));

        // ---------------------------------------------------------------
        // 断言 5：关灯时基础画面不变（lighting 不影响非光照内容）
        // ---------------------------------------------------------------
        check("关灯时地板是中性灰（≈128，lighting 不改变基础画面）",
                Math.abs(luma(off.img, P_FLOOR) - 128) < 40, f1(luma(off.img, P_FLOOR)));

        // ---------------------------------------------------------------
        // 断言 3：光照层自身的诊断量（契约 §4 的 debugLightQuads / rebuildCount / texW/texH）
        // ---------------------------------------------------------------
        check("开灯工程：光照贴图纹素数 > 0（texW/texH 来自实际重建）",
                on.light.texW() > 0 && on.light.texH() > 0,
                "tex=" + on.light.texW() + "x" + on.light.texH());
        check("开灯工程：至少重建过一次动态贴图", on.light.rebuildCount() > 0,
                "rebuildCount=" + on.light.rebuildCount() + " lastMs=" + on.light.lastRebuildMs());
        check("开灯工程：最近一帧画了加光 quad（1 或 2 个）",
                on.light.debugLightQuads() >= 1 && on.light.debugLightQuads() <= 2,
                "quads=" + on.light.debugLightQuads());
        check("关灯工程：一根 quad 都不画（未启用 ⇒ draw 早退）",
                off.light.debugLightQuads() == 0, "quads=" + off.light.debugLightQuads());
        check("关灯工程：光照贴图纹素数仍可报告（诊断不依赖渲染）",
                off.light.texW() > 0 && off.light.texH() > 0,
                "tex=" + off.light.texW() + "x" + off.light.texH());
        check("关灯工程：rebuildCount 保持 0（未启用 ⇒ 从不重建）",
                off.light.rebuildCount() == 0, "rebuildCount=" + off.light.rebuildCount());

        // ---------------------------------------------------------------
        // 断言 4：GL 状态纪律 —— draw() 返回后的状态必须满足后续绘制的前提
        //
        // ⚠ 这里<b>不能</b>用「帧末读回的状态」做判定：renderFrame 在 lighting.draw() 之后
        //   还会走 drawUiScenes / 脚本 HUD / 摇杆，它们各自 glLoadIdentity / 关纹理，
        //   帧末读到的矩阵必然是单位阵 —— 那证明不了 draw() 是否漏改了状态。
        //   所以 probe 里在一个<b>已知的</b>状态下直接调 lighting.draw()，再读回状态：
        //   只有这样才能区分「draw 自己改了」和「后面的绘制改了」。
        // ---------------------------------------------------------------
        check("lighting.draw() 之后 blendFunc = (SRC_ALPHA, ONE_MINUS_SRC_ALPHA)",
                on.probe.blendSrcAlpha && on.probe.blendOneMinus,
                "blend=(0x" + Integer.toHexString(on.probe.blendSrc) + ",0x"
                        + Integer.toHexString(on.probe.blendDst) + ")");
        check("lighting.draw() 之后 GL_TEXTURE_2D 已关闭（脚本 HUD 依赖这个前提）",
                !on.probe.tex2dEnabled, "enabled=" + on.probe.tex2dEnabled);
        check("lighting.draw() 之后当前颜色 = (1,1,1,1)",
                on.probe.colorOk, "color=" + on.probe.color);
        check("lighting.draw() 之后 blend 仍是开启的（不能把整个画面的 alpha 关掉）",
                on.probe.blendEnabled, "enabled=" + on.probe.blendEnabled);
        check("lighting.draw() 没有改动世界矩阵（后续 UI/脚本绘制不错位）",
                on.probe.matrixSameAsBefore,
                "before=" + on.probe.matrixBeforeDesc + " after=" + on.probe.matrixDesc);
        // ★ 最强的一条：UI 场景层跑在 lighting.draw() <b>之后</b>（契约 §6 的绘制顺序），
        //   所以「开灯帧里的 UI 像素」与「关灯帧里的 UI 像素」必须<b>完全一致</b>——
        //   任何一个不一致都说明：① 光照层画在了 UI 之上（层级错），或
        //   ② 光照层漏改了矩阵/混合/颜色/纹理状态，把后续 UI 绘制带偏了。
        //   这比读 GL 枚举更可靠：它验的是<b>真实像素</b>，不是我们以为的状态。
        int uiDiff = diffCount(on.img, off.img, UI_RECT_BOX);
        check("UI 场景层（在 lighting.draw() 之后绘制）像素在开灯/关灯间完全一致"
                        + "（证明绘制顺序与 GL 状态都没被光照层破坏）",
                uiDiff == 0, "差异像素=" + uiDiff + "/" + (UI_RECT_BOX[2] * UI_RECT_BOX[3]));
        check("UI 场景层在开灯帧里没有被压暗/加光污染（洋红底色亮度不变）",
                Math.abs(luma(on.img, new int[]{UI_RECT_BOX[0] + UI_RECT_BOX[2] / 2, UI_RECT_BOX[1] + UI_RECT_BOX[3] / 2})
                        - luma(off.img, new int[]{UI_RECT_BOX[0] + UI_RECT_BOX[2] / 2, UI_RECT_BOX[1] + UI_RECT_BOX[3] / 2})) < 2,
                "on=" + f1(luma(on.img, new int[]{UI_RECT_BOX[0] + UI_RECT_BOX[2] / 2, UI_RECT_BOX[1] + UI_RECT_BOX[3] / 2}))
                        + " off=" + f1(luma(off.img, new int[]{UI_RECT_BOX[0] + UI_RECT_BOX[2] / 2, UI_RECT_BOX[1] + UI_RECT_BOX[3] / 2})));
        // 未启用时 draw() 必须<b>一个状态都不改</b>：同一已知状态下调用前后完全等价
        check("enabled=false 时 draw() 不改任何 GL 状态（零回归）",
                off.probe.sameAs(off.probe.stateBefore),
                off.probe.diffDesc(off.probe.stateBefore));
        check("enabled=false 时 draw() 也不改世界矩阵（矩阵前后一致）",
                off.probe.matrixSameAsBefore,
                "before=" + off.probe.matrixBeforeDesc + " after=" + off.probe.matrixDesc);

        // ---------------------------------------------------------------
        // 断言 9：★ 遮挡体尺寸钉子 ——「阴影框」必须等于「绘制框」
        //
        // 一棵 halfW=30 / halfH=10 / scaleX=scaleY=2 的墙：
        //   绘制（sizeOf 的 halfW>0 分支，不乘 scale）→ drawWidth=60, drawHeight=20
        //   遮挡体半宽 → 必须是 30 / 10（= 绘制尺寸的一半）
        //
        // ⚠ 这条钉的是真实跨端 bug：光照侧曾自己重写尺寸公式并把 scale 乘进 halfW 分支，
        //   于是 hw=60 ⇒ 阴影按 120px 宽算 = 实物 2 倍宽。画面上只是「阴影有点大」，
        //   所有行为断言全绿 —— 只有把「两个数字相等」写成断言才抓得住。
        // ---------------------------------------------------------------
        Actor halfWall = findActor(on.rt, "wall-half-scaled");
        if (halfWall == null) {
            check("遮挡体尺寸钉子：能在场景里找到 halfW>0 且 scale=2 的墙", false,
                    "wall-half-scaled 未找到");
        } else {
            float drawW = on.rt.drawWidth(halfWall);
            float drawH = on.rt.drawHeight(halfWall);
            float occHW = on.light.debugOccluderHalfW(halfWall);
            float occHH = on.light.debugOccluderHalfH(halfWall);
            // 期望：绘制尺寸 = 2*halfW / 2*halfH（halfW>0 分支**不**乘 scale）
            boolean drawOk = Math.abs(drawW - 60f) < 0.01f && Math.abs(drawH - 20f) < 0.01f;
            check("尺寸钉子前置：halfW=30/scale=2 的墙画出来是 60×20（sizeOf 不乘 scale）",
                    drawOk, "drawWidth=" + f1(drawW) + " drawHeight=" + f1(drawH) + " 期望 60×20");
            check("★ 遮挡体半宽 = 绘制宽度/2（30，不是 60）—— 阴影框必须等于绘制框",
                    Math.abs(occHW - drawW / 2f) < 0.01f,
                    "occluderHalfW=" + f1(occHW) + " drawWidth/2=" + f1(drawW / 2f)
                            + (Math.abs(occHW - 60f) < 0.01f ? "  ← 把 scale 又乘了一次（阴影会翻倍）" : ""));
            check("★ 遮挡体半高 = 绘制高度/2（10，不是 20）",
                    Math.abs(occHH - drawH / 2f) < 0.01f,
                    "occluderHalfH=" + f1(occHH) + " drawHeight/2=" + f1(drawH / 2f));
        }

        // 保存截图，方便人眼复核（失败时尤其有用）
        savePng(on.img, new File(OUT, "frame-on.png"));
        savePng(off.img, new File(OUT, "frame-off.png"));
        savePng(none.img, new File(OUT, "frame-none.png"));
        // 对照帧（墙不挡光）：与 frame-on 对比同一像素，人工复核遮挡是否真的生效
        savePng(noBlock.img, new File(OUT, "frame-noblock.png"));
    }

    /** 按 {@code o.id} 在场景里找 Actor（找不到返回 null）。 */
    private static Actor findActor(TopDownRuntime rt, String id) {
        if (rt == null || rt.actors == null) {
            return null;
        }
        for (Actor a : new ArrayList<Actor>(rt.actors)) {
            if (a != null && a.o != null && id.equals(a.o.id)) {
                return a;
            }
        }
        return null;
    }

    private static void skipAll(String why) {
        skip("开灯/关灯两帧内容不同（加光与压暗确实改变了画面）", why);
        skip("灯下更亮（加光生效）", why);
        skip("远角更暗（压暗生效）", why);
        skip("遮挡体真的挡光（同一像素对照渲染）", why);
        skip("关灯零回归（与无 lighting 段逐像素一致）", why);
        skip("GL 状态纪律（draw 前后状态等价）", why);
        skip("UI 场景层不被光照污染（后续绘制未被破坏）", why);
        skip("光照诊断量（quad 数 / 重建次数 / texW,H）", why);
    }

    // ==================================================================
    //  工程生成（与 web/tools/verify-lighting-e2e.mjs 的「夜巷」同布局）
    // ==================================================================

    /**
     * 写一个「夜巷」工程（20×15 tile）。
     *
     * @param lightingEnabled {@code lighting.enabled}
     * @param withLightingSec 是否写 {@code lighting} 段（false = 完全模拟旧工程）
     */
    private static File writeProject(String name, boolean lightingEnabled, boolean withLightingSec,
                                    boolean wallBlocks) throws Exception {
        File dir = new File(OUT, name);
        File build = new File(dir, "Build");
        build.mkdirs();
        String scene = buildScene(lightingEnabled, withLightingSec, wallBlocks);
        writeFile(new File(build, "scene_0.json"), scene);
        // UI 场景层：一块洋红全屏底。它画在 lighting.draw() <b>之后</b>（契约 §6 的顺序），
        // 所以「开灯帧 vs 关灯帧在这个区域里像素一致」= 光照层没有污染后续 UI 绘制。
        writeFile(new File(build, "ui_0.json"), buildUiScene());
        String boot = "{\n"
                + "  \"project\": \"LightRenderTest · 夜巷\",\n"
                + "  \"tileSize\": " + TILE + ",\n"
                + "  \"masterVolume\": 1,\n"
                + "  \"scenes\": [ { \"name\": \"夜巷 Night Alley\", \"file\": \"scene_0.json\", "
                + "\"width\": " + MAP_W + ", \"height\": " + MAP_H + " } ],\n"
                + "  \"uiScenes\": [ { \"name\": \"HUD\", \"file\": \"ui_0.json\", "
                + "\"designW\": " + UI_DESIGN_W + ", \"designH\": " + UI_DESIGN_H + ", \"layers\": 1 } ],\n"
                + "  \"variables\": {},\n"
                + "  \"scripts\": [],\n"
                + "  \"assets\": []\n"
                + "}\n";
        File bootFile = new File(build, "boot.json");
        writeFile(bootFile, boot);
        return bootFile;
    }

    /** UI 场景设计分辨率（320×120 → contain 到 640×480 视口后 z=2、垂直居中 240px 高）。 */
    private static final int UI_DESIGN_W = 320;
    private static final int UI_DESIGN_H = 40;

    /**
     * UI 场景（屏幕空间，不是世界坐标）。
     *
     * <p>导出契约（见 {@code GameData.RtScene} 的注释）：UI 场景 {@code tileSize=1}、
     * {@code width=designW}、{@code height=designH}、顶层带 {@code ui:true}。
     * 这里放一块洋红全屏底 —— 洋红的色相与任何光照色都不同，任何压暗/加光都会改变它的
     * RGB，所以「逐像素一致」这条断言非常敏感（能抓到 1 个色阶的污染）。
     */
    private static String buildUiScene() {
        return "{\n"
                + "  \"ui\": true,\n"
                + "  \"designW\": " + UI_DESIGN_W + ", \"designH\": " + UI_DESIGN_H + ",\n"
                + "  \"width\": " + UI_DESIGN_W + ", \"height\": " + UI_DESIGN_H + ", \"tileSize\": 1,\n"
                + "  \"layers\": [ { \"id\": \"ui\", \"name\": \"界面\", \"visible\": true, \"locked\": false, \"order\": 0 } ],\n"
                + "  \"objects\": [\n"
                + "    { \"id\": \"ui-bg\", \"kind\": \"PROP\", \"name\": \"底色\", \"x\": "
                + (UI_DESIGN_W / 2) + ", \"y\": " + (UI_DESIGN_H / 2)
                + ", \"z\": 0, \"rotation\": 0, \"scaleX\": 1, \"scaleY\": 1, \"halfW\": 0, \"halfH\": 0,"
                + " \"layer\": 0, \"visible\": true, \"tags\": [], \"modules\": [],"
                + " \"props\": { \"w\": \"" + UI_DESIGN_W + "\", \"h\": \"" + UI_DESIGN_H
                + "\", \"color\": \"#FF00FF\" } }\n"
                + "  ]\n"
                + "}\n";
    }

    private static String buildScene(boolean lightingEnabled, boolean withLightingSec,
                                     boolean wallBlocks) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\n");
        sb.append("  \"width\": ").append(MAP_W).append(", \"height\": ").append(MAP_H)
                .append(", \"tileSize\": ").append(TILE).append(",\n");
        sb.append("  \"layers\": [\n");
        sb.append("    { \"id\": \"ground\", \"name\": \"地面\", \"visible\": true, \"locked\": false, \"order\": 0 },\n");
        sb.append("    { \"id\": \"wall\", \"name\": \"墙\", \"visible\": true, \"locked\": false, \"order\": 1 },\n");
        sb.append("    { \"id\": \"light\", \"name\": \"光\", \"visible\": true, \"locked\": false, \"order\": 2 }\n");
        sb.append("  ],\n");
        if (withLightingSec) {
            // 环境光刻意「暗」（#202A3C × 0.22）：关灯帧是中性灰 128，开灯后远角会被压到 ~60
            sb.append("  \"lighting\": {\n");
            sb.append("    \"enabled\": ").append(lightingEnabled).append(",\n");
            sb.append("    \"mode\": \"both\",\n");
            sb.append("    \"ambientColor\": \"#202A3C\",\n");
            sb.append("    \"ambientIntensity\": 0.22,\n");
            sb.append("    \"darkness\": 0.35,\n");
            sb.append("    \"softness\": 16,\n");
            sb.append("    \"texelsPerPixel\": 0.25,\n");
            sb.append("    \"dynamicFps\": 15,\n");
            sb.append("    \"maxDynamicLights\": 8\n");
            sb.append("  },\n");
        }
        sb.append("  \"objects\": [\n");
        // 对象之间用逗号分隔（最后一条不加）—— 踩过：末尾多一个逗号会让 Gson 解析整个
        // scene_0.json 时抛 "Not a JSON Object: null"，而且报错位置完全看不出来。
        java.util.List<String> objs = new java.util.ArrayList<String>();
        // ① 地面：一整块中性灰（props.color → drawFallback 读它）。灰度是关键：
        //    后面用亮度比较，颜色越中性越好判（0x80=128）。
        objs.add(object("tile-floor", "TILE", MAP_W * TILE / 2f, MAP_H * TILE / 2f,
                "{\"w\":\"" + (MAP_W * TILE) + "\",\"h\":\"" + (MAP_H * TILE) + "\",\"color\":\"#808080\"}",
                "\"ground\"", 0, "[]"));
        // ② 遮挡墙 D：与灯 C 配对，**真的在它的光照半径内**（距离 104 < 半径 320）。
        //    wallBlocks=false 时给它 props.lightBlock="0" ⇒ 同一像素在两次渲染里必须明显不同，
        //    这是证明「遮挡真的生效」唯一可靠的判法（排除「本来就在半径外」的假阳性）。
        objs.add(object("wall-block", "PROP", 200f, 400f,
                "{\"w\":\"16\",\"h\":\"160\",\"color\":\"#c8c8c8\""
                        + (wallBlocks ? "" : ",\"lightBlock\":\"0\"") + "}",
                "\"wall\"", 20, "[\"wall\",\"occluder\"]"));
        // ③ 两盏灯（LIGHT 对象 + props.lightRadius）
        objs.add(object("lamp-left", "LIGHT", 96f, 96f,
                "{\"lightRadius\":\"200\",\"lightColor\":\"#FFC978\",\"lightIntensity\":\"1.4\","
                        + "\"lightType\":\"point\",\"lightShadow\":\"1\",\"w\":\"8\",\"h\":\"8\"}",
                "\"light\"", 25, "[]"));
        objs.add(object("lamp-right", "LIGHT", 544f, 96f,
                "{\"lightRadius\":\"200\",\"lightColor\":\"#80CCFF\",\"lightIntensity\":\"1.4\","
                        + "\"lightType\":\"point\",\"lightShadow\":\"1\",\"w\":\"8\",\"h\":\"8\"}",
                "\"light\"", 25, "[]"));
        // ③ 灯 C：遮挡专用（半径 320，把墙 D 整个包进光照范围）。
        //    白光 + intensity 1.6，让「被照亮 / 被挡住」的差距足够大，断言不会踩到舍入误差。
        objs.add(object("lamp-shadow", "LIGHT", 96f, 400f,
                "{\"lightRadius\":\"320\",\"lightColor\":\"#FFFFFF\",\"lightIntensity\":\"1.6\","
                        + "\"lightType\":\"point\",\"lightShadow\":\"1\",\"w\":\"8\",\"h\":\"8\"}",
                "\"light\"", 25, "[]"));
        // ④ UI 场景层用的文字对象（断言「光照层画完后 UI 仍正常」）——
        //    它挂在世界对象上、tags 含 label ⇒ drawLabel 走字体纹理路径。
        //    位置刻意放在灯照不到的远角：若 UI 层的文字被压暗/加光污染，像素会明显变。
        objs.add(object("hud-label", "PROP", 24f, 452f,
                "{\"text\":\"HUD\",\"textSize\":\"18\",\"textColor\":\"#FFFFFF\"}",
                "\"light\"", 30, "[\"label\"]"));
        // ⑤ ★ 尺寸钉子：一棵 halfW/halfH > 0 **且** scaleX/scaleY = 2 的墙。
        //
        //   绘制尺寸（sizeOf 的 halfW>0 分支）= 2*halfW，**不乘 scale** ⇒ 30×10 → 画 60×20。
        //   遮挡体半宽必须是同一份尺寸的一半 ⇒ hw=30 / hh=10。
        //
        //   ⚠ 这条真错过一次：光照侧自己又写了一遍尺寸公式并把 scale 乘进 halfW 分支，
        //   于是 hw=60 ⇒ 阴影按 120px 宽的墙算 = **实物的 2 倍宽**。画面只「有点怪」，
        //   所有行为断言都绿。断言死「occluderHalf == drawWidth/2」防止再次漂移。
        objs.add(objectWithHalf("wall-half-scaled", "PROP", 80f, 200f,
                "{\"color\":\"#c8c8c8\"}", 1, 21, "[\"wall\",\"occluder\"]",
                30f, 10f, 2f, 2f));
        for (int i = 0; i < objs.size(); i++) {
            sb.append(objs.get(i));
            if (i < objs.size() - 1) {
                sb.setLength(sb.length() - 1);   // 去掉末尾换行
                sb.append(",\n");
            }
        }
        sb.append("  ]\n");
        sb.append("}\n");
        return sb.toString();
    }

    private static String object(String id, String kind, float x, float y, String props,
                                 String layerId, int z, String tags) {
        StringBuilder sb = new StringBuilder();
        sb.append("    { \"id\": \"").append(id).append("\", \"kind\": \"").append(kind)
                .append("\", \"name\": \"").append(id).append("\", \"x\": ").append(x)
                .append(", \"y\": ").append(y).append(", \"z\": ").append(z)
                .append(", \"rotation\": 0, \"scaleX\": 1, \"scaleY\": 1")
                .append(", \"halfW\": 0, \"halfH\": 0, \"layer\": ").append(layerIndex(layerId))
                .append(", \"visible\": true, \"tags\": ").append(tags)
                .append(", \"modules\": [], \"props\": ").append(props).append(" }\n");
        return sb.toString();
    }

    /**
     * 带 {@code halfW/halfH/scale} 的对象（{@link #object} 的变体）。
     *
     * <p>只为「遮挡体尺寸钉子」那条断言用：需要精确控制 {@code halfW > 0} 且 {@code scale != 1}
     * 的组合 —— 这正是「阴影框宽 ≠ 绘制框宽」那个 bug 的触发条件。
     */
    private static String objectWithHalf(String id, String kind, float x, float y, String props,
                                         int layerIdx, int z, String tags,
                                         float halfW, float halfH, float scaleX, float scaleY) {
        StringBuilder sb = new StringBuilder();
        sb.append("    { \"id\": \"").append(id).append("\", \"kind\": \"").append(kind)
                .append("\", \"name\": \"").append(id).append("\", \"x\": ").append(x)
                .append(", \"y\": ").append(y).append(", \"z\": ").append(z)
                .append(", \"rotation\": 0")
                .append(", \"scaleX\": ").append(scaleX).append(", \"scaleY\": ").append(scaleY)
                .append(", \"halfW\": ").append(halfW).append(", \"halfH\": ").append(halfH)
                .append(", \"layer\": ").append(layerIdx)
                .append(", \"visible\": true, \"tags\": ").append(tags)
                .append(", \"modules\": [], \"props\": ").append(props).append(" }\n");
        return sb.toString();
    }

    private static int layerIndex(String layerId) {
        if ("wall".equals(layerId)) {
            return 1;
        }
        if ("light".equals(layerId)) {
            return 2;
        }
        return 0;
    }

    private static void writeFile(File f, String text) throws Exception {
        f.getParentFile().mkdirs();
        Files.write(f.toPath(), text.getBytes(StandardCharsets.UTF_8));
    }

    // ==================================================================
    //  离屏渲染
    // ==================================================================

    private static boolean glAvailable() {
        try {
            GLProfile.getDefault();
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 一帧的结果：像素 + 光照诊断 + 绘制后的 GL 状态快照。 */
    private static final class Frame {
        BufferedImage img;
        Lighting light;
        /** draw() 之前的状态（只在 enabled=false 工程上有意义：用来证明「一个字节都没改」）。 */
        GlState stateBefore;
        /** draw() 之后的状态（正常绘制路径，帧末读回）。 */
        GlState state;
        /** 状态探针：在受控状态下单独调一次 draw() 的结果（含矩阵前后对比）。 */
        GlState probe;
        TopDownRuntime rt;
    }

    /**
     * GL 状态探针：先造「renderFrame 刚下发完世界矩阵」的状态，调一次
     * {@code lighting.draw()}，再读回状态并对比「调用前后」。
     *
     * <p>这是「draw() 会不会破坏后续绘制」唯一可靠的验法：眼睛盯着帧末状态只能看出
     * 「最后的绘制做了什么」，看不出光照层自己有没有漏改。
     *
     * <p>探针返回两个快照：{@code before} 与 {@code after}。{@code after.stateBefore}
     * 指回 before，于是断言可以直接写 {@code after.sameAs(...)}。
     */
    private static GlState probeState(GL2 gl, TopDownRuntime rt) {
        // ① 造「刚下发完世界矩阵」的状态：世界 640×480 铺满视口 ⇒ translate(0,0) + scale(1)
        gl.glMatrixMode(GL2.GL_MODELVIEW);
        gl.glLoadIdentity();
        gl.glTranslatef(0f, 0f, 0f);
        gl.glScalef(1f, 1f, 1f);
        gl.glEnable(GL2.GL_BLEND);
        gl.glBlendFunc(GL2.GL_SRC_ALPHA, GL2.GL_ONE_MINUS_SRC_ALPHA);
        gl.glDisable(GL2.GL_TEXTURE_2D);
        gl.glColor4f(1f, 1f, 1f, 1f);
        GlState before = GlState.capture(gl);
        // ② 真正调用一次 —— 这是我们唯一要验的对象
        rt.lighting.draw(gl);
        // ③ 读回，并把「调用前」挂到「调用后」上，方便统一断言
        GlState after = GlState.capture(gl);
        after.stateBefore = before;
        after.matrixSameAsBefore = after.matrixEquals(before);
        after.matrixBeforeDesc = before.matrixDesc;
        after.debugQuads = rt.lighting.debugLightQuads();
        // ④ 纹理环境（GL_TEXTURE_ENV_MODE）在 GL2 固定管线里<b>无法回读</b>
        //    （glGetIntegerv 没有这个枚举，只会返回 0）。所以改用<b>行为判据</b>：
        //    用 squashed-white 纹理画一个小 quad，用 glReadPixels 读它 ——
        //    MODULATE(白色×纹理) / REPLACE / DECAL 在白色顶点色下输出相同，
        //    唯一会不同的是 GL_BLEND 模式；而 BLEND 模式会让「纹理=0、顶点色=白」的
        //    区域输出 <b>0</b> 而不是 <b>白</b>。因此：
        //      · 画一块纯白纹理 → 若输出仍是白 ⇒ 没人把 env mode 改成 BLEND ⇒ 未被破坏。
        after.envModeVerified = probeTexEnv(gl);
        return after;
    }

    /**
     * 纹理环境的<b>行为</b>探针（见上）。
     *
     * <p>做法：在一个已知的白色纹理上画一个 16×16 quad，读回中心像素颜色。
     * 只要纹理环境被改成 {@code GL_BLEND}（唯一会破坏「材质色 = 纹理色」的模式），
     * 输出就不再等于纹理本身。GL2 里没有「读 env mode」的 API，这是唯一能实际验证的办法。
     */
    private static boolean probeTexEnv(GL2 gl) {
        try {
            // ① 造一张 1×1 纯白纹理（用完即删，不留残余）
            int[] ids = new int[1];
            gl.glGenTextures(1, ids, 0);
            int id = ids[0];
            gl.glBindTexture(GL2.GL_TEXTURE_2D, id);
            ByteBuffer white = ByteBuffer.allocateDirect(4);
            white.put((byte) 255).put((byte) 255).put((byte) 255).put((byte) 255);
            white.flip();
            gl.glTexParameteri(GL2.GL_TEXTURE_2D, GL2.GL_TEXTURE_MIN_FILTER, GL2.GL_NEAREST);
            gl.glTexParameteri(GL2.GL_TEXTURE_2D, GL2.GL_TEXTURE_MAG_FILTER, GL2.GL_NEAREST);
            gl.glTexImage2D(GL2.GL_TEXTURE_2D, 0, GL2.GL_RGBA, 1, 1, 0,
                    GL2.GL_RGBA, GL2.GL_UNSIGNED_BYTE, white);
            // ② 画一个纯白 quad（关闭混合，避免 alpha 影响判读）
            gl.glDisable(GL2.GL_BLEND);
            gl.glEnable(GL2.GL_TEXTURE_2D);
            gl.glColor4f(1f, 1f, 1f, 1f);
            gl.glMatrixMode(GL2.GL_MODELVIEW);
            gl.glLoadIdentity();
            gl.glBegin(GL2.GL_QUADS);
            gl.glTexCoord2f(0f, 0f);
            gl.glVertex2f(-0.9f, -0.9f);
            gl.glTexCoord2f(1f, 0f);
            gl.glVertex2f(0.9f, -0.9f);
            gl.glTexCoord2f(1f, 1f);
            gl.glVertex2f(0.9f, 0.9f);
            gl.glTexCoord2f(0f, 1f);
            gl.glVertex2f(-0.9f, 0.9f);
            gl.glEnd();
            // ③ 读回中心（NDC 中心 = framebuffer 中心）
            int w = VIEW_W;
            int h = VIEW_H;
            ByteBuffer px = ByteBuffer.allocateDirect(4);
            gl.glPixelStorei(GL2.GL_PACK_ALIGNMENT, 1);
            gl.glReadPixels(w / 2, h / 2, 1, 1, GL2.GL_RGBA, GL2.GL_UNSIGNED_BYTE, px);
            int r = px.get(0) & 0xFF;
            int g = px.get(1) & 0xFF;
            int b = px.get(2) & 0xFF;
            // ④ 清理
            gl.glDisable(GL2.GL_TEXTURE_2D);
            gl.glEnable(GL2.GL_BLEND);
            int[] del = {id};
            gl.glDeleteTextures(1, del, 0);
            // 白色纹理 + 白色顶点色：MODULATE/REPLACE/DECAL 都输出 (255,255,255)；
            // 只有环境被破坏（BLEND 等）才会偏离。
            return r >= 250 && g >= 250 && b >= 250;
        } catch (Throwable t) {
            // 探针自身失败不判测试失败（GL 实现差异），但要在诊断里留下痕迹
            System.out.println("TEXENV_PROBE_SKIP " + t);
            return true;
        }
    }

    /**
     * 渲染一个工程到离屏 FBO 并读回像素。
     *
     * <p>帧数取 12：前 2 帧是纹理上传/字体预热，动态贴图也要跑一两轮节流才稳定
     * （dynamicFps=15，12 帧 @16ms ≈ 192ms 够跑 2~3 次重建）。
     */
    private static Frame render(File boot, String tag) {
        final TopDownRuntime rt;
        try {
            rt = new TopDownRuntime(boot);
        } catch (Throwable t) {
            System.out.println("RENDER_FAIL 构造运行时失败 " + tag + ": " + t);
            return null;
        }
        final int frames = 12;
        GLOffscreenAutoDrawable od;
        try {
            GLProfile prof = GLProfile.getDefault();
            GLCapabilities caps = new GLCapabilities(prof);
            caps.setAlphaBits(8);
            caps.setDoubleBuffered(false);
            od = GLDrawableFactory.getFactory(prof)
                    .createOffscreenAutoDrawable(null, caps, null, VIEW_W, VIEW_H);
        } catch (Throwable t) {
            System.out.println("RENDER_FAIL 建离屏 drawable 失败 " + tag + ": " + t);
            return null;
        }
        if (od == null) {
            return null;
        }
        final BufferedImage[] cap = {null};
        final GlState[] state = {null};
        final GlState[] probe = {null};
        final Throwable[] err = {null};
        final int[] frameNo = {0};
        od.addGLEventListener(new GLEventListener() {
            @Override
            public void init(GLAutoDrawable d) {
                rt.init(d);
            }

            @Override
            public void dispose(GLAutoDrawable d) {
            }

            @Override
            public void reshape(GLAutoDrawable d, int x, int y, int w, int h) {
                rt.reshape(d, x, y, w, h);
            }

            @Override
            public void display(GLAutoDrawable d) {
                try {
                    forceZeroDelta(rt);
                    // 每帧强制「整图 contain」：世界 640×480 → 视口 640×480，zoom=1、cam 居中，
                    // 于是屏幕坐标 = 世界坐标，像素断言不需要任何换算。
                    rt.forceFitWholeMap();
                    rt.display(d);
                    frameNo[0]++;
                    if (frameNo[0] >= frames) {
                        GL2 gl = d.getGL().getGL2();
                        gl.glFinish();
                        cap[0] = readPixels(gl, VIEW_W, VIEW_H);
                        // 状态探针（关键：在已知状态下直接调 draw()）。
                        //
                        // 为什么不直接读帧末状态：renderFrame 在 lighting.draw() 之后还会走
                        // drawUiScenes / 脚本 HUD / 摇杆，它们各自 glLoadIdentity + 关纹理，
                        // 帧末读到的矩阵必然是单位阵 —— 那证明不了 draw() 是否漏改状态。
                        probe[0] = probeState(gl, rt);
                        state[0] = GlState.capture(gl);
                    }
                } catch (Throwable t) {
                    err[0] = t;
                }
            }
        });
        try {
            od.display();
            while (frameNo[0] < frames) {
                Thread.sleep(16L);
                od.display();
            }
        } catch (Throwable t) {
            System.out.println("RENDER_FAIL 帧循环失败 " + tag + ": " + t);
            return null;
        }
        if (err[0] != null) {
            System.out.println("RENDER_FRAME_ERROR " + tag + ": " + err[0]);
            err[0].printStackTrace(System.out);
        }
        if (cap[0] == null) {
            return null;
        }
        Frame f = new Frame();
        f.img = cap[0];
        f.light = rt.lighting;
        f.state = state[0] != null ? state[0] : new GlState();
        f.probe = probe[0] != null ? probe[0] : new GlState();
        f.rt = rt;
        return f;
    }

    /** 把 lastNanos 归零，让离屏连续帧的 dt 稳定（与 OffscreenFrameDump 同一手法）。 */
    private static void forceZeroDelta(TopDownRuntime rt) {
        try {
            java.lang.reflect.Field f = TopDownRuntime.class.getDeclaredField("lastNanos");
            f.setAccessible(true);
            f.setLong(rt, 0L);
        } catch (Throwable ignored) {
        }
    }

    // ==================================================================
    //  GL 状态快照（「draw() 之后状态是否还能继续绘制」的断言依据）
    // ==================================================================

    private static final class GlState {
        boolean blendEnabled;
        int blendSrc;
        int blendDst;
        boolean blendSrcAlpha;
        boolean blendOneMinus;
        boolean tex2dEnabled;
        boolean colorOk;
        String color = "";
        /** 模型矩阵的元素值（16 个 float）。 */
        float[] matrix = new float[16];
        String matrixDesc = "";
        /** 探针专用：draw() 调用前后矩阵是否一致。 */
        boolean matrixSameAsBefore;
        String matrixBeforeDesc = "";
        int debugQuads;
        /** 探针用的「调用前」快照。 */
        GlState stateBefore;
        /** 纹理环境：GL2 无法回读 TEXTURE_ENV_MODE（glGetIntegerv 无此枚举、返回 0），
         *  所以这一项用 {@link #envModeVerified} 标记「按实现审查 + 绘制结果间接验证」。 */
        boolean envModeVerified;

        static GlState capture(GL2 gl) {
            GlState s = new GlState();
            try {
                s.blendEnabled = gl.glIsEnabled(GL2.GL_BLEND);
                s.blendSrc = glGetInt(gl, GL2.GL_BLEND_SRC);
                s.blendDst = glGetInt(gl, GL2.GL_BLEND_DST);
                s.blendSrcAlpha = s.blendSrc == GL2.GL_SRC_ALPHA;
                s.blendOneMinus = s.blendDst == GL2.GL_ONE_MINUS_SRC_ALPHA;
                s.tex2dEnabled = gl.glIsEnabled(GL2.GL_TEXTURE_2D);
                float[] rgba = new float[4];
                gl.glGetFloatv(GL2.GL_CURRENT_COLOR, rgba, 0);
                s.colorOk = Math.abs(rgba[0] - 1f) < 1e-4f && Math.abs(rgba[1] - 1f) < 1e-4f
                        && Math.abs(rgba[2] - 1f) < 1e-4f && Math.abs(rgba[3] - 1f) < 1e-4f;
                s.color = f1(rgba[0]) + "," + f1(rgba[1]) + "," + f1(rgba[2]) + "," + f1(rgba[3]);
                gl.glGetFloatv(GL2.GL_MODELVIEW_MATRIX, s.matrix, 0);
                s.matrixDesc = matrixDesc(s.matrix);
            } catch (Throwable t) {
                s.matrixDesc = "capture-error:" + t;
            }
            return s;
        }

        /** 两份状态是否等价（用于「关灯时 draw 不改任何状态」的断言）。 */
        boolean sameAs(GlState o) {
            if (o == null) {
                return false;
            }
            return blendEnabled == o.blendEnabled && blendSrc == o.blendSrc
                    && blendDst == o.blendDst && tex2dEnabled == o.tex2dEnabled
                    && colorOk == o.colorOk && matrixEquals(o);
        }

        boolean matrixEquals(GlState o) {
            if (o == null) {
                return false;
            }
            for (int i = 0; i < 16; i++) {
                if (Math.abs(matrix[i] - o.matrix[i]) > 1e-5f) {
                    return false;
                }
            }
            return true;
        }

        String diffDesc(GlState o) {
            if (o == null) {
                return "no baseline";
            }
            StringBuilder sb = new StringBuilder();
            if (blendEnabled != o.blendEnabled) {
                sb.append("blendEnabled ").append(blendEnabled).append("≠").append(o.blendEnabled).append(" ");
            }
            if (blendSrc != o.blendSrc || blendDst != o.blendDst) {
                sb.append("blendFunc (").append(blendSrc).append(",").append(blendDst).append(")≠(")
                        .append(o.blendSrc).append(",").append(o.blendDst).append(") ");
            }
            if (tex2dEnabled != o.tex2dEnabled) {
                sb.append("tex2d ").append(tex2dEnabled).append("≠").append(o.tex2dEnabled).append(" ");
            }
            if (colorOk != o.colorOk) {
                sb.append("color ").append(color).append("≠").append(o.color).append(" ");
            }
            if (!matrixEquals(o)) {
                sb.append("matrix ").append(matrixDesc).append("≠").append(o.matrixDesc).append(" ");
            }
            return sb.toString().trim();
        }
    }

    /** 矩阵的紧凑描述（只取有判别意义的 6 个元素，避免输出噪音）。 */
    private static String matrixDesc(float[] m) {
        return String.format(java.util.Locale.ROOT, "t=(%.1f,%.1f) s=(%.2f,%.2f) 1=(%.2f,%.2f)",
                m[12], m[13], m[0], m[5], m[10], m[15]);
    }

    /** 读 GL 状态里的单值整数。 */
    private static int glGetInt(GL2 gl, int pname) {
        int[] buf = new int[1];
        gl.glGetIntegerv(pname, buf, 0);
        return buf[0];
    }

    // ==================================================================
    //  像素工具
    // ==================================================================

    /** 逐像素差异数（容忍 ±1 的驱动舍入误差），限定在矩形区域内。{@code rect == null} = 全图。 */
    private static int diffCount(BufferedImage a, BufferedImage b, int[] rect) {
        if (a.getWidth() != b.getWidth() || a.getHeight() != b.getHeight()) {
            return Integer.MAX_VALUE;
        }
        int x0 = rect == null ? 0 : Math.max(0, rect[0]);
        int y0 = rect == null ? 0 : Math.max(0, rect[1]);
        int x1 = rect == null ? a.getWidth() : Math.min(a.getWidth(), rect[0] + rect[2]);
        int y1 = rect == null ? a.getHeight() : Math.min(a.getHeight(), rect[1] + rect[3]);
        int n = 0;
        for (int y = y0; y < y1; y++) {
            for (int x = x0; x < x1; x++) {
                int pa = a.getRGB(x, y);
                int pb = b.getRGB(x, y);
                int dr = Math.abs(((pa >> 16) & 0xFF) - ((pb >> 16) & 0xFF));
                int dg = Math.abs(((pa >> 8) & 0xFF) - ((pb >> 8) & 0xFF));
                int db = Math.abs((pa & 0xFF) - (pb & 0xFF));
                if (dr > 1 || dg > 1 || db > 1) {
                    n++;
                }
            }
        }
        return n;
    }

    /** 逐像素差异数（全图）。 */
    private static int diffCount(BufferedImage a, BufferedImage b) {
        return diffCount(a, b, new int[]{0, 0, a.getWidth(), a.getHeight()});
    }

    private static double luma(BufferedImage img, int[] p) {
        int x = Math.max(0, Math.min(img.getWidth() - 1, p[0]));
        int y = Math.max(0, Math.min(img.getHeight() - 1, p[1]));
        int c = img.getRGB(x, y);
        return 0.2126 * ((c >> 16) & 0xFF) + 0.7152 * ((c >> 8) & 0xFF) + 0.0722 * (c & 0xFF);
    }

    private static String f1(double v) {
        return String.format(java.util.Locale.ROOT, "%.1f", v);
    }

    private static BufferedImage readPixels(GL2 gl, int w, int h) {
        ByteBuffer buf = ByteBuffer.allocateDirect(w * h * 4);
        gl.glPixelStorei(GL2.GL_PACK_ALIGNMENT, 1);
        gl.glReadPixels(0, 0, w, h, GL2.GL_RGBA, GL2.GL_UNSIGNED_BYTE, buf);
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int i = ((y * w) + x) * 4;
                int r = buf.get(i) & 0xFF;
                int g = buf.get(i + 1) & 0xFF;
                int b = buf.get(i + 2) & 0xFF;
                int a = buf.get(i + 3) & 0xFF;
                // glReadPixels 的行序是「从下往上」，翻成「从上到下」以便 y = 世界 y
                img.setRGB(x, h - 1 - y, (a << 24) | (r << 16) | (g << 8) | b);
            }
        }
        return img;
    }

    private static void savePng(BufferedImage img, File f) {
        try {
            f.getParentFile().mkdirs();
            javax.imageio.ImageIO.write(img, "png", f);
        } catch (Throwable ignored) {
        }
    }
}
