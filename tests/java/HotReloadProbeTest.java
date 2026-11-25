package Studio.runtime;

import org.mozilla.javascript.Context;

/**
 * 热重载语法探针的行为测试。
 *
 * 为什么这个测试值得存在：
 *   热重载一旦判错，用户会得到两种坏结果之一——
 *   要么把有语法错误的脚本提交上去（游戏当场炸），
 *   要么把好脚本拒掉（改了没反应，用户以为热重载是坏的）。
 *   这两种都只能靠"判定逻辑本身正确"来排除，而不是靠人肉试。
 */
public class HotReloadProbeTest {
    static int pass = 0, fail = 0;

    static void check(String name, boolean cond, String detail) {
        if (cond) { pass++; }
        else { fail++; System.out.println("  FAIL " + name + (detail != null ? " — " + detail : "")); }
    }

    public static void main(String[] args) {
        Context cx = Context.enter();
        try {
            // 1. 正常脚本应当通过
            String[] good = {
                "function onStart() { this.speed = 3; }",
                "var x = 1 + 2;\nfunction update(dt) { x += dt; }",
                "// 只有注释",
                "function f() { return [1,2,3].map(function(v){ return v*2; }); }",
                "this.light = bwe.light ? 1 : 0;"
            };
            for (String code : good) {
                check("合法脚本通过: " + code.substring(0, Math.min(24, code.length())),
                      ScriptEngine.probeSyntax(cx, "t", code) == null,
                      "被误判为语法错误");
            }

            // 2. 语法错误必须被抓住——这一类是用户最常见的保存状态（括号没闭）
            String[] bad = {
                "function onStart() {",
                "var x = ;",
                "function f() { return 1 + ; }",
                "if (true) {",
                "function ( {"
            };
            for (String code : bad) {
                check("语法错误被捕获: " + code.substring(0, Math.min(24, code.length())),
                      ScriptEngine.probeSyntax(cx, "t", code) != null,
                      "坏脚本被放行，会污染运行中的游戏");
            }

            // 3. 空脚本不算语法错误（用户新建文件还没写）
            check("空字符串不算错误", ScriptEngine.probeSyntax(cx, "t", "") == null, null);
            check("纯空白不算错误", ScriptEngine.probeSyntax(cx, "t", "   \n\t ") == null, null);

            // 4. 错误信息必须非空且可读（要能展示给用户）
            String err = ScriptEngine.probeSyntax(cx, "t", "function f() {");
            check("错误信息非空", err != null && !err.isEmpty(), "错误信息为空，用户看不到哪里错了");

            // 5. ES5 之外的老写法也要能跑（Rhino 是 ES5）
            check("ES5 语法可用",
                  ScriptEngine.probeSyntax(cx, "t", "var a = {b:1}; for (var k in a) { }") == null, null);

        } finally {
            Context.exit();
        }
        System.out.println("\n结果: " + pass + " 通过, " + fail + " 失败");
        if (fail > 0) System.exit(1);
    }
}
