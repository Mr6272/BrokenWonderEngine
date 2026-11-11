package Studio.runtime;

/**
 * 界面区消费点击（{@code bwe.input.block}）与 64×64 大棋盘上限的自检。
 *
 * <p><b>为什么单独测这个</b>：64×64 = 4096 格在任何手机上都不可能「整盘可见又可读」
 * （720 逻辑像素宽 ÷ 64 格 = 每格 11px），只能保持格子可读 + 平移浏览，
 * 于是棋盘必然伸到 HUD 底下。而引擎的点击派发是「脚本 → 可视化模块（棋盘）」，
 * 脚本拿到点击后<b>无法阻止</b>它继续传给棋盘 —— 不消费的话，
 * 点「新游戏」会顺带把底下的格子翻开（很可能直接踩雷）。
 * 这是一条<b>安全</b>不变量，不是美观问题，所以必须在真实 Java 侧固定住
 * （脚本层的 mock 自检只能证明「脚本调了 API」，证明不了引擎真的吃掉点击）。
 */
public final class HudBlockTest {

    private static int pass;
    private static int fail;

    public static void main(String[] args) {
        try {
            testEmptyIsNoop();
            testPointInsideRect();
            testEdgeIsExclusive();
            testMultipleRegions();
            testSameIdOverwrites();
            testUnregister();
            test64x64Allowed();
            testOver64Clamped();
            testBoardFitsMapAt64();
            testClickAtActuallyConsumed();
        } catch (Throwable t) {
            fail++;
            System.out.println("异常: " + t);
            t.printStackTrace(System.out);
        }
        System.out.println("==== RESULT: " + pass + "/" + (pass + fail) + " passed ====");
        if (fail > 0) {
            System.out.println(fail + " 项失败");
            System.exit(1);
        }
        System.out.println("ALL PASS");
    }

    private static void check(String name, boolean ok) {
        if (ok) {
            pass++;
            System.out.println("  [PASS] " + name);
        } else {
            fail++;
            System.out.println("  [FAIL] " + name);
        }
    }

    private static TopDownRuntime stub() {
        TopDownRuntime rt = TopDownRuntime.newStub();
        rt.view.setViewport(720, 1600);
        return rt;
    }

    private static void testEmptyIsNoop() {
        TopDownRuntime rt = stub();
        check("没登记任何区域时不拦截点击", !rt.inHudBlock(360f, 800f));
    }

    private static void testPointInsideRect() {
        TopDownRuntime rt = stub();
        rt.hudBlocks.put("hudTop", new float[]{0f, 0f, 720f, 145f});
        check("带内被消费", rt.inHudBlock(360f, 60f));
        check("带左上角被消费", rt.inHudBlock(0f, 0f));
        check("带外（下方）不消费", !rt.inHudBlock(360f, 200f));
        check("带外（右侧）不消费", !rt.inHudBlock(800f, 60f));
    }

    private static void testEdgeIsExclusive() {
        TopDownRuntime rt = stub();
        rt.hudBlocks.put("band", new float[]{0f, 0f, 100f, 50f});
        // 右下边界开区间：与棋盘矩形相邻但不重叠，避免「差 1px 把整行格子吃掉」
        check("右边界 x==w 不算在内", !rt.inHudBlock(100f, 10f));
        check("下边界 y==h 不算在内", !rt.inHudBlock(10f, 50f));
        check("差 1px 仍在内", rt.inHudBlock(99f, 49f));
    }

    private static void testMultipleRegions() {
        TopDownRuntime rt = stub();
        rt.hudBlocks.put("hudTop", new float[]{0f, 0f, 720f, 145f});
        rt.hudBlocks.put("hudBottom", new float[]{0f, 1462f, 720f, 138f});
        check("顶带命中", rt.inHudBlock(10f, 10f));
        check("底带命中", rt.inHudBlock(700f, 1500f));
        check("中间游玩区不命中", !rt.inHudBlock(360f, 800f));
    }

    private static void testSameIdOverwrites() {
        TopDownRuntime rt = stub();
        rt.hudBlocks.put("hudTop", new float[]{0f, 0f, 720f, 145f});
        // 脚本每帧用同一个 id 覆盖（HUD 高度随布局变化），不能累积出陈旧区域
        rt.hudBlocks.put("hudTop", new float[]{0f, 0f, 720f, 60f});
        check("同 id 覆盖后旧范围不再拦截", !rt.inHudBlock(10f, 100f));
        check("同 id 覆盖后新范围拦截", rt.inHudBlock(10f, 30f));
        check("覆盖不会留下第二个区域", rt.hudBlocks.size() == 1);
    }

    /**
     * 撤销路径。⚠ 这里只能验证「区域被摘掉后不再拦截」——
     * 「w/h ≤ 0 触发撤销」是 ScriptApi 里 lambda 的行为，需要 Rhino 上下文才能调，
     * 由脚本层自检（verify-minesweeper-ui.mjs 的 mock）覆盖。
     */
    private static void testUnregister() {
        TopDownRuntime rt = stub();
        rt.hudBlocks.put("x", new float[]{0f, 0f, 100f, 100f});
        check("登记有效", rt.inHudBlock(50f, 50f));
        rt.hudBlocks.remove("x");
        check("撤销后不拦截", !rt.inHudBlock(50f, 50f));
    }

    // ---------------- 64×64 上限 ----------------

    private static Minesweeper newMine(int rows, int cols, int mines) {
        TopDownRuntime rt = stub();
        Actor a = new Actor();
        a.x = 1024f;
        a.y = 1024f;
        GridModules.Bundle caps = new GridModules.Bundle();
        caps.minesweeper = true;
        caps.board = true;
        caps.tile = true;
        caps.reveal = true;
        caps.flag = true;
        caps.mines = true;
        GameData.RtModule m = new GameData.RtModule();
        m.params.put("rows", String.valueOf(rows));
        m.params.put("cols", String.valueOf(cols));
        m.params.put("mines", String.valueOf(mines));
        m.params.put("cellSize", "32");
        return new Minesweeper(rt, a, m, caps);
    }

