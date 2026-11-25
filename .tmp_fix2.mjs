import { readFileSync, writeFileSync } from "node:fs";
const p = "web/src/webplayer/player.ts";
let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const before = s;

const oldFn = s.slice(s.indexOf("  private fitCameraToScene(): void {"));
const end = oldFn.indexOf("\n  }\n") + 4;

const newFn = `  private fitCameraToScene(): void {
    if (this.cameraFitted) return;
    const sc = this.ctx.scene;
    const objs = [...sc.objects, ...this.ctx.spawned].filter(
      (o) => Math.abs(o.halfW ?? 0) > 0 && Math.abs(o.halfH ?? 0) > 0,
    );
    const W = this.renderer.gl.drawingBufferWidth;
    const H = this.renderer.gl.drawingBufferHeight;
    if (!W || !H || objs.length === 0) return;
    this.cameraFitted = true;
    const cam = this.ctx.camera;
    if (cam.zoom !== 1) return; // 脚本自己调过就不覆盖

    // 关键：内容的真实包围盒来自对象的 x/y + 半宽高，**不是** scene.width/height。
    // 这两个值在真实工程里经常对不上（扫雷工程声明 64x64，对象却铺在 2048x2048 的
    // 坐标空间里）。按 scene.width 求中心和 zoom，相机会落在内容的角落里，画面全黑。
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of objs) {
      const hw = Math.abs(o.halfW ?? 0);
      const hh = Math.abs(o.halfH ?? 0);
      const x0 = (o.x ?? 0) - hw;
      const x1 = (o.x ?? 0) + hw;
      const y0 = (o.y ?? 0) - hh;
      const y1 = (o.y ?? 0) + hh;
      if (x0 < minX) minX = x0;
      if (y0 < minY) minY = y0;
      if (x1 > maxX) maxX = x1;
      if (y1 > maxY) maxY = y1;
    }
    const cw = maxX - minX;
    const ch = maxY - minY;
    if (!(cw > 0 && ch > 0)) return;
    const z = Math.min(W / cw, H / ch) * 0.98;
    if (Number.isFinite(z) && z > 0) cam.zoom = z;
    cam.x = (minX + maxX) / 2;
    cam.y = (minY + maxY) / 2;
  }
`;

s = s.slice(0, s.indexOf("  private fitCameraToScene(): void {")) + newFn + oldFn.slice(end);

if (s === before) { console.error("no change"); process.exit(1); }
writeFileSync(p, s, "utf8");
console.log("camera fit rewritten from content bounds");
