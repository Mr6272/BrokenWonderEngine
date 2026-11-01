// fixtures/demo-good.js —— 正常 BWE 脚本（扩展应对它报 0 条诊断）
// 只在打开 VS Code 手工验证时用；自动测试里跑的是 web/examples/*.bwproj 里的真实脚本。

var DEMO = { ready: false, frame: 0 };

function onStart(ctx) {
  DEMO.ready = true;
  bwe.log("[脚本] demo ready");
  bwe.camera.follow(ctx.self, { smooth: 0.18 });
}

function onUpdate(ctx, dt) {
  if (!DEMO.ready || !ctx.self) return;
  DEMO.frame += 1;
  if (bwe.input.pressed("Space")) {
    bwe.after(0.2, function () {
      bwe.world.spawn({ x: ctx.self.x, y: ctx.self.y, asset: "a.png", name: "bullet" });
    });
  }
  bwe.draw.text(16, 16, "FPS " + Math.round(1 / dt), { size: 12 });
}

function onSceneStart(ctx) {
  var player = bwe.world.find({ tag: "玩家" });
  bwe.every(1, function () {
    bwe.time.frame;
  });
}
