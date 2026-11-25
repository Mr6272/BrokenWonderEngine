import { readFileSync, writeFileSync } from "node:fs";
const p = "web/src/webplayer/player.ts";
let s = readFileSync(p, "utf8");
s = s.replace(/\r\n/g, "\n");
const before = s;

// api.ts 里 createBwe 返回的 bwe 对象类型：用 any 收账，避免把 api 内部类型泄露进来
if (!s.includes("private bwe")) {
  s = s.replace(
    "  private scripts: CompiledScript[] = [];",
    "  private scripts: CompiledScript[] = [];\n  /** createBwe 产出的全局 bwe 对象。存成字段是因为扫雷这类\"引擎托管模块\"要在\n   *  指针事件与渲染循环里访问它（脚本只是它的调用方之一）。 */\n  private bwe: unknown = null;",
  );
}
if (!s.includes("this.bwe = bwe")) {
  s = s.replace("const bwe = createBwe(this.ctx);", "const bwe = createBwe(this.ctx);\n    this.bwe = bwe;");
}

// 三处取 board 的地方统一用一个 helper
s = s.replace(/    const api = \(this as unknown as \{ bwe\?: \{ mine\?: \{ __board\?: \(\) => unknown \} \} \}\)\.bwe;\n    const board = api\?\.mine\?\.__board\?\.\(\);/g,
  "    const board = this.mineBoard();");

// 插入 helper
if (!s.includes("private mineBoard()")) {
  s = s.replace(
    "  /** bwe.mine 的棋盘对象来自场景；场景加载完才能定位，所以这里惰性绑定一次。 */",
    `  /** 取 bwe.mine 的底层棋盘；没启用扫雷模块时返回 null。 */
  private mineBoard(): unknown {
    const api = this.bwe as { mine?: { __board?: () => unknown } } | null;
    return api?.mine?.__board?.() ?? null;
  }

  /** bwe.mine 的棋盘对象来自场景；场景加载完才能定位，所以这里惰性绑定一次。 */`,
  );
}

if (s === before) { console.error("no change"); process.exit(1); }
writeFileSync(p, s, "utf8");
console.log("field=" + s.includes("private bwe") + " assign=" + s.includes("this.bwe = bwe") + " helper=" + s.includes("private mineBoard()") + " uses=" + (s.match(/this\.mineBoard\(\)/g)||[]).length);
