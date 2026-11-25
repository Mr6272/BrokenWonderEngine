import { readFileSync, writeFileSync } from "node:fs";

// ---- 1) player.ts: 先刷棋盘纹理，再画对象 ----
{
  const p = "web/src/webplayer/player.ts";
  let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const before = s;

  // 把绘制挪到对象循环之前（纹理必须先准备好，否则这一帧画的是上一帧的图/空图）
  s = s.replace(
    `    const objs = sortForDraw([...this.ctx.scene.objects, ...this.ctx.spawned]);`,
    `    // 棋盘必须在画对象之前刷纹理：paintMineBoard 会改 obj.assetId，
    // 放在循环后面等于永远晚一帧，首帧还会因为纹理不存在直接不画。
    this.paintMineIfActive();

    const objs = sortForDraw([...this.ctx.scene.objects, ...this.ctx.spawned]);`,
  );
  s = s.replace(
    `    this.paintMineIfActive();

    // 脚本主动绘制（bwe.draw.*）的队列，按 layer 排在场景之上。`,
    `    // 脚本主动绘制（bwe.draw.*）的队列，按 layer 排在场景之上。`,
  );

  // 自动适配相机：场景坐标和视口尺寸差太远时（64 单位的场景铺在 878px 里）会小到看不见
  if (!s.includes("fitCameraToScene")) {
    s = s.replace(
      "  private render(): void {",
      `  /**
   * 首帧把相机对到场景上。
   * 场景单位就是世界单位，和视口像素不是一回事：一个 64x64 的场景放到 878x546 的
   * 视口里，zoom=1 只会画出中间一小块，其余全黑。这里按「铺满且留一点边」求 zoom。
   * 脚本显式设过 camera.zoom 的话就不动它。
   */
  private fitCameraToScene(): void {
    if (this.cameraFitted) return;
    const sc = this.ctx.scene;
    const cam = this.ctx.camera;
    const W = this.renderer.gl.drawingBufferWidth;
    const H = this.renderer.gl.drawingBufferHeight;
    if (!sc.width || !sc.height || !W || !H) return;
    this.cameraFitted = true;
    if (cam.zoom !== 1) return; // 脚本自己调过就不覆盖
    const z = Math.min(W / sc.width, H / sc.height) * 0.95;
    if (Number.isFinite(z) && z > 0) cam.zoom = z;
    cam.x = sc.width / 2;
    cam.y = sc.height / 2;
  }

  private render(): void {`,
    );
    s = s.replace(
      "  private mineBound = false;",
      "  private mineBound = false;\n  /** 相机是否已按场景尺寸适配过一次 */\n  private cameraFitted = false;",
    );
    s = s.replace(
      "    const cam = this.ctx.camera;\n    this.renderer.beginFrame(cam.x, cam.y, cam.zoom);",
      "    this.fitCameraToScene();\n    const cam = this.ctx.camera;\n    this.renderer.beginFrame(cam.x, cam.y, cam.zoom);",
    );
  }

  if (s === before) { console.error("player no change"); process.exit(1); }
  writeFileSync(p, s, "utf8");
  console.log("player ok paintFirst=" + s.includes("// 棋盘必须在画对象之前刷纹理") + " fit=" + s.includes("fitCameraToScene"));
}

// ---- 2) renderer: preserveDrawingBuffer，让 readPixels / 截图能拿到画面 ----
{
  const p = "web/src/webplayer/renderer.ts";
  let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const before = s;
  s = s.replace(
    /getContext\("webgl2",\s*\{([^}]*)\}\)/,
    (m, inner) => `getContext("webgl2", {${inner.replace(/\s*$/, "")}, preserveDrawingBuffer: true })`,
  );
  if (s === before) {
    // 可能写法不同，直接找 getContext 行
    s = s.replace(/\.getContext\("webgl2"\)/, '.getContext("webgl2", { preserveDrawingBuffer: true })');
  }
  if (!s.includes("preserveDrawingBuffer")) { console.error("renderer ctx opts not found"); }
  writeFileSync(p, s, "utf8");
  console.log("renderer preserve=" + s.includes("preserveDrawingBuffer"));
}
