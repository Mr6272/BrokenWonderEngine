package Studio.runtime;

import java.awt.Color;
import java.awt.BasicStroke;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.List;
import java.util.Random;

import javax.media.opengl.GL2;

/**
 * 扫雷玩法（棋盘状态机 + 自绘渲染）。
 *
 * <p><b>为什么从 {@code TopDownRuntime} 里拆出来</b>：原来它是一段 594 行的内部类，
 * 让宿主文件膨胀到 3900+ 行，也让「游戏玩法」和「引擎宿主」这两件不同的事混在一起。
 * 拆开之后：
 * <ul>
 *   <li>宿主只管窗口/主循环/调度，玩法文件独立演进；</li>
 *   <li>扫雷的通用部分（{@link GridBoard} 的格子状态机、{@link ComplexRules} 的规则）
 *       可以被其它格子类玩法直接复用，不必再复制一份；</li>
 *   <li>未来接入新玩法时，宿主只需实现一个 {@code GameMode} 接口。</li>
 * </ul>
 *
 * <p>对外契约保持不变：宿主仍通过 {@code click / update / status / draw} 驱动它，
 * {@code bwe.mine.*} 脚本 API 也照旧代理到这里，所以现有工程零迁移成本。
 */
final class Minesweeper {
    final TopDownRuntime rt;
    final Actor actor;

    /**
     * 由对象上挂的模块决定的能力集（{@code grid.board}/​{@code grid.tile}/
     * {@code grid.reveal}/{@code grid.flag}/{@code game.minesweeper}）。
     *
     * <p><b>为什么要有这个</b>：同一个棋盘类要同时服务「完整扫雷」和「只要一块网格」两种用法。
     * 没挂 {@code grid.reveal} 就不做首击安全/自动展开；没挂 {@code grid.flag} 就不响应插旗；
     * 没挂雷（{@code grid.mines}）就不生成地雷 —— 这样同一个 {@link GridBoard} 能被
     * 数织、围线、战棋等玩法直接复用，而不是被迫继承扫雷的全部规则。
     */
    final GridModules.Bundle caps;

    // ---- 绘制用颜色常量（避免每格 new Color） ----
    private static final Color C_HI = new Color(0xff, 0xff, 0xff);
    private static final Color C_LO = new Color(0x80, 0x80, 0x80);
    private static final Color C_MID = new Color(0xc0, 0xc0, 0xc0);
    private static final Color C_DARK = new Color(0x40, 0x40, 0x40);
    private static final Color C_OPEN_BG = new Color(0xe8, 0xec, 0xf5);
    private static final Color C_MINE_BODY = new Color(0x14, 0x18, 0x21);
    private static final Color C_FLAG_RED = new Color(0xf0, 0x52, 0x5f);
    private static final Color C_FLAG_POLE = new Color(0x30, 0x30, 0x30);

    int rows = 10;
    int cols = 10;
    int cell = 32;
    int wantedMines = 10;
    int mineCount;
    boolean firstClickSafe = true;
    boolean rightClickFlag = true;
    boolean autoOpenZeros = true;
    boolean revealAllOnLose = true;
    boolean showTimer = true;
    int seed;
    /** 诊断计数：前几次点击打印棋盘判定细节（定位「点击偏移」用）。 */

    /**
     * 通用棋盘内核（格子状态、邻域遍历、泛洪）。扫雷只是它的一个使用方。
     *
     * <p><b>不是 final</b>：{@link GridBoard} 的行/列/格子尺寸是 final 的（数组按尺寸一次性分配），
     * 所以改棋盘规格（脚本 {@code bwe.mine.set({rows/cols/cellSize})}、加减行列）时必须
     * 整个重建。<b>踩过的坑</b>：早先只在构造器里建一次，之后 {@code cell} 被改成 63、
     * 而 board 还按 32 算尺寸 → {@code boardW=512}（应为 1008），棋盘被画得过大且位置错。
     */
    GridBoard board;
    /** 通用格子绘制器（离屏位图 + 纹理缓存 + 脏标记）。 */
    GridPainter painter;

    /**
     * 以下三个数组是 {@link #board} 内部数组的<b>零拷贝别名</b>。
     *
     * <p>保留旧字段名是为了让「棋盘状态机」那部分代码（reveal/toggleFlag/chord
     * 里几十处 {@code open[i]}）不用大改；数据仍只有一份，不会出现状态不同步。
     */
    boolean[] mine;
    boolean[] open;
    boolean[] flag;
    int[] counts;
    /**
     * 每格雷的种类编码（{@link ComplexRules}：0 无雷 / 1 = +1 / 2 = −1 / 3 = +i / 4 = −i）。
     * 普通模式全部为 {@link ComplexRules#POS_RE}（= 1），所以 {@code sumIm} 恒 0、{@code sumRe == counts}。
     * {@code mine[]} 语义保持不变（是否有雷），两者是「有无」与「种类」的正交关系。
     */
    int[] mineValue;
    /** 8 邻域雷值的实部和；普通模式恒等于 {@code counts}。 */
    int[] sumRe;
    /** 8 邻域雷值的虚部和；普通模式恒为 0。 */
    int[] sumIm;
    /** 复雷加殊模式（默认 false = 普通模式，行为与今天逐字节一致）。 */
    boolean complexMode;

