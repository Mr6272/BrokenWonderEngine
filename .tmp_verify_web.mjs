import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const OUT = "web/.build/packages/web_test_1/out";
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) pass++; else { fail++; console.log("  FAIL " + n + (d ? " — " + d : "")); } };

// 1. 产物骨架
for (const f of ["index.html", "player.js", "Build/boot.json", "Build/scene_0.json"]) {
  check("存在 " + f, existsSync(`${OUT}/${f}`));
}
check("没有 Build/Build 嵌套", !existsSync(`${OUT}/Build/Build`));

// 2. player.js 真的是打包产物（应该含 WebGL 着色器与启动逻辑）
const player = await readFile(`${OUT}/player.js`, "utf8");
check("player.js 体积合理", player.length > 10000, `只有 ${player.length} 字节，esbuild 可能失败`);
check("player.js 含着色器版本声明", player.includes("#version 300 es"), "WebGL2 着色器没打进去");
check("player.js 含 WebGL2 上下文请求", player.includes("webgl2"));
check("player.js 是 IIFE 打包格式", player.includes("(()=>") || player.includes("(function"));

// 3. index.html 正确挂载
const html = await readFile(`${OUT}/index.html`, "utf8");
check("html 有 canvas", html.includes('id="bwe-canvas"'));
check("html 引入 player.js", html.includes('src="player.js"'));
check("html 标题已替换", !html.includes("__BWE_GAME_TITLE__"), "占位符没被替换");
check("html 标题是工程名", html.includes("扫雷"));

// 4. boot.json 能被播放器读懂
const boot = JSON.parse(await readFile(`${OUT}/Build/boot.json`, "utf8"));
check("boot 有 scenes", Array.isArray(boot.scenes) && boot.scenes.length > 0);
check("boot 有 assets", Array.isArray(boot.assets) && boot.assets.length > 0);
check("boot 有 scripts", Array.isArray(boot.scripts) && boot.scripts.length > 0);

// 5. boot 里引用的文件必须真的存在（这是最容易出的断链）
for (const a of boot.assets) {
  // asset.path 形如 "Build/assets/xxx/main.png"，相对的是**产物根**。
  const ok = existsSync(`${OUT}/${a.path}`);
  check(`素材文件存在 ${a.id}`, ok, "boot.json 引用了不存在的文件: " + a.path);
}
for (const s of boot.scripts) {
  check(`脚本文件存在 ${s.name}`, existsSync(`${OUT}/Build/${s.file}`), "缺: " + s.file);
}
for (const sc of boot.scenes) {
  check(`场景文件存在 ${sc.name}`, existsSync(`${OUT}/Build/${sc.file}`), "缺: " + sc.file);
}

// 6. 场景对象引用的 assetId 必须在 assets 里（否则画不出来）
const scene = JSON.parse(await readFile(`${OUT}/Build/scene_0.json`, "utf8"));
const assetIds = new Set(boot.assets.map((a) => a.id));
const missing = new Set();
for (const o of scene.objects ?? []) {
  if (o.assetId && !assetIds.has(o.assetId)) missing.add(o.assetId);
}
check("场景对象引用的素材都在清单里", missing.size === 0, "缺失: " + [...missing].join(", "));

// 7. 脚本是 ES5 可跑的
const script = await readFile(`${OUT}/Build/${boot.scripts[0].file}`, "utf8");
check("脚本非空", script.length > 1000);
check("脚本没有 ES6 箭头函数（Java 侧降级过）", !/=>/.test(script), "残留箭头函数，Rhino ES5 跑不了");

check(
  "素材 path 与场景/脚本的基准不同（asset 含 Build/ 前缀，file 不含）",
  boot.assets[0].path.startsWith("Build/") && !boot.scenes[0].file.startsWith("Build/"),
  "两套路径基准被统一了，会有一端 404"
);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
