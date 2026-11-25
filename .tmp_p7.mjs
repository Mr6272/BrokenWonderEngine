import { readFileSync, writeFileSync } from "node:fs";

// ---------- api.ts: PlayerContext 补 canvas / textInput / audio.buffers / audio.ctx ----------
{
  const p = "web/src/webplayer/api.ts";
  let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const before = s;

  s = s.replace(
    `export interface PlayerContext {
  renderer: Renderer;`,
    `export interface PlayerContext {
  renderer: Renderer;
  /** 显示画布。textinput 定位与屏幕坐标换算都要它。 */
  canvas: HTMLCanvasElement;`,
  );

  s = s.replace(
    `  /** 脚本通过 bwe.world.spawn 生成的运行期对象 */
  spawned: SceneObject[];
}`,
    `  /** 脚本通过 bwe.world.spawn 生成的运行期对象 */
  spawned: SceneObject[];
  /** bwe.textinput 的宿主（api.ts 里注入，player.ts 路由点击时用） */
  textInput?: TextInputManager;
}`,
  );

  // AudioState 补 ctx / buffers
  s = s.replace(
    /export interface AudioState \{[^}]*\}/,
    `export interface AudioState {
  ctx?: AudioContext | null;
  buffers: Map<string, AudioBuffer>;
  musicVolume?: number;
  sfxVolume?: number;
  muted?: boolean;
}`,
  );

  if (s === before) { console.error("no change"); process.exit(1); }
  writeFileSync(p, s, "utf8");
  console.log("ctx ok");
}
