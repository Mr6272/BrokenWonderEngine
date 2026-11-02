package Studio.runtime;

/**
 * 扫雷棋盘逐格状态的取证导出（只读，不参与玩法）。
 *
 * <p><b>为什么需要</b>：验证「点已翻开的数字格 → 连锁翻开（chord）」必须能看到
 * <b>哪一格是数字、周围埋了几颗雷、哪几格还盖着、哪几格插了旗</b>。
 * 只看截图无法判断「这次没翻开」是因为「旗数没对齐（正确行为）」还是
 * 「chord 根本没实现（缺陷）」—— 必须读棋盘内部状态才能一刀切开。
 *
 * <p>格式：每格 {@code r,c=数字[M][F][O]}，M=是雷、F=已插旗、O=已翻开；
 * 行之间用 {@code |} 分隔，便于在 logcat 单行里完整呈现。
 */
final class MineDump {

    private MineDump() {
    }

    static String describe(Minesweeper m) {
        if (m == null) {
            return "no-minesweeper";
        }
        StringBuilder sb = new StringBuilder(1024);
        sb.append("grid=").append(m.rows).append('x').append(m.cols)
                .append(" mines=").append(m.mineCount)
                .append(" flags=").append(m.flags)
                .append(" over=").append(m.over)
                .append(" won=").append(m.won)
                .append(" | ");
        for (int r = 0; r < m.rows; r++) {
            for (int c = 0; c < m.cols; c++) {
                int i = r * m.cols + c;
                sb.append(r).append(',').append(c).append('=').append(m.counts[i]);
                if (m.mine[i]) {
                    sb.append('M');
                }
                if (m.flag[i]) {
                    sb.append('F');
                }
                if (m.open[i]) {
                    sb.append('O');
                }
                sb.append(' ');
            }
            if (r + 1 < m.rows) {
                sb.append("| ");
            }
        }
        return sb.toString();
    }
}
