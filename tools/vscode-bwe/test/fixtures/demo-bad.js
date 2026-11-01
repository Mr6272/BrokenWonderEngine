// fixtures/demo-bad.js —— 故意踩坑的 BWE 脚本（扩展应对它报 6 条诊断）
// 期望结果（打开 VS Code 手工验证；自动测试见 test/analyzer.test.mjs）：
//   L10 error   E001  import 不支持
//   L11 warning E005  setTimeout 应改 bwe.after
//   L12 error   E004  document 在运行时不存在
//   L13 warning W001  console.log 建议改 bwe.log
//   L14 warning W002  bwe.wrold 拼错 → bwe.world
//   L16 error   E006  onSceneStart 里 ctx.self 恒为 null

import x from "y";
var t = setTimeout(function () {}, 10);
document.title = "demo";
console.log("hi");
bwe.wrold.find(1);
function onSceneStart(ctx) {
  ctx.self.x = 1;
}
