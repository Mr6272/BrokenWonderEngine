package Studio.runtime;

/**
 * 边界用例：输入框允许输入的各种极值组合下，引擎不能崩。
 *
 * <p><b>真实事故</b>：玩家在输入框里把行/列/雷数改成 1，游戏直接崩。
 * 根因是「输入框只做了类型校验（是不是数字），没做业务范围校验」——
 * 引擎侧虽然 clamp 了 rows/cols，但 mines 与它们的组合可以产生
 * 「雷比可用格还多」「池子为空」这类非法状态。
 *
 * <p>这里把极端组合逐个跑一遍，确保 {@code reset/reveal/checkWin/status} 都不抛异常。
 */
public final class EdgeCaseTest {

    public static void main(String[] a) {
        int pass = 0;
        int fail = 0;
        String[] cases = {
                "5,5,1", "5,5,16", "5,5,25", "3,3,1", "3,3,9", "3,3,40",
                "40,40,1", "40,40,400", "1,1,1", "1,16,1", "16,1,1",
                "5,30,1", "30,5,1", "12,16,40", "2,2,1", "2,2,4"
        };
        for (String cs : cases) {
            String[] parts = cs.split(",");
            int rows = Integer.parseInt(parts[0]);
            int cols = Integer.parseInt(parts[1]);
            int mines = Integer.parseInt(parts[2]);
            try {
                TopDownRuntime rt = TopDownRuntime.newStub();
                rt.view.setViewport(1280, 720);
                Actor ac = new Actor();
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
                Minesweeper ms = new Minesweeper(rt, ac, m, caps);

                ms.reset();
                // 模拟真实操作：首击 + 连锁点击 + 判胜
                ms.reveal(0);
                for (int i = 0; i < Math.min(ms.board.size(), 30); i++) {
                    ms.reveal(i);
                }
                ms.checkWin();
                String st = ms.status();
                System.out.println("  [OK] " + cs + " → " + st
                        + " board=" + ms.boardW + "x" + ms.boardH
                        + " mineCount=" + ms.mineCount
                        + " opened=" + ms.board.openedCount);
                pass++;
            } catch (Throwable t) {
                System.out.println("  [CRASH] " + cs + " → " + t);
                t.printStackTrace(System.out);
                fail++;
            }
        }
        System.out.println("==== RESULT: " + pass + "/" + (pass + fail) + " passed ====");
        if (fail > 0) {
            System.out.println(fail + " 项崩溃");
            System.exit(1);
        }
        System.out.println("ALL PASS");
    }
}