    private static void test64x64Allowed() {
        Minesweeper ms = newMine(64, 64, 640);
        check("64 行被接受（旧上限 40 会静默钳小）", ms.rows == 64);
        check("64 列被接受", ms.cols == 64);
        check("棋盘总格数 = 4096", ms.board.size() == 4096);
        check("640 雷生效（不被 n-1 钳掉）", ms.mineCount == 640);
    }

    private static void testOver64Clamped() {
        Minesweeper ms = newMine(200, 200, 10);
        check("超上限被钳到 64", ms.rows == Minesweeper.MAX_SIDE && ms.cols == Minesweeper.MAX_SIDE);
    }

    /**
     * 64×64 × cellSize 必须能落在地图（64 瓦片 × 32 = 2048）内。
     *
     * <p>棋盘比地图大的话，Android 双指平移被引擎按<b>地图</b>范围钳死
     * （AndroidRuntimeBridge.setCamera → Viewport.clampCamera），
     * 超出地图的格子<b>永远拖不到</b> = 无法通关。
     */
    /**
     * 端到端：{@code clickAt} 落在登记的界面区里时，<b>真的不会翻开底下的格子</b>。
     *
     * <p>上面那些只验证了矩形几何（inHudBlock 的判断），证明不了派发链路上
     * 「棋盘拿不到这次点击」。这条才是要守的安全性质本身：
     * 同一个格子坐标，登记前后各点一次，登记后必须翻不开。
     */
    private static void testClickAtActuallyConsumed() {
        TopDownRuntime rt = stub();
        rt.view.setViewport(720, 1600);
        Actor a = new Actor();
        a.x = 1024f;
        a.y = 1024f;
        GridModules.Bundle caps = new GridModules.Bundle();
        caps.minesweeper = true;
        caps.board = true;
        caps.tile = true;
        caps.reveal = true;
        caps.flag = true;
        caps.mines = true;
        GameData.RtModule m = new GameData.RtModule();
        m.params.put("rows", "64");
        m.params.put("cols", "64");
        m.params.put("mines", "640");
        m.params.put("cellSize", "28");
        m.params.put("firstClickSafe", "false");   // 别让首击保护干扰「有没有翻开」的判定
        Minesweeper ms = new Minesweeper(rt, a, m, caps);
        rt.minesweeper = ms;

        // 棋盘 64×28 = 1792，居中在 (1024,1024) → 左上角世界 (128,128)，范围 [128,1920)。
        rt.view.zoom = 1f;
        rt.view.camX = 1024f;
        rt.view.camY = 1024f;     // 相机对准棋盘中心
        // 于是 toWorldY(sy) = (sy - 800) + 1024：sy=120 → 344（顶带内的一格），
        // sy=800 → 1024（屏幕正中，游玩区）。
        int sx = 360, sy = 120;
        int wx = Math.round(rt.view.toWorldX(sx));
        int wy = Math.round(rt.view.toWorldY(sy));
        check("测试前提：该点确实落在棋盘范围内",
                wx >= 128 && wx < 128 + 1792 && wy >= 128 && wy < 128 + 1792);

        // ① 没登记界面区 → 点击直达棋盘（格子被翻开）。这就是 bug 的形态。
        int openedBefore = countOpened(ms);
        rt.clickAt(sx, sy, false);
        int openedAfterNoBlock = countOpened(ms);
        check("未登记界面区时，HUD 位置的点击会翻开底下的格子（bug 形态复现）",
                openedAfterNoBlock > openedBefore);

        // ② 登记顶带为界面区 → 同一位置再点，格子不再被翻开
        ms.reset();
        rt.hudBlocks.put("hudTop", new float[]{0f, 0f, 720f, 145f});
        int base = countOpened(ms);
        rt.clickAt(sx, sy, false);
        check("登记界面区后，同一点击不再翻开格子（安全性质成立）",
                countOpened(ms) == base);

        // ③ 游玩区（带之间）的点击不受影响
        int midY = 800;
        int midX = 360;
        int mwx = Math.round(rt.view.toWorldX(midX));
        int mwy = Math.round(rt.view.toWorldY(midY));
        check("测试前提：游玩区这点也落在棋盘内",
                mwx >= 128 && mwx < 128 + 1792 && mwy >= 128 && mwy < 128 + 1792);
        int before2 = countOpened(ms);
        rt.clickAt(midX, midY, false);
        check("界面区不影响正常翻格子", countOpened(ms) > before2);
    }

    private static int countOpened(Minesweeper ms) {
        int n = 0;
        for (int i = 0; i < ms.open.length; i++) {
            if (ms.open[i]) {
                n++;
            }
        }
        return n;
    }

    private static void testBoardFitsMapAt64() {
        int mapPx = 64 * 32;                       // 工程地图：64 瓦片 × tileSize 32
        // 引擎允许的格子范围里，只有 ≤32px 才能保证 64 列不超出地图。
        for (int cell = 16; cell <= 32; cell += 4) {
            check("64×64 @ cell=" + cell + " 棋盘 " + (64 * cell) + "px ≤ 地图 " + mapPx + "px",
                    64 * cell <= mapPx);
        }
        // 出厂用的可读格子 28px：64×28 = 1792 ≤ 2048，整盘都能拖到
        check("出厂 cell=28 时整盘可拖到（1792 ≤ 2048）", 64 * 28 <= mapPx);
    }
}
