import { readFileSync, writeFileSync } from "node:fs";

// ---------- renderer.ts: 新增 setTextureFromCanvas ----------
{
  const p = "web/src/webplayer/renderer.ts";
  let s = readFileSync(p, "utf8");
  const eol = s.includes("\r\n") ? "\r\n" : "\n";
  s = s.replace(/\r\n/g, "\n");
  if (!s.includes("setTextureFromCanvas")) {
    const anchor = "  hasTexture(id: string): boolean {";
    if (!s.includes(anchor)) { console.error("renderer anchor miss"); process.exit(1); }
    const add = [
      "  /**",
      "   * 用一块离屏 canvas 刷成纹理。给 bwe.mine 这类\"引擎侧自己画\"的模块用：",
      "   * 它们产出的不是资源文件，而是运行期画布。",
      "   */",
      "  setTextureFromCanvas(id: string, src: HTMLCanvasElement | OffscreenCanvas, def?: AssetDef): void {",
      "    const gl = this.gl;",
      "    let entry = this.texs.get(id);",
      "    if (!entry) {",
      "      const tex = gl.createTexture();",
      "      if (!tex) return;",
      "      gl.bindTexture(gl.TEXTURE_2D, tex);",
      "      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);",
      "      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);",
      "      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);",
      "      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);",
      "      entry = { tex, w: src.width, h: src.height, def: def || ({} as AssetDef) };",
      "      this.texs.set(id, entry);",
      "    } else {",
      "      entry.w = src.width;",
      "      entry.h = src.height;",
      "      gl.bindTexture(gl.TEXTURE_2D, entry.tex);",
      "    }",
      "    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);",
      "    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);",
      "    gl.bindTexture(gl.TEXTURE_2D, null);",
      "  }",
      "",
    ].join("\n");
    s = s.replace(anchor, add + anchor);
  }
  writeFileSync(p, s, "utf8");
  console.log("renderer patched, has setTextureFromCanvas:", s.includes("setTextureFromCanvas"));
}

// ---------- api.ts: 接入 bwe.mine ----------
{
  const p = "web/src/webplayer/api.ts";
  let s = readFileSync(p, "utf8");
  s = s.replace(/\r\n/g, "\n");
  if (s.includes('mine: mineNs')) { console.log("api already patched"); }
  else {
    // 1) import
    if (!s.includes('from "./mine"')) {
      const firstImportEnd = s.indexOf("\n", s.indexOf("import"));
      s = s.replace(/^(import[^\n]*\n)+/, (m) => m + 'import { MineBoard, type MineOptions } from "./mine";\n');
    }
    if (!s.includes('from "./mine"')) {
      // 没有 import 语句的文件：插在头部注释后
      s = 'import { MineBoard, type MineOptions } from "./mine";\n' + s;
    }

    // 2) 在 UNIMPLEMENTED 里去掉 mine
    s = s.replace(/"prefab", "pool", "save", "ui", "stick", "textinput", "mine", "spatial",/,
                  '"prefab", "pool", "save", "ui", "stick", "textinput", "spatial",');

    // 3) 插 mine 命名空间（在 UNIMPLEMENTED 段之前）
    const anchor = "  // ---------- 未实现的高级命名空间 ----------";
    if (!s.includes(anchor)) { console.error("api anchor miss"); process.exit(1); }
    const block = [
      "  // ---------- bwe.mine：引擎侧托管的扫雷板 ----------",
      "  // Java 侧棋盘、规则、绘制全在引擎里（Minesweeper.java / GridPainter.java），",
      "  // 脚本只读 state() 并下发 set()/reset()。Web 端用 mine.ts 的行为移植顶上。",
      "  let mineBoard: MineBoard | null = null;",
      "  const mineNs = {",
      "    state(): ReturnType<MineBoard[\"state\"]> {",
      "      if (!mineBoard) mineBoard = new MineBoard();",
      "      return mineBoard.state();",
      "    },",
      "    set(opts: MineOptions): ReturnType<MineBoard[\"state\"]> {",
      "      if (!mineBoard) mineBoard = new MineBoard(opts || {});",
      "      else mineBoard.configure(opts || {});",
      "      bindMineToScene();",
      "      return mineBoard.state();",
      "    },",
      "    reset(): ReturnType<MineBoard[\"state\"]> {",
      "      if (!mineBoard) mineBoard = new MineBoard();",
      "      mineBoard.reset();",
      "      return mineBoard.state();",
      "    },",
      "    /** 内部：拿到底层棋盘（给 player 的点击路由与绘制用） */",
      "    __board(): MineBoard | null { return mineBoard; },",
      "  };",
      "  (bwe as Record<string, unknown>).mine = mineNs;",
      "  report.ok.push(\"mine.state/set/reset\");",
      "",
    ].join("\n");
    s = s.replace(anchor, block + anchor);
    s = s.replace("/**\n   * 把场景对象包成 bwe.d.ts 里那个 Entity 接口。", "/**\n   * 把场景对象包成 bwe.d.ts 里那个 Entity 接口。");
  }
  writeFileSync(p, s, "utf8");
  console.log("api patched, has mineNs:", s.includes("mineNs"));
}
