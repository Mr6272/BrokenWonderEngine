import { readFileSync, writeFileSync } from "node:fs";
const p = "web/src/webplayer/player.ts";
let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const before = s;

// 右键菜单要禁掉，否则扫雷右键插旗会弹浏览器菜单
if (!s.includes('contextmenu')) {
  s = s.replace(
    '    canvas.addEventListener("pointermove", (e) => {',
    `    // 扫雷右键插旗：不禁掉浏览器右键菜单就没法玩
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointermove", (e) => {`,
  );
}

// textinput：点击先给输入框判定，被它消费就不再往下传
s = s.replace(
  `      // bwe.mine：棋盘优先消费左键/右键（Java 侧棋盘是引擎托管的，点击不经过脚本）
      this.routeMineClick({ x: w.x, y: w.y, button: e.button });`,
  `      // 顺序不能反：输入框在最上层，点它不该同时点到棋盘/场景。
      // bwe.textinput 消费了这次点击就直接 return。
      if (this.ctx.textInput && this.ctx.textInput.tryActivate(e.clientX, e.clientY)) return;
      // bwe.mine：棋盘优先消费左键/右键（Java 侧棋盘是引擎托管的，点击不经过脚本）
      this.routeMineClick({ x: w.x, y: w.y, button: e.button });`,
);

if (s === before) { console.error("no change"); process.exit(1); }
writeFileSync(p, s, "utf8");
console.log("ok ctxmenu=" + s.includes("contextmenu") + " ti=" + s.includes("tryActivate"));
