import { readFileSync, writeFileSync } from "node:fs";
const p = "web/src/webplayer/player.ts";
let s = readFileSync(p, "utf8");
s = s.replace(/\r\n/g, "\n");
const before = s;

// 1) import
if (!s.includes('from "./minebind"')) {
  s = s.replace(
    'import {\n  createBwe,',
    'import { dispatchMineClick, findBoardObject, paintMineBoard } from "./minebind";\nimport {\n  createBwe,',
  );
}

// 2) 字段
if (!s.includes("private mineBound = false")) {
  s = s.replace(
    "  private fpsAcc = 0;",
    "  private fpsAcc = 0;\n  /** bwe.mine 的棋盘承载对象是否已定位（场景加载后惰性绑定） */\n  private mineBound = false;",
  );
}

// 3) 点击路由：pointerdown 里，扫雷板优先消费左/右键
const pdAnchor = `      this.ctx.input.clickedThisFrame = true;
    });`;
if (!s.includes(pdAnchor)) { console.error("pointerdown anchor miss"); process.exit(1); }
s = s.replace(
  pdAnchor,
  `      this.ctx.input.clickedThisFrame = true;
      // bwe.mine：棋盘优先消费左键/右键（Java 侧棋盘是引擎托管的，点击不经过脚本）
      this.routeMineClick({ x: w.x, y: w.y, button: e.button });
    });`,
);

// 4) render 里画棋盘
const rAnchor = `    // 脚本主动绘制（bwe.draw.*）的队列，按 layer 排在场景之上。`;
if (!s.includes(rAnchor)) { console.error("render anchor miss"); process.exit(1); }
s = s.replace(
  rAnchor,
  `    this.paintMineIfActive();

` + rAnchor,
);

// 5) 两个方法，插在 render() 之前
const mAnchor = "  private render(): void {";
if (!s.includes(mAnchor)) { console.error("method anchor miss"); process.exit(1); }
const methods = `  /** bwe.mine 的棋盘对象来自场景；场景加载完才能定位，所以这里惰性绑定一次。 */
  private mineObject(): SceneObject | null {
    if (!this.mineBound) return null;
    return findBoardObject([...this.ctx.scene.objects, ...this.ctx.spawned]);
  }

  /** 棋盘被 bwe.mine.set() 真正用起来之后才接管绘制与点击，否则不动场景。 */
  private mineActive(): boolean {
    const api = (this as unknown as { bwe?: { mine?: { __board?: () => unknown } } }).bwe;
    const board = api?.mine?.__board?.();
    return !!board;
  }

  private routeMineClick(hit: { x: number; y: number; button: number }): void {
    const api = (this as unknown as { bwe?: { mine?: { __board?: () => unknown } } }).bwe;
    const board = api?.mine?.__board?.();
    if (!board) return;
    this.mineBound = true;
    dispatchMineClick(board as never, this.mineObject(), hit);
  }

  private paintMineIfActive(): void {
    const api = (this as unknown as { bwe?: { mine?: { __board?: () => unknown } } }).bwe;
    const board = api?.mine?.__board?.();
    if (!board) return;
    this.mineBound = true;
    paintMineBoard(this.renderer, board as never, this.mineObject());
  }

`;
s = s.replace(mAnchor, methods + mAnchor);

if (s === before) { console.error("no change"); process.exit(1); }
writeFileSync(p, s, "utf8");
console.log("player patched. mineimport=" + s.includes("minebind") + " route=" + s.includes("routeMineClick") + " paint=" + s.includes("paintMineIfActive"));
