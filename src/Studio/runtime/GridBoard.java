package Studio.runtime;

/**
 * 格子棋盘内核：任意「行列网格 + 每格状态」玩法共用的基础状态机。
 *
 * <p><b>为什么抽出来</b>：扫雷原本把「网格状态（翻开/插旗/雷/邻域数）」「规则（首击安全、
 * 空白自动展开、胜负判定）」「渲染（画格子和数字）」全塞在一个 626 行类里。
 * 其中<b>网格状态与邻域计算</b>是通用的 —— 数织、围线、战棋、消除类都能直接用，
 * 不该被锁死在「扫雷」这个名字下。
 *
 * <p>本类只做<b>纯数据</b>，不碰 GL、不碰脚本、不做胜负判定（那些属于具体玩法）：
 * <ul>
 *   <li>索引换算：{@link #idx} / {@link #rowOf} / {@link #colOf}；</li>
 *   <li>邻域遍历：{@link #forEachNeighbor}（8 邻域）/ {@link #forEachNeighbor4}（4 邻域），
 *       自动处理边界，调用方不用写一堆 {@code if (nr < 0 ...)}；</li>
 *   <li>位标记：{@link #setFlag} / {@link #isFlagged} / {@link #isOpened} 等，带计数；</li>
 *   <li>索引栈：{@link #stackPush} / {@link #stackPop}（空白区泛洪复用，避免每次 new 数组）。</li>
 * </ul>
 *
 * <p>扫雷的 {@link Minesweeper} 建在它之上；将来做新玩法时直接复用，
 * 不用再从 {@code int[] open} 那一层开始抄。
 */
final class GridBoard {

    /** 格子宽（列数）。 */
    final int cols;
    /** 格子高（行数）。 */
    final int rows;
    /** 每格边长（世界像素）。 */
    final int cellSize;

    /** 翻开状态。 */
    final boolean[] opened;
    /** 插旗/标记状态。 */
    final boolean[] flagged;
    /** 是否有雷（由具体玩法填充；非雷玩法可留空）。 */
    final boolean[] mine;

    /** 已翻开格数。 */
    int openedCount;
    /** 已标记格数。 */
    int flaggedCount;

    /** 泛洪用的索引栈（复用，避免每帧分配）。 */
    private final int[] stack;
    private int stackTop;

    GridBoard(int rows, int cols, int cellSize) {
        this.rows = Math.max(1, rows);
        this.cols = Math.max(1, cols);
        this.cellSize = Math.max(8, cellSize);
        int n = this.rows * this.cols;
        this.opened = new boolean[n];
        this.flagged = new boolean[n];
        this.mine = new boolean[n];
        this.stack = new int[Math.max(16, n * 4)];
    }

    /** 总格数。 */
    int size() {
        return rows * cols;
    }

    /** 棋盘像素宽。 */
    int pixelWidth() {
        return cols * cellSize;
    }

    /** 棋盘像素高。 */
    int pixelHeight() {
        return rows * cellSize;
    }

    // ---------------- 索引换算 ----------------

    int idx(int row, int col) {
        return row * cols + col;
    }

    int rowOf(int idx) {
        return idx / cols;
    }

    int colOf(int idx) {
        return idx % cols;
    }

    boolean inBounds(int row, int col) {
        return row >= 0 && col >= 0 && row < rows && col < cols;
    }

    /** 世界坐标 → 格子索引（越界返回 -1）。 */
    int idxAtWorld(float wx, float wy, float boardLeft, float boardTop) {
        float fx = wx - boardLeft;
        float fy = wy - boardTop;
        if (fx < 0f || fy < 0f || fx >= pixelWidth() || fy >= pixelHeight()) {
            return -1;
        }
        int c = (int) (fx / cellSize);
        int r = (int) (fy / cellSize);
        if (c < 0 || r < 0 || c >= cols || r >= rows) {
            return -1;
        }
        return r * cols + c;
    }

    // ---------------- 邻域遍历 ----------------

    /** 邻域回调。 */
    interface NeighborFn {
        void apply(int neighborIdx, int dr, int dc);
    }

