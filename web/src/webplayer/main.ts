/**
 * BWE Web 播放器 · 启动入口
 *
 * 这是导出产物的 JS 入口。index.html 只负责挂 canvas 和调这里。
 * 产物结构（导出后）：
 *   index.html
 *   player.js          <- 这个文件打包后的产物
 *   Build/boot.json
 *   Build/scene_0.json
 *   Build/scripts/*.js
 *   Build/assets/<id>/main.png
 */

import { Player } from "./player";
import type { BootManifest } from "./renderer";

interface Overlay {
  el: HTMLDivElement;
  show(msg: string, detail?: string, isError?: boolean): void;
  hide(): void;
}

function makeOverlay(): Overlay {
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed",
    "inset:0",
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "background:rgba(8,10,14,0.92)",
    "color:#e8ecf2",
    "font:14px/1.7 ui-monospace,Menlo,Consolas,monospace",
    "text-align:center",
    "padding:24px",
    "z-index:9999",
    "white-space:pre-wrap",
  ].join(";");
  document.body.appendChild(el);
  return {
    el,
    show(msg, detail, isError) {
      el.style.color = isError ? "#ff8a8a" : "#e8ecf2";
      el.textContent = detail ? `${msg}\n\n${detail}` : msg;
      el.style.display = "flex";
    },
    hide() {
      el.style.display = "none";
    },
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById("bwe-canvas") as HTMLCanvasElement | null;
  if (!canvas) {
    document.body.textContent = "导出产物缺少 #bwe-canvas，无法启动。";
    return;
  }
  const overlay = makeOverlay();
  overlay.show("正在加载…");

  // 产物根目录：player.js 同级就是 Build/
  const baseUrl = new URL("./", window.location.href).href;

  let boot: BootManifest;
  try {
    const res = await fetch(new URL("Build/boot.json", baseUrl).href);
    if (!res.ok) throw new Error("HTTP " + res.status);
    boot = (await res.json()) as BootManifest;
  } catch (e) {
    overlay.show(
      "读不到 Build/boot.json",
      "导出产物不完整，或你在用 file:// 直接打开（浏览器会拦截本地 fetch）。\n" +
        "起一个静态服务器再试：npx serve . 或 python -m http.server\n\n" +
        String(e),
      true
    );
    return;
  }

  let player: Player;
  try {
    player = new Player(canvas, boot, baseUrl);
  } catch (e) {
    overlay.show("播放器初始化失败", String(e), true);
    return;
  }

  try {
    await player.load();
  } catch (e) {
    overlay.show("加载失败", String(e), true);
    return;
  }

  overlay.hide();
  player.start();

  // 把播放器和统计挂到全局，方便调试与性能面板读取。
  const w = window as unknown as Record<string, unknown>;
  w.__bwe_player = player;
  w.__bwe_stats = player.stats;

  // 自动把窗口尺寸变化同步给画布
  const fit = () => {
    canvas.style.width = "100%";
    canvas.style.height = "100%";
  };
  fit();
  window.addEventListener("resize", fit);

  console.log(
    `[BWE/Web] 已启动：${boot.project}，${boot.assets.length} 个素材，` +
      `${boot.scripts.length} 个脚本。\n` +
      `用 __bwe_stats 看帧率，用 __bwe_report() 看哪些 API 还没实现。`
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void main());
} else {
  void main();
}
