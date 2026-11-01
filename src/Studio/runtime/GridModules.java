package Studio.runtime;

import java.util.ArrayList;
import java.util.List;

/**
 * 网格模块注册表：把「格子类玩法」拆成一组<b>可单独挂载的能力模块</b>。
 *
 * <p><b>要解决的问题</b>：原来只有 {@code game.minesweeper} 一个整块模块 ——
 * 「一整个游戏做成一个模块」，别的玩法想复用棋盘/渲染/翻开规则，只能复制那 626 行。
 * 现在拆成下面这些<b>正交能力</b>，任何新玩法按需组合：
 *
 * <table border="1">
 *   <tr><th>模块 id</th><th>提供什么</th><th>单独挂载的意义</th></tr>
 *   <tr><td>{@code grid.board}</td><td>行列网格、每格状态、邻域遍历、泛洪</td>
 *       <td>只要一块可交互的网格（数织、围线、战棋、消除、推箱子）</td></tr>
 *   <tr><td>{@code grid.tile}</td><td>格子渲染：3D 凸起/平铺/贴图/数字着色</td>
 *       <td>只要「把格子画出来」的外观层</td></tr>
 *   <tr><td>{@code grid.reveal}</td><td>翻开规则：首击安全、空白自动展开、踩雷全亮</td>
 *       <td>只要「点开」这套行为，不要扫雷的雷</td></tr>
 *   <tr><td>{@code grid.flag}</td><td>标记规则：插旗计数、胜利判定</td>
 *       <td>只要「标记 + 达成条件」这套行为</td></tr>
 *   <tr><td>{@code game.minesweeper}</td><td>以上全部组合 + 雷生成 + 复雷规则</td>
 *       <td>完整扫雷（<b>向后兼容</b>：老工程配的还是它，行为不变）</td></tr>
 * </table>
 *
 * <p><b>组合方式</b>：一个对象上可以同时挂多个 {@code grid.*} 模块，本类把它们收成一个
 * {@link Bundle}；{@code Minesweeper} 就是「全开」的特例。未来新玩法 = 选择需要的模块 + 少量脚本。
 */
final class GridModules {

    /** 通用网格能力开关（由对象上挂的模块决定）。 */
    static final class Bundle {
        /** 有网格（grid.board / game.minesweeper）。 */
        boolean board;
        /** 有渲染层（grid.tile / game.minesweeper）。 */
        boolean tile;
        /** 有翻开规则（grid.reveal / game.minesweeper）。 */
        boolean reveal;
        /** 有标记规则（grid.flag / game.minesweeper）。 */
        boolean flag;
        /** 有雷（只有 game.minesweeper，其它玩法不需要）。 */
        boolean mines;
        /** 有完整扫雷组合（game.minesweeper）。 */
        boolean minesweeper;

        /** 由具体模块拼装的能力集。 */
        static Bundle of(GameData.RtObject o) {
            Bundle b = new Bundle();
            b.minesweeper = has(o, "game.minesweeper");
            // ⚠ 「有没有棋盘」不等于「挂了没有 grid.board」：
            // 只要挂了**任一** grid.* 模块，就必须有一个棋盘实例来承载它。
            // 早先写成 b.board = b.minesweeper || has(o,"grid.board")，
            // 导致「只挂 grid.reveal」时 board=false → 棋盘不创建 → 该模块静默失效。
            b.board = b.minesweeper || has(o, "grid.board") || has(o, "grid.tile")
                    || has(o, "grid.reveal") || has(o, "grid.flag");
            b.tile = b.minesweeper || has(o, "grid.tile");
            b.reveal = b.minesweeper || has(o, "grid.reveal");
            b.flag = b.minesweeper || has(o, "grid.flag");
            b.mines = b.minesweeper;
            return b;
        }

        private static boolean has(GameData.RtObject o, String def) {
            if (o == null || o.modules == null) {
                return false;
            }
            for (GameData.RtModule m : o.modules) {
                if (def.equals(m.def)) {
                    return true;
                }
            }
            return false;
        }

        /** 是否至少挂了一个网格类模块。 */
        boolean any() {
            return board || tile || reveal || flag || minesweeper;
        }

        /**
         * 把对象上所有网格类模块的参数合并成一份（供棋盘读取）。
         *
         * <p>拆分后参数分散在 4 个模块里（grid.board 提供 rows/cols/cellSize，
         * grid.reveal 提供 firstClickSafe/autoOpenZeros/revealAllOnLose，
         * grid.flag 提供 rightClickFlag/winCondition/showTimer，
         * grid.tile 提供三个贴图名）。运行时只有一个棋盘，所以必须合并。
         * {@code game.minesweeper} 自带全套参数，排在最前优先。
         */
        static GameData.RtModule mergedParams(GameData.RtObject o, String fallbackDef) {
            GameData.RtModule merged = new GameData.RtModule();
            if (o == null || o.modules == null) {
                merged.def = fallbackDef == null ? "" : fallbackDef;
                return merged;
            }
            // 顺序很重要：完整扫雷在前（它的参数最全，应优先）
            String[] order = {"game.minesweeper", "grid.board", "grid.tile", "grid.reveal",
                    "grid.flag"};
            for (String def : order) {
                for (GameData.RtModule m : o.modules) {
                    if (def.equals(m.def)) {
                        if (merged.def.isEmpty()) {
                            merged.def = def;
                            merged.when = m.when;
                            merged.label = m.label;
                        }
                        merged.mergeParams(m);
                    }
                }
            }
            if (merged.def.isEmpty()) {
                merged.def = fallbackDef == null ? "" : fallbackDef;
            }
            return merged;
        }

        /** 诊断摘要。 */
        String describe() {
            List<String> on = new ArrayList<String>();
            if (minesweeper) {
                on.add("minesweeper");
            }
            if (board) {
                on.add("board");
            }
            if (tile) {
                on.add("tile");
            }
            if (reveal) {
                on.add("reveal");
            }
            if (flag) {
                on.add("flag");
            }
            if (mines) {
                on.add("mines");
            }
            return on.toString();
        }
    }

    private GridModules() {
    }
}