    /** 8 邻域（含对角），自动跳过越界与自身。 */
    void forEachNeighbor(int idx, NeighborFn fn) {
        int r0 = rowOf(idx);
        int c0 = colOf(idx);
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
                fn.apply(nr * cols + nc, dr, dc);
            }
        }
    }

    /** 4 邻域（上下左右），自动跳过越界与自身。 */
    void forEachNeighbor4(int idx, NeighborFn fn) {
        int r0 = rowOf(idx);
        int c0 = colOf(idx);
        for (int dr = -1; dr <= 1; dr++) {
            for (int dc = -1; dc <= 1; dc++) {
                if (Math.abs(dr) + Math.abs(dc) != 1) {
                    continue;
                }
                int nr = r0 + dr;
                int nc = c0 + dc;
                if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) {
                    continue;
                }
                fn.apply(nr * cols + nc, dr, dc);
            }
        }
    }

    /** 统计 8 邻域里满足条件的格数（常用：数周围雷数）。 */
    int countNeighbors(int idx, java.util.function.IntPredicate predicate) {
        int[] n = new int[1];
        forEachNeighbor(idx, (ni, dr, dc) -> {
            if (predicate.test(ni)) {
                n[0]++;
            }
        });
        return n[0];
    }

    // ---------------- 状态 ----------------

    boolean isOpened(int idx) {
        return idx >= 0 && idx < opened.length && opened[idx];
    }

    boolean isFlagged(int idx) {
        return idx >= 0 && idx < flagged.length && flagged[idx];
    }

    boolean isMine(int idx) {
        return idx >= 0 && idx < mine.length && mine[idx];
    }

    void setOpened(int idx) {
        if (idx < 0 || idx >= opened.length || opened[idx]) {
            return;
        }
        opened[idx] = true;
        openedCount++;
    }

    void setFlagged(int idx, boolean v) {
        if (idx < 0 || idx >= flagged.length || flagged[idx] == v) {
            return;
        }
        flagged[idx] = v;
        flaggedCount += v ? 1 : -1;
    }

    void setMine(int idx, boolean v) {
        if (idx >= 0 && idx < mine.length) {
            mine[idx] = v;
        }
    }

    /** 全量重置（保留尺寸）。 */
    void clear() {
        java.util.Arrays.fill(opened, false);
        java.util.Arrays.fill(flagged, false);
        java.util.Arrays.fill(mine, false);
        openedCount = 0;
        flaggedCount = 0;
        stackTop = 0;
    }

    // ---------------- 索引栈（泛洪用） ----------------

    void stackClear() {
        stackTop = 0;
    }

    boolean stackPush(int idx) {
        if (stackTop >= stack.length) {
            return false;
        }
        stack[stackTop++] = idx;
        return true;
    }

    /** 弹出一个索引；空栈返回 -1。 */
    int stackPop() {
        return stackTop <= 0 ? -1 : stack[--stackTop];
    }

    /** 从某格开始泛洪：把所有「未翻开、未插旗、非雷、且 predicate 为真」的相连格置为翻开。 */
    interface FloodPredicate {
        /** @return true = 可以继续从这个格子扩散 */
        boolean canFlood(int idx);
    }

    /**
     * 泛洪翻开（扫雷的「点 0 自动展开」、数织的连通区域、图论的连通块都适用）。
     *
     * @param start 起点索引
     * @param canFlood 是否继续扩散的判据（例如「该格邻域雷数为 0」）
     * @return 本次新翻开的格数
     */
    /** 泛洪过程里新翻开的格数（用字段而不是局部变量：lambda 捕获要求 effectively final）。 */
    private int floodAdded;

    int floodOpen(int start, FloodPredicate canFlood) {
        if (start < 0 || start >= size() || opened[start]) {
            return 0;
        }
        floodAdded = 0;
        stackClear();
        setOpened(start);
        floodAdded++;
        if (!canFlood.canFlood(start)) {
            return floodAdded;
        }
        stackPush(start);
        while (true) {
            int cur = stackPop();
            if (cur < 0) {
                break;
            }
            forEachNeighbor(cur, (ni, dr, dc) -> {
                if (opened[ni] || flagged[ni] || mine[ni]) {
                    return;
                }
                setOpened(ni);
                floodAdded++;
                if (canFlood.canFlood(ni)) {
                    stackPush(ni);
                }
            });
        }
        return floodAdded;
    }

    /** 诊断：当前状态摘要。 */
    String describe() {
        return rows + "x" + cols + " opened=" + openedCount + " flagged=" + flaggedCount;
    }
}
