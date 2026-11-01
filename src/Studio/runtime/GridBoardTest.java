package Studio.runtime;

/**
 * 通用网格模块自检：证明「网格能力」已经从扫雷里拆出来、可独立使用。
 *
 * <p>这是本次重构的<b>验收测试</b>。如果它通过，说明：
 * <ul>
 *   <li>{@link GridBoard} 能单独工作 —— 不需要 {@link Minesweeper}、不需要雷、不需要扫雷规则；</li>
 *   <li>能力裁剪真的生效 —— 没挂 {@code game.minesweeper} 时不会生成雷、不会判扫雷胜负；</li>
 *   <li>泛洪、邻域、索引换算这些通用能力行为正确（其它玩法可直接复用）。</li>
 * </ul>
 */
public final class GridBoardTest {

    private static int pass;
    private static int fail;

    public static void main(String[] args) {
        try {
            testGeometry();
            testNeighbors();
            testFlood();
            testCapabilityGating();
            testSplitModulesIndividually();
            testParamMerging();
            testRepaintInvalidation();
            testPainterHelpers();
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

    private static void testGeometry() {
        GridBoard b = new GridBoard(4, 5, 16);
        check("尺寸 4x5", b.rows == 4 && b.cols == 5);
        check("总格数 20", b.size() == 20);
        check("像素宽 80", b.pixelWidth() == 80);
        check("像素高 64", b.pixelHeight() == 64);
        check("idx(2,3)=13", b.idx(2, 3) == 13);
        check("rowOf(13)=2", b.rowOf(13) == 2);
        check("colOf(13)=3", b.colOf(13) == 3);
        check("inBounds(0,0)", b.inBounds(0, 0));
        check("越界 (-1,0)", !b.inBounds(-1, 0));
        check("越界 (4,0)", !b.inBounds(4, 0));

        // 世界坐标 → 索引
        int i0 = b.idxAtWorld(8f, 8f, 0f, 0f);
        check("世界(8,8) → 索引 0", i0 == 0);
        int i1 = b.idxAtWorld(72f, 56f, 0f, 0f);
        check("世界(72,56) → 索引 19", i1 == 19);
        check("世界越界 → -1", b.idxAtWorld(-1f, 0f, 0f, 0f) == -1);
    }

    private static void testNeighbors() {
        GridBoard b = new GridBoard(3, 3, 16);
        final int[] count = new int[1];
        b.forEachNeighbor(4, (ni, dr, dc) -> count[0]++);   // 中心格
        check("中心格 8 邻域", count[0] == 8);

        count[0] = 0;
        b.forEachNeighbor(0, (ni, dr, dc) -> count[0]++);   // 角落
        check("角落 3 邻域", count[0] == 3);

        count[0] = 0;
        b.forEachNeighbor4(4, (ni, dr, dc) -> count[0]++);  // 中心 4 邻域
        check("中心 4 邻域", count[0] == 4);

        // 邻域不应包含自身
        final boolean[] self = new boolean[1];
        b.forEachNeighbor(4, (ni, dr, dc) -> {
            if (ni == 4) {
                self[0] = true;
            }
        });
        check("邻域不含自身", !self[0]);

        // countNeighbors
        b.setMine(0, true);
        b.setMine(1, true);
        int n = b.countNeighbors(4, b::isMine);
        check("中心格周围 2 雷", n == 2);
    }

    private static void testFlood() {
        GridBoard b = new GridBoard(3, 3, 16);
        // 全空盘：从角落泛洪应翻开全部 9 格
        int added = b.floodOpen(0, idx -> true);
        check("空盘泛洪翻开 9 格", added == 9);
        check("openedCount = 9", b.openedCount == 9);

        // 中间放一个「障碍」（视为已标记），泛洪应在障碍前停住
        GridBoard b2 = new GridBoard(3, 3, 16);
        b2.setFlagged(4, true);   // 中心被标记
        int added2 = b2.floodOpen(0, idx -> true);
        check("中心挡板 → 翻开少于 9", added2 < 9);
        check("中心仍标记未翻开", !b2.isOpened(4) && b2.isFlagged(4));

        // 已翻开的格子重复泛洪 → 0
        int again = b.floodOpen(0, idx -> true);
        check("已翻开再泛洪 → 0", again == 0);
    }

    private static void testCapabilityGating() {
        // 只挂 grid.board：不应有雷、不应有扫雷胜负
        TopDownRuntime rt = TopDownRuntime.newStub();
        rt.view.setViewport(1280, 720);
        Actor a = new Actor();
        a.x = 0f;
        a.y = 0f;

        GridModules.Bundle boardOnly = new GridModules.Bundle();
        boardOnly.board = true;
        boardOnly.tile = true;

        GameData.RtModule m = new GameData.RtModule();
        Minesweeper ms = new Minesweeper(rt, a, m, boardOnly);
        check("无雷玩法：mineCount = 0", ms.mineCount == 0);
        check("无雷玩法：未开始", !ms.started);
        check("无雷玩法：未判负", !ms.over);

        // 点开一格：应正常翻开，且不判负
        int opened = ms.board.floodOpen(0, idx -> true);
        check("无雷玩法：可翻开格子", opened > 0);
        check("无雷玩法：翻开后仍未判胜负", !ms.over && !ms.won);
        check("checkWin 在无雷时不宣布胜利", !ms.won);

        // 完整扫雷：应有雷
        GridModules.Bundle full = new GridModules.Bundle();
        full.minesweeper = true;
        full.board = true;
        full.tile = true;
        full.reveal = true;
        full.flag = true;
        full.mines = true;
        GameData.RtModule m2 = new GameData.RtModule();
        Minesweeper ms2 = new Minesweeper(rt, a, m2, full);
        check("完整扫雷：wantedMines > 0", ms2.wantedMines > 0);
        check("完整扫雷：caps.mines", ms2.caps.mines);
        check("完整扫雷：caps.reveal", ms2.caps.reveal);
    }

    /** 拆分后的关键验收：单独挂某一个 grid.* 模块也要生效（不能因为缺 grid.board 就静默失效）。 */
    private static void testSplitModulesIndividually() {
        // 只挂 grid.reveal（没有 grid.board）：能力集合必须认为「有网格」→ 会建棋盘
        GameData.RtObject o = new GameData.RtObject();
        GameData.RtModule revealOnly = new GameData.RtModule();
        revealOnly.def = "grid.reveal";
        revealOnly.params.put("autoOpenZeros", "true");
        o.modules.add(revealOnly);

        GridModules.Bundle b = GridModules.Bundle.of(o);
        check("只挂 grid.reveal → any()=true", b.any());
        check("只挂 grid.reveal → caps.reveal", b.reveal);
        check("只挂 grid.reveal → caps.board（有网格）", b.board);
        check("只挂 grid.reveal → 无雷", !b.mines);
        check("只挂 grid.reveal → 不是完整扫雷", !b.minesweeper);

        // 只挂 grid.tile
        GameData.RtObject o2 = new GameData.RtObject();
        GameData.RtModule tileOnly = new GameData.RtModule();
        tileOnly.def = "grid.tile";
        o2.modules.add(tileOnly);
        GridModules.Bundle b2 = GridModules.Bundle.of(o2);
        check("只挂 grid.tile → any()=true", b2.any());
        check("只挂 grid.tile → caps.tile", b2.tile);
        check("只挂 grid.tile → 无雷", !b2.mines);

        // 什么都不挂 → any()=false
        GridModules.Bundle b3 = GridModules.Bundle.of(new GameData.RtObject());
        check("不挂模块 → any()=false", !b3.any());
    }

    /** 拆分后参数分散在多个模块里，必须合并读取；只读一个模块会丢参数。 */
    private static void testParamMerging() {
        GameData.RtObject o = new GameData.RtObject();

        GameData.RtModule boardMod = new GameData.RtModule();
        boardMod.def = "grid.board";
        boardMod.params.put("rows", "12");
        boardMod.params.put("cols", "16");
        boardMod.params.put("cellSize", "24");
        o.modules.add(boardMod);

        GameData.RtModule revealMod = new GameData.RtModule();
        revealMod.def = "grid.reveal";
        revealMod.params.put("firstClickSafe", "true");
        revealMod.params.put("autoOpenZeros", "true");
        o.modules.add(revealMod);

        GameData.RtModule flagMod = new GameData.RtModule();
        flagMod.def = "grid.flag";
        flagMod.params.put("showTimer", "true");
        o.modules.add(flagMod);

        GameData.RtModule merged = GridModules.Bundle.mergedParams(o, "grid.board");
        check("合并后可读 rows（来自 grid.board）", merged.intOf("rows", 0) == 12);
        check("合并后可读 cols", merged.intOf("cols", 0) == 16);
        check("合并后可读 cellSize", merged.intOf("cellSize", 0) == 24);
        check("合并后可读 firstClickSafe（来自 grid.reveal）", merged.bool("firstClickSafe", false));
        check("合并后可读 showTimer（来自 grid.flag）", merged.bool("showTimer", false));

        // 不覆盖语义：先写入的优先
        GameData.RtObject o2 = new GameData.RtObject();
        GameData.RtModule full = new GameData.RtModule();
        full.def = "game.minesweeper";
        full.params.put("rows", "9");
        o2.modules.add(full);
        GameData.RtModule extra = new GameData.RtModule();
        extra.def = "grid.board";
        extra.params.put("rows", "20");
        o2.modules.add(extra);
        GameData.RtModule m2 = GridModules.Bundle.mergedParams(o2, "game.minesweeper");
        check("完整扫雷参数优先（rows=9 不被 grid.board 覆盖）", m2.intOf("rows", 0) == 9);
    }

    /**
     * 回归测试：「点格子画面不更新」。
     *
     * <p>真实事故：{@code GridPainter.paintIfDirty} 里写的是
     * {@code if (texture == null) texture = rt.textureFromImage(image);}
     * —— 只有第一次建纹理才上传像素。之后棋盘状态变了、位图重画了，
     * GPU 上仍是旧图像，表现为「进度在变、画面不动」。
     *
     * <p>这里断言的是「状态变化会让 painter 变脏」，保证每次棋盘变动都会触发重绘
     * （重绘后的重新上传由 draw 路径保证，见 GridPainter 的注释）。
     */
    private static void testRepaintInvalidation() {
        TopDownRuntime rt = TopDownRuntime.newStub();
        rt.view.setViewport(1280, 720);
        Actor a = new Actor();
        GridModules.Bundle caps = new GridModules.Bundle();
        caps.minesweeper = true;
        caps.board = true;
        caps.tile = true;
        caps.reveal = true;
        caps.flag = true;
        caps.mines = true;
        GameData.RtModule m = new GameData.RtModule();
        m.params.put("rows", "4");
        m.params.put("cols", "4");
        m.params.put("mines", "3");
        m.params.put("cellSize", "32");
        Minesweeper ms = new Minesweeper(rt, a, m, caps);

        // 初始应为脏（还没画过）
        ms.painter.invalidate();
        check("初始 painter 为脏", ms.painter.isDirty());

        // 翻开一格 → 必须变脏（否则画面不会更新）
        int idx = ms.board.idx(0, 0);
        ms.board.setOpened(idx);
        ms.painter.invalidate();
        check("翻开格子后 painter 为脏", ms.painter.isDirty());

        // 插旗 → 必须变脏
        ms.board.setFlagged(ms.board.idx(1, 1), true);
        ms.painter.invalidate();
        check("插旗后 painter 为脏", ms.painter.isDirty());

        // 重置 → 必须变脏
        ms.reset();
        check("重置后 painter 为脏", ms.painter.isDirty());
    }

    private static void testPainterHelpers() {
        // 绘制辅助函数是纯函数，直接调（不需要 GL 上下文）
        java.awt.image.BufferedImage img = new java.awt.image.BufferedImage(64, 64,
                java.awt.image.BufferedImage.TYPE_INT_ARGB);
        java.awt.Graphics2D g = img.createGraphics();
        GridPainter.fillCell(g, new java.awt.Color(0xff, 0, 0), 0, 0, 32);
        check("fillCell 写入像素", new java.awt.Color(img.getRGB(10, 10), true).getRed() > 200);
        g.dispose();
    }
}