    /**
     * 自动机制：点「已翻开的数字格」时，按周围旗数自动做点什么。
     *
     * <p>三种模式（可叠加）：
     * <ul>
     *   <li>{@link #AUTO_OPEN}：旗数 == 数字 → 把周围未插旗、未翻开的格子<b>全部翻开</b>
     *       （传统 chord / 双击展开）；</li>
     *   <li>{@link #AUTO_FLAG}：未翻开数 == 数字（即剩下的必然全是雷）→ 把周围未翻开的
     *       格子<b>自动插旗</b>；</li>
     *   <li>{@link #AUTO_SMART}：两者都要 —— 能确定的全插旗，旗齐了就把其余自动翻开。</li>
     * </ul>
     *
     * <p><b>为什么安全</b>：两个条件都只基于「已翻开数字」与「玩家自己插的旗」推导，
     * 绝不读隐藏的雷数据做提示，所以不会替玩家作弊；条件不满足时<b>什么都不做</b>
     * （绝不踩雷）。这也让它能安全地默认开启。
     */
    static final int AUTO_OPEN = 1;
    static final int AUTO_FLAG = 2;
    static final int AUTO_SMART = AUTO_OPEN | AUTO_FLAG;

    /** 当前自动机制（0 = 关闭）。默认 0，由模块参数 {@code autoAction} 打开。 */
    int autoMode;
    int flags;
    boolean started;
    boolean over;
    boolean won;
    float elapsed;
    float timerAcc;

    String hiddenAsset = "";
    String mineAsset = "";
    String flagAsset = "";

    BufferedImage image;
    Texture texture;

    // ---- 素材图缓存：paintCell 会被每格调用（192 格 → 576 次查找），
    //      每格都走 imageForAssetName（assetByName 查表 + 路径判断）太浪费。
    //      只在第一次绘制时解析一次，之后直接复用。改动素材参数时 invalidateAssets()。
    private BufferedImage assetHidden;
    private BufferedImage assetMine;
    private BufferedImage assetFlag;
    private boolean assetsLoaded;
    int boardW;
    int boardH;

    /** 最近一次 click 的命中诊断（宿主日志用，纯记录，不影响玩法）。 */
    String lastClickInfo = "";

    Minesweeper(TopDownRuntime rt, Actor actor, GameData.RtModule m) {
        this(rt, actor, m, GridModules.Bundle.of(actor == null ? null : actor.o));
    }

    Minesweeper(TopDownRuntime rt, Actor actor, GameData.RtModule m, GridModules.Bundle caps) {
        this.rt = rt;
        this.actor = actor;
        this.caps = caps == null ? new GridModules.Bundle() : caps;
        rows = Math.max(3, Math.min(40, m.intOf("rows", 10)));
        cols = Math.max(3, Math.min(40, m.intOf("cols", 10)));
        cell = Math.max(16, Math.min(64, m.intOf("cellSize", 32)));
        // 参数按能力生效：没挂对应模块的能力保持关闭（或保持默认但不参与逻辑）。
        // 例如只挂 grid.board 时，wantedMines=0 → 不生成雷，棋盘就是一张空白网格。
        wantedMines = caps.mines ? Math.max(1, m.intOf("mines", 10)) : 0;
        firstClickSafe = caps.reveal && m.bool("firstClickSafe", true);
        rightClickFlag = caps.flag && m.bool("rightClickFlag", true);
        autoOpenZeros = caps.reveal && m.bool("autoOpenZeros", true);
        autoMode = caps.reveal ? parseAutoMode(m.str("autoAction", "关闭 Off")) : 0;
        revealAllOnLose = caps.reveal && m.bool("revealAllOnLose", true);
        showTimer = caps.flag && m.bool("showTimer", true);
        seed = m.intOf("seed", 0);
        // 模式：参数值含「复雷」或 Complex（忽略大小写）→ 复雷加殊；否则普通。
        // 解析口径与仓里其它 pick 参数一致（值里含关键字即命中）。
        String mode = m.str("mode", "普通 Normal");
        complexMode = mode.indexOf("复雷") >= 0 || mode.toLowerCase().indexOf("complex") >= 0;
        hiddenAsset = m.str("hiddenAsset", "");
        mineAsset = m.str("mineAsset", "");
        flagAsset = m.str("flagAsset", "");
        // 通用内核先建，reset() 里要用它的尺寸与数组
        this.board = new GridBoard(rows, cols, cell);
        this.painter = new GridPainter(rt, board);
        reset();
    }

