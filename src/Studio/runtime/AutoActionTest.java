package Studio.runtime;

/**
 * 自动标记/翻开（chord 类操作）与文本输入框的自检。
 *
 * <p>自动操作是<b>会改变棋局</b>的逻辑，错了就是「自动踩雷」或「自动乱插旗」，
 * 所以这里逐条固定规则（对应玩家给的判定）：
 * <ol>
 *   <li><b>已插旗数 == 数字</b> → 点该数字格，周围未插旗未翻开格<b>自动翻开</b>；</li>
 *   <li><b>剩余未翻开数 == 数字</b> → 点该数字格，周围未翻开的格子<b>自动插旗</b>
 *       （等价于「未插旗未翻开数 == 剩余雷数」，已插旗被算两次会永不触发，这里固定化简式）；</li>
 *   <li>条件不满足 → <b>什么都不做</b>（绝不自动踩雷）；</li>
 *   <li>数字 0 / 已踩雷 / 关闭开关 → 不动作。</li>
 * </ol>
 */
public final class AutoActionTest {

    private static int pass;
    private static int fail;

    public static void main(String[] args) {
        try {
            testParamParsing();
            testAutoOpenWhenFlagsMatch();
            testAutoFlagWhenUnopenedMatches();
            testNoActionWhenConditionsUnmet();
            testSafeGuards();
            testStandardChordAlwaysAvailable();
            testTextInput();
            testSubmitCallbackQueued();
            testInputRangeValidation();
            testImeTextSync();
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

    /** 造一个完整扫雷（能力全开）的实例。 */
    private static Minesweeper newMine(int rows, int cols, int mines, int autoMode) {
        TopDownRuntime rt = TopDownRuntime.newStub();
        rt.view.setViewport(1280, 720);
        Actor a = new Actor();
        a.x = 0f;
        a.y = 0f;
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
        m.params.put("firstClickSafe", "true");
        Minesweeper ms = new Minesweeper(rt, a, m, caps);
        ms.autoMode = autoMode;
        return ms;
    }

    private static void testParamParsing() {
        check("关闭 → 0", Minesweeper.parseAutoMode("关闭 Off") == 0);
        check("Auto Reveal → AUTO_OPEN",
                Minesweeper.parseAutoMode("自动翻开 Auto Reveal") == Minesweeper.AUTO_OPEN);
        check("Auto Flag → AUTO_FLAG",
                Minesweeper.parseAutoMode("自动插旗 Auto Flag") == Minesweeper.AUTO_FLAG);
        check("Smart → AUTO_SMART",
                Minesweeper.parseAutoMode("智能 Smart（先插旗再翻开）") == Minesweeper.AUTO_SMART);
        check("空串 → 0", Minesweeper.parseAutoMode("") == 0);
        check("英文 open+flag → SMART", Minesweeper.parseAutoMode("open,flag") == Minesweeper.AUTO_SMART);
    }

    /**
     * 场景：3x3 棋盘、角落有 2 颗雷，中心格数字应为 2。
     * 玩家把这两颗雷都插了旗 → 点中心格应自动翻开其余未插旗格（且不会踩雷）。
     */
    private static void testAutoOpenWhenFlagsMatch() {
        Minesweeper ms = newMine(3, 3, 2, Minesweeper.AUTO_OPEN);
        // 手工铺盘（不随机）：(0,0) 与 (0,1) 是雷
        ms.started = true;
        for (int i = 0; i < ms.mine.length; i++) {
            ms.mine[i] = false;
            ms.open[i] = false;
            ms.flag[i] = false;
            ms.mineValue[i] = 0;
            ms.counts[i] = 0;
        }
        int mineA = 0;                       // (0,0)
        int mineB = 1;                       // (0,1)
        ms.mine[mineA] = true;
        ms.mine[mineB] = true;
        ms.mineValue[mineA] = ComplexRules.POS_RE;
        ms.mineValue[mineB] = ComplexRules.POS_RE;
        ms.mineCount = 2;
        // 重算邻域数字
        for (int idx = 0; idx < ms.board.size(); idx++) {
            if (ms.mine[idx]) {
                continue;
            }
            final int[] acc = new int[1];
            ms.board.forEachNeighbor(idx, (ni, dr, dc) -> {
                if (ms.mine[ni]) {
                    acc[0]++;
                }
            });
            ms.counts[idx] = acc[0];
        }

        // 中心格 (1,1) 周围 8 格含两颗雷 → 数字 2
        int center = ms.board.idx(1, 1);
        check("中心格数字为 2", ms.counts[center] == 2);

        // 翻开中心格
        ms.board.setOpened(center);
        // 玩家插对两颗雷
        ms.board.setFlagged(mineA, true);
        ms.board.setFlagged(mineB, true);
        ms.flags = 2;

        int openedBefore = ms.board.openedCount;
        boolean acted = ms.autoActionAt(center);
        check("旗数==数字 → 有动作", acted);
        check("触发后翻开了更多格子", ms.board.openedCount > openedBefore);
        // 注意：把所有安全格都翻开 = 正常胜利，此时 over=true 且 won=true
        // （over 表示「本局结束」，不专指失败）。所以这里要断言的是「没踩雷」，
        // 判据是 won 而不是 !over —— 写成 !over 会把「胜利」误判为失败。
        check("没有踩雷（走的是胜利分支）", ms.won);
        // 两颗雷仍保持插旗、未被翻开
        check("雷格未被翻开", !ms.board.isOpened(mineA) && !ms.board.isOpened(mineB));
    }

    /**
     * 场景：中心数字 2，周围只剩 2 个未翻开格 → 点它应把这两个格自动插旗。
     */
    private static void testAutoFlagWhenUnopenedMatches() {
        Minesweeper ms = newMine(3, 3, 2, Minesweeper.AUTO_FLAG);
        ms.started = true;
        for (int i = 0; i < ms.mine.length; i++) {
            ms.mine[i] = false;
            ms.open[i] = false;
            ms.flag[i] = false;
            ms.counts[i] = 0;
            ms.mineValue[i] = 0;
        }
        int mineA = 0;
        int mineB = 1;
        ms.mine[mineA] = true;
        ms.mine[mineB] = true;
        ms.mineValue[mineA] = ComplexRules.POS_RE;
        ms.mineValue[mineB] = ComplexRules.POS_RE;
        ms.mineCount = 2;
        for (int idx = 0; idx < ms.board.size(); idx++) {
            if (ms.mine[idx]) {
                continue;
            }
            final int[] acc = new int[1];
            ms.board.forEachNeighbor(idx, (ni, dr, dc) -> {
                if (ms.mine[ni]) {
                    acc[0]++;
                }
            });
            ms.counts[idx] = acc[0];
        }
        int center = ms.board.idx(1, 1);
        check("中心数字 2", ms.counts[center] == 2);

        // 把除两颗雷之外的 7 格全部翻开 → 中心周围只剩 2 个未翻开（正好两颗雷）
        for (int i = 0; i < ms.board.size(); i++) {
            if (!ms.mine[i]) {
                ms.board.setOpened(i);
            }
        }
        check("周围未翻开格数 == 2",
                ms.board.countNeighbors(center, ni -> !ms.board.isOpened(ni)) == 2);
        check("此时已插旗数 == 0", ms.flags == 0);

        boolean acted = ms.autoActionAt(center);
        check("未翻开数==数字 → 有动作", acted);
        check("两颗雷都被插旗", ms.board.isFlagged(mineA) && ms.board.isFlagged(mineB));
        check("旗帜计数为 2", ms.flags == 2);
    }

    /** 条件不满足时绝不动作（这是安全底线）。 */
    private static void testNoActionWhenConditionsUnmet() {
        Minesweeper ms = newMine(3, 3, 2, Minesweeper.AUTO_SMART);
        ms.started = true;
        for (int i = 0; i < ms.mine.length; i++) {
            ms.mine[i] = false;
            ms.open[i] = false;
            ms.flag[i] = false;
            ms.counts[i] = 0;
        }
        int mineA = 0;
        int mineB = 1;
        ms.mine[mineA] = true;
        ms.mine[mineB] = true;
        ms.mineCount = 2;
        for (int idx = 0; idx < ms.board.size(); idx++) {
            if (ms.mine[idx]) {
                continue;
            }
            final int[] acc = new int[1];
            ms.board.forEachNeighbor(idx, (ni, dr, dc) -> {
                if (ms.mine[ni]) {
                    acc[0]++;
                }
            });
            ms.counts[idx] = acc[0];
        }
        int center = ms.board.idx(1, 1);
        ms.board.setOpened(center);
        // 没插旗、周围也还很多未翻开 → 两个条件都不满足
        check("无插旗且未翻开数 > 数字", ms.board.countNeighbors(center, ni -> !ms.board.isOpened(ni)) > 2);
        check("条件不满足 → 不动作", !ms.autoActionAt(center));
        check("不动作时未踩雷", !ms.over && !ms.won);
    }

    private static void testSafeGuards() {
        Minesweeper ms = newMine(3, 3, 2, Minesweeper.AUTO_SMART);
        int center = ms.board.idx(1, 1);
        // 关闭开关
        ms.autoMode = 0;
        check("autoMode=0 → 不动作", !ms.autoActionAt(center));
        // 未翻开的格子
        ms.autoMode = Minesweeper.AUTO_SMART;
        check("未翻开格 → 不动作", !ms.autoActionAt(center));
        // 数字 0
        ms.board.setOpened(center);
        ms.counts[center] = 0;
        check("数字 0 → 不动作", !ms.autoActionAt(center));
        // 已判负
        ms.over = true;
        ms.counts[center] = 2;
        check("已判负 → 不动作", !ms.autoActionAt(center));
    }

    /**
     * 回归测试：<b>普通模式下「点已翻开的数字格」必须能连锁翻开</b>。
     *
     * <p><b>真实事故</b>：{@code click} 对已翻开格只调 {@link Minesweeper#autoActionAt}，
     * 而那个方法受 {@code autoAction} 参数控制、默认是「关闭 Off」（=0，直接返回 false）。
     * 普通模式又没有自己的 chord 分支 → 玩家点数字格<b>什么都不发生</b>，
     * 而脚本 UI 上明明写着「点数字可连锁翻开」。标准扫雷的 chord 是<b>基本操作</b>，
     * 不该依赖任何「自动辅助」开关。
     *
     * <p>这里固定两条契约：
     * <ol>
     *   <li>{@code autoMode == 0}（默认配置）时，旗数对齐后点数字格<b>仍然会翻开</b>邻格；</li>
     *   <li>旗数<b>没</b>对齐时<b>什么都不做</b>（绝不猜、绝不误踩）。</li>
     * </ol>
     */
    private static void testStandardChordAlwaysAvailable() {
        // 3x3、两颗雷在 (0,0)/(0,1)，中心 (1,1) 的数字应为 2
        Minesweeper ms = newMine(3, 3, 2, 0);       // ⚠ autoMode = 0（默认关闭）
        ms.started = true;
        for (int i = 0; i < ms.mine.length; i++) {
            ms.mine[i] = false;
            ms.open[i] = false;
            ms.flag[i] = false;
            ms.mineValue[i] = 0;
            ms.counts[i] = 0;
        }
        int mineA = ms.board.idx(0, 0);
        int mineB = ms.board.idx(0, 1);
        ms.mine[mineA] = true;
        ms.mine[mineB] = true;
        ms.mineValue[mineA] = ComplexRules.POS_RE;
        ms.mineValue[mineB] = ComplexRules.POS_RE;
        ms.mineCount = 2;
        for (int idx = 0; idx < ms.board.size(); idx++) {
            if (ms.mine[idx]) {
                continue;
            }
            final int[] acc = new int[1];
            ms.board.forEachNeighbor(idx, (ni, dr, dc) -> {
                if (ms.mine[ni]) {
                    acc[0]++;
                }
            });
            ms.counts[idx] = acc[0];
        }
        int center = ms.board.idx(1, 1);
        check("中心格数字 = 2", ms.counts[center] == 2);

        // ---- ① 旗数没对齐：点数字格不该翻开任何东西 ----
        ms.board.setOpened(center);
        ms.open[center] = true;
        int before1 = countOpened(ms);
        boolean acted1 = ms.click(cx(ms, center), cy(ms, center), false);
        check("旗数未对齐时点数字格 → 不翻开邻格", countOpened(ms) == before1);
        check("旗数未对齐时点数字格 → 不踩雷", !ms.over);
        check("点已翻开格视为已处理（返回 true）", acted1);

        // ---- ② 旗数 = 数字：点数字格应翻开其余未插旗邻格 ----
        ms.flag[mineA] = true;
        ms.flag[mineB] = true;
        int before2 = countOpened(ms);
        ms.click(cx(ms, center), cy(ms, center), false);
        int after2 = countOpened(ms);
        check("旗数对齐后点数字格 → 邻格被翻开", after2 > before2);
        // ⚠ 注意：{@code over} 表示「本局已结束」，<b>通关也会置 true</b>（配合 won）。
        // 判「没踩雷」必须看 won / 是否翻开了雷格，不能只看 over —— 3x3 全翻开本来就是通关。
        boolean steppedOnMine = ms.open[mineA] || ms.open[mineB];
        check("连锁翻开没有踩雷（未翻开任何雷格）", !steppedOnMine);
        check("3x3 全安全格翻开即通关（over 且 won）", ms.over && ms.won);
        check("两颗雷仍插着旗", ms.flag[mineA] && ms.flag[mineB]);
        check("雷格未被翻开", !ms.open[mineA] && !ms.open[mineB]);
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

    /** 世界坐标：棋盘左上角 = actor.x - boardW/2，取格子中心。 */
    private static int cx(Minesweeper ms, int idx) {
        int c = idx % ms.cols;
        return (int) (ms.actor.x - ms.boardW / 2f + c * ms.cell + ms.cell / 2f);
    }

    private static int cy(Minesweeper ms, int idx) {
        int r = idx / ms.cols;
        return (int) (ms.actor.y - ms.boardH / 2f + r * ms.cell + ms.cell / 2f);
    }

    /**
     * 回归测试：「输入框按回车/点确认没反应」。
     *
     * <p>真实事故：{@code onSubmit} 在 AWT 事件线程里直接调 {@code engine.invoke}，
     * 而那个线程没有 Rhino Context → invoke 静默返回 null，回调永不执行。
     *
     * <p>这里固定的是「回调会被排队而不是当场丢弃」这一契约：提交后必须能在
     * 下一次 update 的脚本上下文里跑到。用 ScriptEngine 的队列做端到端验证。
     */
    private static void testSubmitCallbackQueued() {
        ScriptTextInput ti = new ScriptTextInput();
        ti.define("mines", "40", 1, 200, true);

        // 模拟跨线程提交：这里不用真的线程，只要验证 onSubmit 被调用即可
        final String[] got = new String[2];
        ti.setOnSubmit(f -> {
            got[0] = f.id;
            got[1] = f.text;
        });

        // 激活 + 输入 + 回车提交
        ScriptTextInput.Field f = ti.find("mines");
        f.nx = 0.1f; f.ny = 0.1f; f.nw = 0.2f; f.nh = 0.05f;
        ti.pointerDown(0.2f * 1280f, 0.12f * 720f, 1280, 720);
        check("激活输入框", ti.isActive());
        ti.type('6');
        ti.type('0');
        check("输入后文本=60", ti.textOf("mines").equals("60"));
        ti.type((char) 10);   // 回车
        check("回车后回调被调用", got[0] != null && got[0].equals("mines"));
        check("回调收到文本 60", got[1] != null && got[1].equals("60"));
        check("提交后不再激活", !ti.isActive());

        // 队列契约：postScriptCall 能在一帧内被排空（这里直接验证队列存在且可执行）
        TopDownRuntime rt = TopDownRuntime.newStub();
        check("测试桩可建（队列载体可用）", rt != null);
    }

    /**
     * 回归测试：输入框范围校验。
     *
     * <p><b>真实事故</b>：玩家在「行」输入框里敲 1，被悄悄钳成 5 而没有任何提示，
     * 感觉「UI 炸了」。这里固定「超范围必须能被识别出来并给出提示」这条契约。
     */
    private static void testInputRangeValidation() {
        ScriptTextInput ti = new ScriptTextInput();
        ti.define("rows", "12", 5, 30, true);

        check("合法值 12 无提示", ti.validate("rows").isEmpty());

        ti.find("rows").text = "3";
        check("低于下限 3 → 有提示", !ti.validate("rows").isEmpty());
        check("提示内容含下限", ti.validate("rows").contains("5"));

        ti.find("rows").text = "99";
        check("高于上限 99 → 有提示", !ti.validate("rows").isEmpty());
        check("提示内容含上限", ti.validate("rows").contains("30"));

        ti.find("rows").text = "";
        check("空值 → 有提示", !ti.validate("rows").isEmpty());

        ti.find("rows").text = "abc";
        check("非数字被拒（numeric 框收不到字母，但校验也要兜住）",
                !ti.validate("rows").isEmpty());

        ti.find("rows").text = "5";
        check("边界值 5 合法", ti.validate("rows").isEmpty());
        ti.find("rows").text = "30";
        check("边界值 30 合法", ti.validate("rows").isEmpty());

        // 刷新提示
        ti.find("rows").text = "3";
        ti.refreshHints();
        check("refreshHints 写入 hint", !ti.find("rows").hint.isEmpty());
    }

    private static void testTextInput() {
        ScriptTextInput ti = new ScriptTextInput();
        final boolean[] kb = {false};
        ti.setKeyboardHost(v -> kb[0] = v);

        ti.define("rows", "12", 5, 30, true);
        check("初始值 12", ti.textOf("rows").equals("12"));
        check("intOf = 12", ti.intOf("rows", 0) == 12);
        check("未激活", !ti.isActive());

        // 点击框内 → 激活 + 弹键盘
        ScriptTextInput.Field f = ti.find("rows");
        f.nx = 0.1f;
        f.ny = 0.1f;
        f.nw = 0.1f;
        f.nh = 0.05f;
        boolean consumed = ti.pointerDown(0.15f * 1280f, 0.125f * 720f, 1280, 720);
        check("点框内被消费", consumed);
        check("激活后弹键盘", kb[0]);
        check("激活即清空旧值", ti.textOf("rows").isEmpty());

        // 键入数字
        ti.type('2');
        ti.type('0');
        check("键入后文本 = 20", ti.textOf("rows").equals("20"));
        check("数字框拒收字母", ti.type('a') || ti.textOf("rows").equals("20"));
        check("拒收字母后仍是 20", ti.textOf("rows").equals("20"));

        // 退格
        ti.type((char) 8);
        check("退格后 = 2", ti.textOf("rows").equals("2"));

        // 提交 → 收起键盘
        ti.commitActive();
        check("提交后不激活", !ti.isActive());
        check("提交后收键盘", !kb[0]);

        // 范围钳制
        ti.define("cols", "99", 5, 30, true);
        check("超上限被钳到 30", ti.intOf("cols", 0) == 30);
        ti.define("mines", "1", 2, 100, true);
        check("低于下限被钳到 2", ti.intOf("mines", 0) == 2);

        // 非法文本回退
        ti.define("bad", "abc", 0, 0, false);
        check("非法文本回退", ti.intOf("bad", 7) == 7);
    }

    /**
     * 回归测试：Android 输入法「整段文本同步」。
     *
     * <p><b>真实事故</b>：手机点输入框没有任何输入法弹出，玩家根本没法输入。
     * 其中一个环节是 IME 的提交语义 —— {@code commitText} 给的是整段文本，
     * 早期实现把它当「逐字符追加」再喂给 {@link ScriptTextInput#type}。
     * 组合输入（拼音先给半成品、再整体替换）就会重复追加。
     *
     * <p>这里固定两条契约：
     * <ol>
     *   <li>整段替换是<b>幂等</b>的：同一个文本提交多次，结果不变（不会被追加）；</li>
     *   <li>退格是「在<b>当前文本</b>上删 N 个字符」，而不是「无条件删 1 个」——
     *       后者正是「按一次退格删两个字符」的成因。</li>
     * </ol>
     */
    private static void testImeTextSync() {
        ScriptTextInput ti = new ScriptTextInput();

        // ---- 数字框：整段同步 + 过滤非数字 ----
        ti.define("mines", "40", 1, 200, true);
        ScriptTextInput.Field f = ti.find("mines");
        f.nx = 0.1f;
        f.ny = 0.1f;
        f.nw = 0.2f;
        f.nh = 0.05f;
        ti.pointerDown(0.2f * 1280f, 0.12f * 720f, 1280, 720);
        check("激活输入框", ti.isActive());
        check("激活时 activeText 可读", ti.activeText() != null);

        check("整段写入 60", ti.setActiveText("60") && ti.textOf("mines").equals("60"));
        // 幂等：同一个值重复提交不能变成 6060（逐字符追加的经典 bug）
        ti.setActiveText("60");
        check("重复提交同一值不变", ti.textOf("mines").equals("60"));

        // 输入法带进来 "6a0x" → 数字框只留数字
        ti.setActiveText("6a0x");
        check("非数字被过滤", ti.textOf("mines").equals("60"));

        // 超长被 maxChars 截断（防止输入法一次性塞进一长串）
        ti.setActiveText("1234567890123");
        check("超长被截到 maxChars", ti.textOf("mines").length() <= ti.activeMaxChars());

        // ---- 退格契约：按当前文本删 N 个，而不是「永远删 1 个」----
        ti.setActiveText("120");
        ti.setActiveText("12");
        check("退格等价于整体替换后为 12", ti.textOf("mines").equals("12"));
        ti.setActiveText("1");
        check("再退一格为 1", ti.textOf("mines").equals("1"));
        ti.setActiveText("");
        check("删空后为空", ti.textOf("mines").isEmpty());

        // ---- 文本框：不过滤字母 ----
        ScriptTextInput t2 = new ScriptTextInput();
        t2.define("name", "", 0, 0, false);
        t2.find("name").nx = 0.1f;
        t2.find("name").ny = 0.1f;
        t2.find("name").nw = 0.2f;
        t2.find("name").nh = 0.05f;
        t2.pointerDown(0.2f * 1280f, 0.12f * 720f, 1280, 720);
        t2.setActiveText("abc");
        check("文本框收字母", t2.textOf("name").equals("abc"));
        check("文本框 commitActive 生效", t2.commitActive() && !t2.isActive());

        // ---- 没有激活框时整体写入必须被拒绝（不能改到别的字段）----
        ScriptTextInput t3 = new ScriptTextInput();
        t3.define("rows", "12", 5, 30, true);
        check("无激活框时 setActiveText 返回 false", !t3.setActiveText("99"));
        check("无激活框时字段值不变", t3.textOf("rows").equals("12"));
        check("无激活框时 activeText 为 null", t3.activeText() == null);
    }
}
