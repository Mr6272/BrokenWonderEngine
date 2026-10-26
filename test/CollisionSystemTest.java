import Core.CollisionSystem;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * CollisionSystem 配对枚举的回归测试。
 * 验证：所有 (i,j) i&lt;j 配对都被枚举（含索引 0），且无自配对、无重复。
 * <p>
 * 运行方式：
 * <pre>
 *   javac -d bin -encoding utf-8 -cp "bin;lib/*" test/CollisionSystemTest.java
 *   java -cp "bin;lib/*" CollisionSystemTest
 * </pre>
 * 或 VS Code 任务面板运行 "test" 任务。
 */
public class CollisionSystemTest {
    public static void main(String[] args) {
        for (int n = 0; n <= 6; n++) {
            List<int[]> pairs = CollisionSystem.enumeratePairs(n);
            int expected = n * (n - 1) / 2;
            check(pairs.size() == expected,
                    "n=" + n + " 配对数量应为 " + expected + "，实际 " + pairs.size());

            Set<String> seen = new HashSet<>();
            for (int[] p : pairs) {
                check(p.length == 2, "配对必须是二元组");
                int i = p[0], j = p[1];
                check(i >= 0 && j < n, "索引越界: (" + i + "," + j + ") n=" + n);
                check(i < j, "配对必须 i<j，得到 (" + i + "," + j + ")");
                check(seen.add(i + "," + j), "重复配对: " + i + "," + j);
            }

            if (n >= 2) {
                // 回归点：旧实现循环到索引 1 为止，第一个注册的碰撞体（索引 0）永不参与配对
                boolean hasZeroPair = false;
                for (int[] p : pairs) {
                    if (p[0] == 0) {
                        hasZeroPair = true;
                        break;
                    }
                }
                check(hasZeroPair, "n=" + n + " 索引 0 必须参与配对（旧 bug 回归）");
            }
        }
        System.out.println("CollisionSystemTest: ALL PASS");
    }

    private static void check(boolean condition, String message) {
        if (!condition) {
            System.err.println("FAIL: " + message);
            System.exit(1);
        }
    }
}