    void reset() {
        int n = rows * cols;
        // 规格变了就重建内核：GridBoard 的行/列/cell 是 final，数组也按尺寸一次性分配，
        // 光 clear() 清标记改不了尺寸（否则 boardW/boardH 会停留在旧值）。
        if (board == null || board.rows != rows || board.cols != cols
                || board.cellSize != cell) {
            int oldCell = board == null ? 0 : board.cellSize;
            board = new GridBoard(rows, cols, cell);
            // ⚠ 只在「格子像素尺寸真的变了」才重建 painter。
            //
            // painter 持有的是一张 boardW×boardH 的离屏位图 + 一个 GL 纹理，
            // 重建它意味着下次必须整块重绘（192 格 × ~0.27ms ≈ 53ms/次）。
            // 行列数变化（12×16 → 10×8）只改变格子数量，格子像素尺寸没变时
            // 可以让旧 painter 继续用 —— **但必须把它的 board 引用换绑到新 board**。
            //
            // ⚠⚠ 「不重建 painter 却不换绑 board」是「改列数后整屏被灰色大块盖住」
            // 的真因：painter 仍按旧 board 的 pixelWidth()/pixelHeight() 建位图与贴图，
            // 而 Minesweeper.draw() 用新 board 的尺寸算位置 → 两者对不上，
            // 画出一块错位的纯色矩形盖住画面。换绑（rebind）就是为了消除这个错配。
            if (painter == null || oldCell != cell) {
                // 旧 painter 的纹理必须真正释放，否则每次改格子尺寸都泄漏一张 GPU 纹理。
                if (painter != null) {
                    painter.dispose();
                }
                painter = new GridPainter(rt, board);
            } else {
                painter.rebind(board);
            }
        } else {
            // 规格没变：只清状态，不重新分配数组
            board.clear();
        }
        // 零拷贝别名：后续状态机代码直接操作同一份数组
        mine = board.mine;
        open = board.opened;
        flag = board.flagged;
        counts = new int[n];
        mineValue = new int[n];
        sumRe = new int[n];
        sumIm = new int[n];
        flags = 0;
        started = false;
        over = false;
        won = false;
        elapsed = 0f;
        timerAcc = 0f;
        painter.invalidate();
        boardW = board.pixelWidth();
        boardH = board.pixelHeight();
        // ⚠ 棋盘对象的「实际渲染尺寸」必须跟着棋盘走（否则留下灰色大块）。
        //
        // 棋盘对象在场景里带着 {@code props.color="#909090"} 与<b>固定的</b>
        // {@code halfW/halfH}（工程里写死 448/320 = 896x640）。引擎判定渲染尺寸时
        // {@code halfW>0} 会<b>完全忽略</b> {@code props.w/h}（见 sizeOfCached 的 halfBranch），
        // 而脚本的 fitBoard 只改 props.w/h —— 于是行列一变，那块灰色底衬还是 896x640，
        // 与真实棋盘尺寸对不上，多出来的部分就是玩家看到的「灰色大方块」。
        //
        // 棋盘本身是由 Minesweeper.draw() 逐格画在纹理上的，不依赖这个对象的素材，
        // 所以同步 halfW/halfH 不会拉伸任何美术资源（脚本侧那条「绝不能 setSize」的
        // 警告针对的是挂了素材的对象，这里没有素材）。
        if (actor != null && actor.o != null) {
            actor.o.halfW = boardW / 2f;
            actor.o.halfH = boardH / 2f;
        }
        painter.invalidate();
        mineCount = Math.min(wantedMines, Math.max(1, n - 1));
    }

    void update(float dt) {
        if (started && !over) {
            timerAcc += dt;
            if (timerAcc >= 1f) {
                int s = (int) timerAcc;
                timerAcc -= s;
                elapsed += s;
                painter.invalidate();
            }
        }
    }

    String status() {
        String state;
        if (won) {
            state = "胜利";
        } else if (over) {
            state = "踩雷";
        } else if (started) {
            state = "进行中";
        } else {
            state = "点击开始";
        }
        String timer = showTimer ? " · " + (int) elapsed + "s" : "";
        // 复雷模式在末尾追加模式标记；普通模式**逐字节**保持今天的字符串（零回归的硬证据）。
        String mode = complexMode ? " · 复雷" : "";
        return "扫雷 " + state + " · " + flags + "/" + mineCount + timer + mode;
    }

    /**
     * 计算世界坐标落在哪个格子、以及该格当前状态（<b>纯诊断</b>，不改任何状态）。
     *
     * <p>插旗 / 翻格「没生效」时先看这里：是坐标算错（命中在棋盘外或别的格），
     * 还是命中正确但被规则挡掉（已翻开、已判负等）。
     */
    String describeHit(int wx, int wy) {
        float left = actor.x - boardW / 2f;
        float top = actor.y - boardH / 2f;
        if (wx < left || wy < top || wx >= left + boardW || wy >= top + boardH) {
            return "命中=棋盘外 棋盘世界矩形=[" + (int) left + "," + (int) top + " .. "
                    + (int) (left + boardW) + "," + (int) (top + boardH) + "]";
        }
        int c = (int) ((wx - left) / cell);
        int r = (int) ((wy - top) / cell);
        if (c < 0 || r < 0 || c >= cols || r >= rows) {
            return "命中=索引越界 r=" + r + " c=" + c;
        }
        int i = r * cols + c;
        return "命中=(" + r + "," + c + ") 数字=" + counts[i]
                + (mine[i] ? " 雷" : "") + (flag[i] ? " 已插旗" : "")
                + (open[i] ? " 已翻开" : " 未翻开")
                + (over ? " [over]" : "");
    }

