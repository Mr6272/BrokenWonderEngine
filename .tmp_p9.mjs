import { readFileSync, writeFileSync } from "node:fs";
const p = "web/src/webplayer/player.ts";
let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const before = s;

// 1) audio 字面量补齐
s = s.replace(
  "const audio: AudioState = { ctx: null, buffers: new Map(), master: boot.masterVolume ?? 1 };",
  "const audio: AudioState = {\n      ctx: null,\n      buffers: new Map(),\n      master: boot.masterVolume ?? 1,\n      music: 1,\n      sfx: 1,\n      muted: false,\n    };",
);

// 2) canvas 字段
if (!/private canvas: HTMLCanvasElement/.test(s)) {
  s = s.replace(
    "  private renderer: Renderer;",
    "  private renderer: Renderer;\n  private canvas: HTMLCanvasElement;",
  );
}
s = s.replace("this.renderer = new Renderer(canvas);", "this.canvas = canvas;\n    this.renderer = new Renderer(canvas);");

// 3) AssetDef 类型导入
if (!/AssetDef/.test(s.split("\n").slice(0, 30).join("\n"))) {
  s = s.replace(
    'import { Renderer, sortForDraw, type BootManifest, type SceneObject } from "./renderer";',
    'import { Renderer, sortForDraw, type AssetDef, type BootManifest, type SceneObject } from "./renderer";',
  );
}

// 4) 修掉错位的缩进
s = s.replace("\n    canvas: this.canvas,", "\n      canvas: this.canvas,");

if (s === before) { console.error("no change"); process.exit(1); }
writeFileSync(p, s, "utf8");
console.log("ok canvasField=" + /private canvas: HTMLCanvasElement/.test(s) + " assetDef=" + /type AssetDef/.test(s));
