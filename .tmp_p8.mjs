import { readFileSync, writeFileSync } from "node:fs";

// 1) AudioState: 保留 master
{
  const p = "web/src/webplayer/api.ts";
  let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  s = s.replace(
    `export interface AudioState {
  ctx?: AudioContext | null;
  buffers: Map<string, AudioBuffer>;
  musicVolume?: number;
  sfxVolume?: number;
  muted?: boolean;
}`,
    `export interface AudioState {
  ctx?: AudioContext | null;
  /** 预解码的音频数据：bwe.audio.play(id) 从这里取 */
  buffers: Map<string, AudioBuffer>;
  /** 主音量 / 音乐 / 音效，0~1 */
  master: number;
  music: number;
  sfx: number;
  muted: boolean;
}`,
  );
  writeFileSync(p, s, "utf8");
  console.log("audio iface:", s.includes("master: number"));
}

// 2) player.ts: ctx 里的 audio 形态、canvas 字段、this.isAudioAsset、AssetDef import
{
  const p = "web/src/webplayer/player.ts";
  let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const before = s;

  // AssetDef 类型导入
  if (!/import type \{[^}]*AssetDef/.test(s)) {
    s = s.replace(
      /import \{\s*paintMineBoard/,
      "import type { AssetDef } from \"./renderer\";\nimport { paintMineBoard",
    );
  }
  if (!s.includes("AssetDef")) { console.error("AssetDef import fail"); process.exit(1); }

  // ctx 字面量补 canvas
  s = s.replace(
    /    scene: \{ objects: \[\], width: 0, height: 0 \},/,
    "    scene: { objects: [], width: 0, height: 0 },\n    canvas: this.canvas,",
  );

  // isAudioAsset 调用改成 this.
  s = s.replace("if (isAudioAsset(def))", "if (this.isAudioAsset(def))");

  if (s === before) { console.error("player no change"); process.exit(1); }
  writeFileSync(p, s, "utf8");
  console.log("player ok:", s.includes("canvas: this.canvas"), s.includes("this.isAudioAsset(def)"));
}