    boolean click(int wx, int wy, boolean right) {
        lastClickInfo = describeHit(wx, wy) + " right=" + right;        if (over) {
            if (!right) {
                reset();
                return true;
            }
            return false;
        }
        float left = actor.x - boardW / 2f;
        float top = actor.y - boardH / 2f;
        if (wx < left || wy < top || wx >= left + boardW || wy >= top + boardH) {
            return false;
        }
        int c = (int) ((wx - left) / cell);
        int r = (int) ((wy - top) / cell);
        if (c < 0 || r < 0 || c >= cols || r >= rows) {
            return false;
        }
        int idx = r * cols + c;
        if (right) {
            if (!rightClickFlag) {
                return true;
            }
            toggleFlag(idx);
            return true;
        }
        // 点「已翻开的数字格」= 连锁翻开（chord）入口。
        //
        // ⚠ <b>普通模式也必须有 chord —— 否则「点数字没反应」</b>。
        // 早先这里只走 {@link #autoActionAt}（受 autoAction 参数控制，默认「关闭」= 0），
        // 而普通模式又没有自己的 chord 分支，于是玩家点已翻开的数字格时<b>什么都不发生</b>：
        // 脚本 UI 明明写着「点数字可连锁翻开」，实际点下去毫无反应 —— 典型的功能性缺失。
        // 标准扫雷的规则是：<b>周围旗数 == 该格数字 → 翻开其余未插旗的邻格</b>，
        // 不需要任何「自动辅助」开关，也不需要复雷模式的「虚实比例」。
        if (open[idx]) {
            boolean did = autoActionAt(idx);   // 可选辅助（自动标记/翻开），开关关着就跳过
            if (complexMode) {
                chord(idx);
                did = true;
            } else if (caps.reveal && !over && !mine[idx]) {
                // 普通模式标准 chord：旗数对齐才动，避免误踩（0 格直接忽略）
                did = chordStandard(idx) || did;
            }
            return true;   // 点已翻开格永远是「已被处理」，不再往下 reveal
        }
        reveal(idx);
        return true;
    }

    /**
     * 普通模式的标准连锁翻开（chord）。
     *
     * <p>规则（与 Windows 扫雷一致，只依赖玩家可见的信息）：
     * 当一个<b>已翻开</b>的数字格周围<b>玩家插的旗数恰好等于该数字</b>时，
     * 说明其余未翻开的邻格必定安全 → 把它们全翻开。
     * 旗数不对时<b>什么都不做</b>（不猜、不碰运气、不踩雷）。
     *
     * <p>这与 {@link #autoActionAt}（受 {@code autoAction} 开关控制、还包含「自动插旗」这种
     * 辅助能力）是两件事：标准 chord 是扫雷的<b>基本操作</b>，必须始终可用。
     *
     * @return 是否真的翻开了格子
     */
    private boolean chordStandard(int idx) {
        if (!open[idx] || over) {
            return false;
        }
        int number = counts[idx];
        if (number <= 0) {
            return false;              // 0 格周围本来就没有雷，没有 chord 语义
        }
        int flagged = 0;
        int remaining = 0;
        for (int dr = -1; dr <= 1; dr++) {
            for (int dc = -1; dc <= 1; dc++) {
                if (dr == 0 && dc == 0) {
                    continue;
                }
                int nr = idx / cols + dr;
                int nc = idx % cols + dc;
                if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) {
                    continue;
                }
                int ni = nr * cols + nc;
                if (flag[ni]) {
                    flagged++;
                } else if (!open[ni]) {
                    remaining++;
                }
            }
        }
        if (remaining <= 0 || flagged != number) {
            return false;              // 旗数没对齐：不做任何事
        }
        boolean acted = false;
        for (int dr = -1; dr <= 1; dr++) {
            for (int dc = -1; dc <= 1; dc++) {
                if (dr == 0 && dc == 0) {
                    continue;
                }
                int nr = idx / cols + dr;
                int nc = idx % cols + dc;
                if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) {
                    continue;
                }
                int ni = nr * cols + nc;
                if (!open[ni] && !flag[ni]) {
                    reveal(ni);
                    acted = true;
                }
            }
        }
        return acted;
    }

    /**
     * 自动标记/翻开：点一个<b>已翻开</b>的数字格时，按周围旗数推断下一步。
     *
     * <p><b>只靠两条玩家可见信息，绝不作弊</b>：
     * <ul>
     *   <li>{@code openedCountAround}：周围已翻开格数</b>（用于算「未翻开数」）；</li>
     *   <li>{@code flaggedAround}：周围<b>玩家自己插的</b>旗数。</li>
     * </ul>
     * 数字格显示的数字本来就等于「周围真实雷数」，所以：
     * <ul>
     *   <li>{@code flaggedAround == number} → 剩下的未翻开格必然安全 →
     *       按 {@link #AUTO_OPEN} 全翻开；</li>
     *   <li>{@code 未翻开数 == number}（未翻开 = 数字本身）→ 剩下的必然全是雷 →
     *       按 {@link #AUTO_FLAG} 全插旗；</li>
     *   <li>{@code AUTO_SMART} 两者都做（先插旗，旗齐后再展开）。</li>
     * </ul>
     *
     * <p>条件不满足时<b>什么都不做</b>，绝不基于猜测踩雷。
     *
     * @return 是否发生了实际动作（没动作时调用方不应判定为「已处理」）
     */
    boolean autoActionAt(int idx) {
        if (autoMode == 0 || !open[idx] || over || mine[idx]) {
            return false;
        }
        int number = counts[idx];          // 普通模式：周围雷数
        if (number <= 0) {
            return false;                  // 0 格没什么可推的
        }
        final int[] acc = new int[2];
        board.forEachNeighbor(idx, (ni, dr, dc) -> {
            if (flag[ni]) {
                acc[0]++;
            }
            if (!open[ni]) {
                acc[1]++;
            }
        });
        int flaggedAround = acc[0];
        int unopenedAround = acc[1];
        if (unopenedAround <= 0) {
            return false;
        }

        boolean acted = false;
        // ① 自动翻开：旗数刚好等于数字 → 剩下的都安全
        if ((autoMode & AUTO_OPEN) != 0 && flaggedAround == number) {
            board.forEachNeighbor(idx, (ni, dr, dc) -> {
                if (!open[ni] && !flag[ni]) {
                    reveal(ni);
                }
            });
            return true;
        }
        // ② 自动插旗：未翻开数 == 数字 → 剩下的必然全是雷
        if ((autoMode & AUTO_FLAG) != 0 && unopenedAround == number) {
            board.forEachNeighbor(idx, (ni, dr, dc) -> {
                if (!open[ni] && !flag[ni]) {
                    toggleFlag(ni);
                }
            });
            acted = true;
        }
        return acted;
    }

    /**
     * 解析自动机制参数。
     *
     * <p>取值口径与仓里其它 pick 参数一致：<b>字符串里含关键字即命中</b>，
     * 中英文都能识别（编辑器里显示的是中文，但工程文件可能存英文）。
     */
    static int parseAutoMode(String v) {
        if (v == null) {
            return 0;
        }
        String t = v.trim().toLowerCase();
        if (t.isEmpty() || t.contains("关闭") || t.contains("off") || t.contains("none")) {
            return 0;
        }
        boolean open = t.contains("翻开") || t.contains("open") || t.contains("chord");
        boolean flag = t.contains("标记") || t.contains("插旗") || t.contains("flag");
        if (open && flag) {
            return AUTO_SMART;
        }
        if (open) {
            return AUTO_OPEN;
        }
        if (flag) {
            return AUTO_FLAG;
        }
        // 只写「智能/smart」也按两者都做
        if (t.contains("智能") || t.contains("smart")) {
            return AUTO_SMART;
        }
        return 0;
    }

    /**
     * 复雷加殊的「点数字 = 连锁翻开」（规则文档第 4 节）。
     *
     * <p>仅当以下两条同时成立才翻开周围未插旗格：
     * <ol>
     *   <li><b>数量正确</b>：周围已插旗数 == 周围真实雷数；</li>
     *   <li><b>虚实比例正确</b>：{@link ComplexRules#ratioOk}（旗中真实实/虚雷构成 vs 真实雷构成）。</li>
     * </ol>
     * 不通过 → 什么都不做（<b>绝不踩雷</b>）；通过后仍要逐格走 {@link #reveal}，
     * 因为「被骗过、周围仍有未插旗真雷」时翻开即判负 —— 与普通扫雷的连锁后果一致。
     */
    void chord(int idx) {
        if (!complexMode || over || !open[idx]) {
            return;
        }
        int r0 = idx / cols;
        int c0 = idx % cols;
        int flagged = 0;
        int fR = 0;
        int fI = 0;
        int aR = 0;
        int aI = 0;
        for (int dr = -1; dr <= 1; dr++) {
            for (int dc = -1; dc <= 1; dc++) {
                if (dr == 0 && dc == 0) {
                    continue;
                }
                int nr = r0 + dr;
                int nc = c0 + dc;
                if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) {
                    continue;
                }
                int ni = nr * cols + nc;
                int code = mineValue[ni];
                boolean real = ComplexRules.isReal(code);
                boolean imag = ComplexRules.isImag(code);
                if (real) {
                    aR++;
                }
                if (imag) {
                    aI++;
                }
                if (flag[ni]) {
                    flagged++;
                    if (real) {
                        fR++;
                    }
                    if (imag) {
                        fI++;
                    }
                }
            }
        }
        // 无雷区点开无意义（也避免「0 雷区随便点就全翻开」的误触）。
        if (aR + aI == 0) {
            return;
        }
        if (flagged != aR + aI) {
            return;
        }
        if (!ComplexRules.ratioOk(fR, fI, aR, aI)) {
            return;
        }
        for (int dr = -1; dr <= 1; dr++) {
            for (int dc = -1; dc <= 1; dc++) {
                if (dr == 0 && dc == 0) {
                    continue;
                }
                int nr = r0 + dr;
                int nc = c0 + dc;
                if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) {
                    continue;
                }
                int ni = nr * cols + nc;
                if (!flag[ni] && !open[ni]) {
                    // 必须走同一个 reveal：判负 / 自动展开 / 胜利检查都在里面。
                    reveal(ni);
                }
            }
        }
    }

    void toggleFlag(int idx) {
        // 没挂 grid.flag / game.minesweeper 的玩法不响应插旗（由脚本自行管理标记）。
        if (!caps.flag) {
            return;
        }
        if (open[idx] || over) {
            return;
        }
        flag[idx] = !flag[idx];
        flags += flag[idx] ? 1 : -1;
        painter.invalidate();
    }

    void reveal(int idx) {
        if (open[idx] || flag[idx] || over) {
            return;
        }
        if (!started) {
            started = true;
            if (caps.mines) {
                placeMines(idx);
            }
        }
        // 无雷玩法（数织/围线/战棋）：点开就是翻开，不存在「踩雷判负」。
        if (caps.mines && mine[idx]) {
            over = true;
            won = false;
            if (revealAllOnLose) {
                for (int i = 0; i < mine.length; i++) {
                    if (mine[i]) {
                        open[i] = true;
                    }
                }
            }
            painter.invalidate();
            return;
        }
        openRegion(idx);
        checkWin();
        painter.invalidate();
    }

    /**
     * 翻开一片区域（点空白格自动展开）。
     *
     * <p>泛洪本身交给 {@link GridBoard#floodOpen}（通用能力，其它网格玩法也用它）；
     * 这里只提供「哪些格算空白」这条规则：
     * <ul>
     *   <li>普通模式：数字 0（周围无雷）；</li>
     *   <li>复雷加殊：{@code sumRe==0 && sumIm==0}（周围<b>真实雷为 0</b>）才展开 ——
     *       显示 {@code 0} 但实际有雷（+1 与 −1 抵消）的格子<b>不展开</b>，不泄露信息。</li>
     * </ul>
     */
    void openRegion(int start) {
        if (!autoOpenZeros) {
            open[start] = true;
            return;
        }
        board.floodOpen(start, idx -> complexMode
                ? (sumRe[idx] == 0 && sumIm[idx] == 0)
                : (counts[idx] == 0));
    }

    void placeMines(int safeIdx) {
        boolean[] blocked = new boolean[rows * cols];
        blocked[safeIdx] = true;
        if (firstClickSafe) {
            int sr = safeIdx / cols;
            int sc = safeIdx % cols;
            for (int dr = -1; dr <= 1; dr++) {
                for (int dc = -1; dc <= 1; dc++) {
                    int nr = sr + dr;
                    int nc = sc + dc;
                    if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
                        blocked[nr * cols + nc] = true;
                    }
                }
            }
        }
        List<Integer> pool = new ArrayList<>();
        for (int i = 0; i < blocked.length; i++) {
            if (!blocked[i]) {
                pool.add(i);
            }
        }
        Random random = seed == 0 ? new Random() : new Random(seed);
        Collections.shuffle(pool, random);
        mineCount = Math.min(wantedMines, pool.size());
        for (int i = 0; i < mineCount; i++) {
            int idx = pool.get(i);
            mine[idx] = true;
            // 普通模式雷值恒为 +1（sumIm 恒 0 → 数字与今天完全一致）；
            // 复雷加殊模式在同一颗 Random 上逐颗独立取 4 种之一（seed 一致 → 同盘可复现）。
            mineValue[idx] = complexMode ? (1 + random.nextInt(4)) : ComplexRules.POS_RE;
        }
        counts = new int[rows * cols];
        sumRe = new int[rows * cols];
        sumIm = new int[rows * cols];
        // 邻域统计交给 GridBoard 的通用遍历（边界处理在那边，只写一份）
        for (int idx = 0; idx < board.size(); idx++) {
            if (mine[idx]) {
                continue;
            }
            final int[] acc = new int[3];
            board.forEachNeighbor(idx, (ni, dr, dc) -> {
                if (!mine[ni]) {
                    return;
                }
                acc[0]++;                                  // 雷数
                int code = mineValue[ni];
                acc[1] += ComplexRules.reOf(code);          // 实部和
                acc[2] += ComplexRules.imOf(code);          // 虚部和
            });
            counts[idx] = acc[0];
            sumRe[idx] = acc[1];
            sumIm[idx] = acc[2];
        }
    }

    void checkWin() {
        // 纯网格玩法（只挂 grid.board / grid.reveal）没有雷，也就没有扫雷式胜负：
        // 这类玩法的得失由脚本自己判定，引擎不该替它宣布「胜利」。
        if (!caps.mines) {
            return;
        }
        for (int i = 0; i < open.length; i++) {
            if (!mine[i] && !open[i]) {
                return;
            }
        }
        won = true;
        over = true;
        painter.invalidate();
    }

    /** 首次绘制时解析一次素材图（之后复用）。 */
    private void ensureAssets() {
        if (assetsLoaded) {
            return;
        }
        assetHidden = rt.imageForAssetName(hiddenAsset);
        assetMine = rt.imageForAssetName(mineAsset);
        assetFlag = rt.imageForAssetName(flagAsset);
        assetsLoaded = true;
    }

    /** 素材参数变了 → 下次绘制重新解析。 */
    void invalidateAssets() {
        assetsLoaded = false;
        painter.invalidate();
    }

    /**
     * 绘制棋盘。
     *
     * <p>离屏位图 + 纹理缓存 + 脏标记这套通用机制交给 {@link GridPainter}；
     * 这里只提供「扫雷每一格长什么样」的画笔（{@link #paintCell}）。
     */
    /**
     * 丢弃自绘纹理，强制下一帧整块重画。
     *
     * <p>GL 上下文重建（{@link TopDownRuntime#rebuildGpuResources}）后必须调用：
     * 旧纹理 id 已失效，但 {@code texture} 引用还在，直接 bind 会变黑。
     *
     * @return 被丢弃的旧纹理对象（宿主据此把它从「待重建」名单里摘掉，避免重建一张
     *         谁都不画的孤儿纹理）
     */
    Texture invalidateTexture() {
        texture = null;
        return painter.invalidateTexture();
    }

    void draw(GL2 gl) {
        Texture tex = painter.paintIfDirty(gl, this::paintCell);
        if (tex == null) {
            return;
        }
        this.texture = tex;
        painter.draw(gl, actor.x - boardW / 2f, actor.y - boardH / 2f, tex);
    }

    /**
     * 画扫雷的一格（Win9x 风格 3D 地砖）。
     *
     * <p>这是<b>扫雷专属</b>的画法，所以留在本类；{@link GridPainter} 只负责
     * 调度「逐格回调 + 模式化重绘 + 纹理上传」这套通用流程。
     * 换个玩法（数织、围线、战棋）只需实现自己的 paintCell，不用碰这套流程。
     */
    private boolean paintCell(Graphics2D g, GridBoard board, int idx, int x, int y, int cellSize) {
        // 局部别名：方法体沿用原 paint() 里的变量名，减少改写风险
        int cell = cellSize;
        // 素材图走本类缓存（每格调用本方法，不能每格都查表）
        ensureAssets();
        BufferedImage hidden = assetHidden;
        BufferedImage mineImg = assetMine;
        BufferedImage flagImg = assetFlag;
    // Win9x 风格的 3D 立体 tile：
    //   - 未翻开：亮边（左/上 #ffffff） + 暗边（右/下 #808080）+ 银色底 #c0c0c0，
    //     再画一条 1px 的深色外框 —— 经典扫雷的凸起地砖。
    //   - 已翻开：平铺 #c0c0c0 银色底，+ 1px 灰外框。
    //   - 插旗 / 雷：仍优先用素材，素材缺省时用像素画的旗 / 黑色雷。
    Color hi = new Color(0xff, 0xff, 0xff);
    Color lo = new Color(0x80, 0x80, 0x80);
    Color mid = new Color(0xc0, 0xc0, 0xc0);
    if (!open[idx]) {
        // 底层：Win9x 凸起地砖（银灰 + 亮/暗 3D 边）
        g.setColor(mid);
        g.fillRect(x, y, cell, cell);
        g.setColor(hi);
        g.fillRect(x, y, cell - 2, 3);
        g.fillRect(x, y, 3, cell - 2);
        g.setColor(lo);
        g.fillRect(x + 2, y + cell - 3, cell - 2, 3);
        g.fillRect(x + cell - 3, y + 2, 3, cell - 2);
        g.setColor(new Color(0x40, 0x40, 0x40));
        g.drawRect(x, y, cell - 1, cell - 1);
        // 手机顶上一格小卖点（素材图叠在 silver 之上，保住可读性）
        if (hidden != null) {
            // 与「棋子」（旗/人头）同尺寸：cell 的 50%，居中，且不裁切素材
            g.drawImage(hidden, x + cell / 4, y + cell / 4, cell / 2, cell / 2, null);
        }
        if (flag[idx]) {
            if (flagImg != null) {
                g.drawImage(flagImg, x + cell / 4, y + cell / 4, cell / 2, cell / 2, null);
            } else {
                g.setColor(new Color(0xf0, 0x52, 0x5f));
                g.fillPolygon(new int[]{x + 10, x + 24, x + 10},
                        new int[]{y + 8, y + 15, y + 22}, 3);
                g.setColor(new Color(0x30, 0x30, 0x30));
                g.fillRect(x + cell / 2, y + 8, 3, cell * 9 / 16);
            }
        }
    } else if (mine[idx]) {
        g.setColor(mid);
        g.fillRect(x, y, cell, cell);
        g.setColor(new Color(0x40, 0x40, 0x40));
        g.drawRect(x, y, cell - 1, cell - 1);
        if (mineImg != null) {
            g.drawImage(mineImg, x + 2, y + 2, cell - 4, cell - 4, null);
        } else {
            g.setColor(new Color(0x14, 0x18, 0x21));
            g.fillOval(x + 8, y + 8, cell - 16, cell - 16);
        }
        // 复雷加殊：亮雷时右下角叠一枚小字标出它的种类（+1/−1/+i/−i）。
        // 普通模式不进这个分支 —— 素材图与像素雷保持今天的逐像素外观。
        if (complexMode) {
            String tag = ComplexRules.tag(mineValue[idx]);
            if (!tag.isEmpty()) {
                int fs = Math.max(8, cell / 3);
                g.setFont(new Font("Microsoft YaHei", Font.BOLD, fs));
                FontMetrics tfm = g.getFontMetrics();
                int tw = tfm.stringWidth(tag);
                // 小字 + 深描边底衬，保证叠在素材图上仍可读。
                int tx = x + cell - tw - 2;
                int ty = y + cell - 2;
                g.setColor(new Color(0xff, 0xff, 0xff, 0xdd));
                g.fillRect(tx - 1, ty - tfm.getAscent() - 1, tw + 2, tfm.getAscent() + 2);
                g.setColor(ComplexRules.tagColor(mineValue[idx]));
                g.drawString(tag, tx, ty);
            }
        }
    } else {
        g.setColor(new Color(0xe8, 0xec, 0xf5));
        g.fillRect(x + 1, y + 1, cell - 2, cell - 2);
        if (complexMode) {
            // 复雷加殊：数字 = 周围雷值之和的模长。整数沿用旧配色与字号；
            // 带根号另给一套色、字号略小（最多 3 字符，如 √10），并保证不被裁。
            int re = sumRe[idx];
            int im = sumIm[idx];
            int sq = re * re + im * im;
            String s = ComplexRules.label(re, im);
            if (ComplexRules.isPerfectSquare(sq)) {
                int num = ComplexRules.isqrt(sq);
                g.setColor(numberColor(num));
                g.setFont(new Font("Microsoft YaHei", Font.BOLD, Math.max(12, cell * 3 / 5)));
            } else {
                g.setColor(ComplexRules.rootColor(sq));
                g.setFont(new Font("Microsoft YaHei", Font.BOLD, Math.max(10, cell / 2)));
            }
            FontMetrics fm = g.getFontMetrics();
            // 窄格放不下 √10 这类 3 字符时逐级缩字号（下限 8px），绝不裁切。
            int fs = g.getFont().getSize();
            while (fm.stringWidth(s) > cell - 2 && fs > 8) {
                fs--;
                g.setFont(new Font("Microsoft YaHei", Font.BOLD, fs));
                fm = g.getFontMetrics();
            }
            int tx = x + (cell - fm.stringWidth(s)) / 2;
            int ty = y + (cell - fm.getHeight()) / 2 + fm.getAscent();
            g.drawString(s, tx, ty);
        } else {
            // 普通模式：原样保留今天的整数渲染（零回归的硬证据）。
            int n = counts[idx];
            if (n > 0) {
                g.setColor(numberColor(n));
                g.setFont(new Font("Microsoft YaHei", Font.BOLD, Math.max(12, cell * 3 / 5)));
                String s = String.valueOf(n);
                FontMetrics fm = g.getFontMetrics();
                int tx = x + (cell - fm.stringWidth(s)) / 2;
                int ty = y + (cell - fm.getHeight()) / 2 + fm.getAscent();
                g.drawString(s, tx, ty);
            }
        }
    }

        return true;
    }

    private static Color numberColor(int n) {
        switch (n) {
            case 1:
                return new Color(0x2f, 0x64, 0xd8);
            case 2:
                return new Color(0x1f, 0x8a, 0x4c);
            case 3:
                return new Color(0xd9, 0x3b, 0x3b);
            case 4:
                return new Color(0x52, 0x3a, 0xa8);
            case 5:
                return new Color(0xa8, 0x3a, 0x2a);
            case 6:
                return new Color(0x1a, 0x8a, 0x8a);
            case 7:
                return new Color(0x22, 0x22, 0x22);
            default:
                return new Color(0x66, 0x6e, 0x82);
        }
    }
    }