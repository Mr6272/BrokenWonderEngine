#!/usr/bin/env node
/**
 * 编辑器「用户报的 4 个 bug」的真机验收（真 Electron / 真 store / 真画布像素）。
 *
 * ## 为什么必须真机
 *
 * 这四条都不是纯函数错误，而是**接线与几何**错了：
 *   ① 一次拖放被处理 N 次 —— 监听器挂在常驻 DOM 节点上，单看 `importSequenceSet()`
 *      永远正确，只有真的往那个 host 上派发 drop 才能看见"进了三份"；
 *   ② 运行时视口没画在画布上 —— 只能看像素，`store.showViewport === true` 证明不了屏幕上有一块框；
 *   ③ 黄色虚线画在错误位置 —— 原来用世界原点算矩形，截图取样才看得出它贴在地图左上角；
 *   ④ F / 双击不聚焦 —— 只有真的按键、真的双击，才能区分"代码存在"和"接线通了"。
 *
 * 单测能证明的只是"每块砖是对的"，这四条是"墙砌歪了"。
 *
 * ## 覆盖的 bug 与判据
 *
 * | # | 用户原话 | 本脚本的量化证据 |
 * |---|---------|-----------------|
 * | ① | 拖入一组素材会变成三组；物体拖入会指数级被复制 | 每轮 drop 的素材/对象**增量必须 = 1**，且不随轮次增长（旧实现 3 → 7 → 16）；同组素材/单张图重复拖入增量为 0 |
 * | ② | 视口（运行时 1280×720 那块范围）没显示在画布上 | 画布上存在青色虚线框，包围盒 ≈ `worldToScreen(runtimeViewRect())`，框线上方有标签像素；关掉 `store.showViewport` 后青色像素归零 |
 * | ③ | 黄色虚线出现在错误的位置 | 黄色（碰撞体框）包围盒 ≈ **选中对象**的屏幕矩形；以世界原点为心的旧矩形里黄色像素 = 0（反向判据） |
 * | ④ | 点击物体不能切换到聚焦 | 选中后按 F / 双击对象：`camX/camY` = 对象中心、`zoom` = focusRect 公式值；无选中时 F 仍 = `zoomToFit()` |
 *
 * 第 5 条（脚本公开字段）由另一条实现线负责，本脚本只留骨架（`scriptParams.skipped`），
 * **不参与 pass/fail** —— 拿别人的未完成状态判红会制造噪音。
 *
 * ## 判据为什么用「通道关系」而不是固定 rgb
 *
 * 两条虚线都是半透明描边：落屏颜色 = 前景 × alpha + 底色 × (1-alpha)，随主题整体偏移
 * （奶油底 `#f1ece1` / 深夜底 `#15171d`）。所以判据写成"通道之间的关系"
 * （青色 b、g 远高于 r 且 g≈b；黄色 r 远高于 b、g 明显高于 b），对主题稳定。
 * 同一份规则既用于画布取样也用于 PNG 截图取样 —— 写两遍必然漂移。
 *
 * ## 跑法
 *
 *   node desktop/tools/verify-editor-bugs.mjs                 # 真机跑 + 落盘证据
 *   npm run verify:editor-bugs
 *
 * 产物：
 *   .tmp_ui/editor-bugs.json    探针原始数据（含每轮增量、包围盒、相机数值）
 *   .tmp_ui/editor-bugs.png     终态截图（青色视口框 + 黄色碰撞体框同屏）
 *   .tmp_ui/editor-bugs-run/    隔离 userData 与本次的探针副本
 *
 * 退出码：0 全通过；1 有断言失败；2 前置条件不满足（缺 Electron / 缺探针 / 构建产物缺失）。
 *
 * ## 已知偶发：`Electron 正常退出（exit=null）`
 *
 * 本机的 Chromium 偶发在窗口刚显示时被外部打断（杀软扫描 / 另一个 Electron 验收在
 * 并发跑），表现为子进程 `close` 事件的 code 为 null 且全无输出 —— 探针根本没跑。
 * 这不是产品缺陷，也不是断言口径问题。
 * 判读办法：这条红了**且**"生成了探针结果 JSON"也红，就是这类外部打断
 * （真失败时结果 JSON 通常是有的，只是断言红）；重跑一次即可。
 * 本脚本不做自动重试：自动重试会把"真的每次都挂"掩盖成偶尔红，
 * 反而更难发现。连续 3 次都是同一条则按真实缺陷排查。
 *
 * ## 不会写脏仓库
 *
 * 全程只改内存里的 store：不按 Ctrl+S、不调保存、不碰 `web/examples/*.bwproj`。
 * 同时用 `--user-data` 指向 `.tmp_ui/editor-bugs-run/ud-*`，连 IndexedDB 自动保存
 * 也落在隔离目录里（`startAutoSave()` 30s 一次，长跑时确实会触发）。
 * 探针退出前还会把 `store.dirty` 抹成 false 作双保险。
 *
 * 对照实验（2026-11-22）：对 `web/examples/开放世界城市.bwproj` 跑两遍本脚本，
 * md5 与 mtime 均无变化 ⇒ 本脚本不写它。
 * 那份文件真正的 churn 来源是 **`verify:openworld`**：它每次都重新执行
 * `web/tools/gen-city.ts`，而生成器用 `uid()` 现生成全场景 id，
 * 于是每次 `verify:all` 都产出一份「语义完全相同、id 全变」的 5000 行 diff。
 * 已用「把所有 UUID 归一成占位符后逐字节比对」证明这一点（归一后完全相等）。
 * 要消掉这份噪音，应让生成器用确定性 id 或在 CI 里跳过 `verify:openworld` 的产物写回，
 * 那是生成器的责任，不是本验收脚本的。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng } from "../lib/png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const ELECTRON = join(REPO, "desktop", "vendor", "electron", process.platform === "win32" ? "electron.exe" : "electron");
const MAIN = join(REPO, "desktop", "main.mjs");
const PROBE_SRC = join(HERE, "probes", "editor-bugs.probe.js");
const WEB_INDEX = join(REPO, "web", "index.html");
const BUNDLE = join(REPO, "web", "dist", "studio.js");

/**
 * 产物目录必须自独占（见 verify-playtest.mjs 的踩坑注释：共用 .tmp_ai 之类
 * 会被并发跑的其他 Electron 验收清掉，表现为"单跑全过、并发报 0 项"）。
 */
const OUT_DIR = join(REPO, ".tmp_ui", "editor-bugs-run");
const JSON_PATH = join(REPO, ".tmp_ui", "editor-bugs.json");
const SHOT_PATH = join(REPO, ".tmp_ui", "editor-bugs.png");

let pass = 0;
let fail = 0;
const failures = [];

/** 断言。条件在前，名字必须是字符串（参数写反 = 确定性假绿）。 */
function check(cond, name, detail) {
  if (typeof name !== "string") {
    throw new TypeError(`断言名必须是字符串（参数顺序写反了？）：${String(name)}`);
  }
  if (cond === true) {
    pass++;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(name + (detail ? `（${detail}）` : ""));
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const round1 = (v) => Math.round(Number(v) * 10) / 10;
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

/**
 * 颜色判据（唯一一份，注入给探针复用）。
 *
 * 形态：{ 量: [比较符, 阈值] }，量取自 { r, g, b, g-r, b-r, g-b, r-b }。
 * 阈值说明：
 *   - 青色 `rgba(86,214,255)` 描边 0.7、四角 0.95：奶油底上落屏约 (137,228,255)；
 *     深夜底上约 (74,180,214)。两者都满足 b≥150、g-r≥55（前者 91，后者 106）。
 *     `g-b>=-70` 是为了容下深色底上 g(180) 与 b(214) 的差，同时排除纯蓝（g≈0）。
 *   - 黄色 `rgba(240,169,43)` 半透明叠底：奶油底上约 (233,172,88)、深夜底上约 (177,129,45)。
 *     深夜底的 r 只有 177，所以 r≥170 而不是 200；`r-b≥90` 与 `g-b≥40` 一起把
 *     "奶油底本身"（241,236,225 → r-b=16、g-b=11）排除掉。
 */
const COLOR_SPEC = {
  cyan: { b: [">=", 150], "g-r": [">=", 55], "g-b": [">=", -70] },
  yellow: { r: [">=", 170], "r-b": [">=", 90], "g-b": [">=", 40] }
};

function runElectron({ userDataDir, probeScript, probeOut, probeShot }) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    // ⚠ 必须是 delete 而不是置空：Electron 判断的是变量是否存在（见 desktop/main.mjs 头注释）
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      ELECTRON,
      [
        MAIN,
        `--user-data=${userDataDir}`,
        `--e2e-script=${probeScript}`,
        `--e2e-out=${probeOut}`,
        `--e2e-shot=${probeShot}`,
        "--size=1600x1000",
        "--console"
      ],
      { cwd: REPO, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    child.stdout.on("data", (d) => (output += d.toString("utf8")));
    child.stderr.on("data", (d) => (output += d.toString("utf8")));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 超时只是兜底：断言会因缺结果而红 */
      }
    }, 240000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output });
    });
  });
}

/**
 * 在 PNG 里取样：命中某判据的像素包围盒 + 某矩形内的命中数。
 *
 * `exclude` 是**必须**的能力，不是可选项：画布上有两个 DOM 浮层
 * （`.canvas-hud.tl` 坐标、`.canvas-hud.tr` 缩放），它们是暖色文字 + 半透明底，
 * 落屏值约 `223,166,64` —— 正好命中"黄色"判据。它们是 DOM，不属于画布像素，
 * 画布侧 `getImageData` 看不到（所以画布侧 count=66 恰好只有碰撞体框），
 * 但截图是**整窗合成**，会一起拍进去。不挖掉它们，黄色包围盒会被拉偏 200 多像素，
 * 断言就以"位置不对"的形式假红，而产品其实是对的。
 */
function samplePng(img, match, region, exclude) {
  const { width, height, rgba } = img;
  const x0 = Math.max(0, Math.floor(region ? region.x : 0));
  const y0 = Math.max(0, Math.floor(region ? region.y : 0));
  const x1 = Math.min(width - 1, Math.ceil(region ? region.x + region.w : width));
  const y1 = Math.min(height - 1, Math.ceil(region ? region.y + region.h : height));
  const holes = Array.isArray(exclude) ? exclude : [];
  let count = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let inHole = false;
      for (let h = 0; h < holes.length; h++) {
        const e = holes[h];
        if (x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h) {
          inHole = true;
          break;
        }
      }
      if (inHole) continue;
      const i = (y * width + x) * 4;
      if (!match(rgba[i], rgba[i + 1], rgba[i + 2])) continue;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!count) return { count: 0, bbox: null };
  return { count, bbox: { x: minX, y: minY, x2: maxX, y2: maxY, w: maxX - minX, h: maxY - minY } };
}

function compileMatcher(spec, name) {
  const OPS = {
    ">=": (a, b) => a >= b,
    "<=": (a, b) => a <= b,
    ">": (a, b) => a > b,
    "<": (a, b) => a < b
  };
  const rule = spec[name] || {};
  const keys = Object.keys(rule);
  return (r, g, b) => {
    const d = { r, g, b, "g-r": g - r, "b-r": b - r, "g-b": g - b, "r-b": r - b };
    for (const k of keys) {
      const pair = rule[k];
      if (!OPS[pair[0]](d[k], pair[1])) return false;
    }
    return true;
  };
}

async function main() {
  if (!existsSync(ELECTRON)) {
    console.error(`[verify-editor-bugs] 缺少 Electron：${ELECTRON}\n  先运行 node desktop/tools/fetch-electron.mjs`);
    return 2;
  }
  if (!existsSync(PROBE_SRC)) {
    console.error(`[verify-editor-bugs] 缺少探针：${PROBE_SRC}`);
    return 2;
  }
  if (!existsSync(MAIN)) {
    console.error(`[verify-editor-bugs] 缺少主进程入口：${MAIN}`);
    return 2;
  }
  if (!existsSync(WEB_INDEX) || !existsSync(BUNDLE)) {
    console.error(
      `[verify-editor-bugs] 缺少渲染侧构建产物。\n  先运行 npm run build\n`
      + `  需要：${WEB_INDEX}\n        ${BUNDLE}`
    );
    return 2;
  }

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(dirname(JSON_PATH), { recursive: true });
  const stamp = Date.now().toString(36);
  const userDataDir = join(OUT_DIR, `ud-${stamp}`);
  const probeScript = join(OUT_DIR, `probe-${stamp}.js`);
  const probeOut = join(OUT_DIR, `out-${stamp}.json`);
  mkdirSync(userDataDir, { recursive: true });

  // 注入颜色判据：探针里 `typeof COLOR_SPEC !== "undefined"` 读的就是这一行。
  // 为什么注入而不是在探针里写死：同一份判据也要给下面的 PNG 取样用，
  // 两处各写一遍必然漂移，而漂移一次的后果就是"测试绿了、屏幕上是错的"。
  const probeCode = `const COLOR_SPEC = ${JSON.stringify(COLOR_SPEC)};\n` + readFileSync(PROBE_SRC, "utf8");
  writeFileSync(probeScript, probeCode, "utf8");

  console.log("== 编辑器 4 个用户报 bug 的真机验收（真 Electron / 真 store / 真画布像素）==");
  console.log(`   窗口 1600x1000（dpr 锁 1）· 隔离 userData ${userDataDir}`);
  const { code, output } = await runElectron({ userDataDir, probeScript, probeOut, probeShot: SHOT_PATH });
  check(code === 0, `Electron 正常退出`, `exit=${code}`);

  if (!existsSync(probeOut)) {
    check(false, "生成了探针结果 JSON");
    console.log("--- Electron 输出（尾部） ---");
    console.log(output.slice(-3000));
    return summarize();
  }
  let data;
  try {
    data = JSON.parse(readFileSync(probeOut, "utf8"));
  } catch (e) {
    check(false, "探针结果 JSON 可解析", String(e));
    console.log(output.slice(-2000));
    return summarize();
  }

  // 导出证据（即使后面有断言红，JSON 也先落盘 —— 排查靠它）
  writeFileSync(JSON_PATH, JSON.stringify(data, null, 2), "utf8");

  // ---------------- 运行时错误：任何一条都算失败 ----------------
  const errors = Array.isArray(data.errors) ? data.errors : [];
  const timeouts = Array.isArray(data.timeouts) ? data.timeouts : [];
  check(errors.length === 0, "全程没有 window.onerror / console.error", errors.length ? errors[0].slice(0, 160) : "无");
  check(timeouts.length === 0, "全程没有等待超时（探针没有靠 sleep 赌时序）", timeouts.length ? timeouts.join(", ") : "无");
  const boot = data.boot || {};
  check(
    boot.canvas && boot.canvas.w >= 400 && boot.canvas.h >= 300,
    "画布尺寸正常（取样可信）",
    boot.canvas ? `${boot.canvas.w}×${boot.canvas.h}` : "缺 boot.canvas"
  );

  // ---------------- ① 拖放：一次 drop 只能处理一次 ----------------
  console.log("\n-- ① 拖放只处理一次（增量必须恒为 1 / 0，且不随轮次增长）--");
  const drops = data.drops || {};
  const panelRounds = Array.isArray(drops.panelRounds) ? drops.panelRounds : [];
  check(panelRounds.length >= 4, "素材面板拖放跑了 ≥4 轮（覆盖「重画后是否累积」）", `${panelRounds.length} 轮`);
  const panelAdded = panelRounds.map((r) => r.added);
  check(
    panelRounds.length > 0 && panelAdded.every((n) => n === 1),
    "★ 每轮一次 drop 只新增 1 条素材（一组两帧合成一条序列帧）",
    `各轮增量 [${panelAdded.join(", ")}]`
  );
  // 最关键的一条：增量不能随轮次增长。旧实现是 3 → 7 → 16（监听器累积）
  const grows = panelAdded.some((n, i) => i > 0 && n > panelAdded[0]);
  check(!grows, "★ 增量不随轮次增长（旧 bug：3 → 7 → 16 的指数膨胀）", `各轮增量 [${panelAdded.join(", ")}]`);

  const sameGroup = Array.isArray(drops.sameGroupRepeats) ? drops.sameGroupRepeats : [];
  const sameAdded = sameGroup.map((r) => r.added);
  check(
    sameGroup.length >= 3 && sameAdded.every((n) => n === 0),
    "★ 同一组素材重复拖入 → 全部判重跳过（增量 0）",
    `各轮增量 [${sameAdded.join(", ")}]`
  );
  const singleImg = Array.isArray(drops.singleImageRepeats) ? drops.singleImageRepeats : [];
  const singleAdded = singleImg.map((r) => r.added);
  check(
    singleImg.length >= 2 && singleAdded[0] === 1 && singleAdded.slice(1).every((n) => n === 0),
    "★ 单张图首次导入 1 条、重复拖入 0 条（判重按 文件名 + kind，不只认 SEQUENCE）",
    `各轮增量 [${singleAdded.join(", ")}]`
  );

  const canvasRounds = Array.isArray(drops.canvasRounds) ? drops.canvasRounds : [];
  const canvasAdded = canvasRounds.map((r) => r.added);
  check(canvasRounds.length >= 4, "素材拖到画布跑了 ≥4 轮", `${canvasRounds.length} 轮`);
  check(
    canvasRounds.length > 0 && canvasAdded.every((n) => n === 1),
    "★ 每次把素材拖到画布只新建 1 个对象（「物体被指数级复制」）",
    `各轮增量 [${canvasAdded.join(", ")}]`
  );
  check(
    !canvasAdded.some((n, i) => i > 0 && n > canvasAdded[0]),
    "★ 画布落物的增量不随轮次增长",
    `各轮增量 [${canvasAdded.join(", ")}]`
  );

  // ---------------- ② 运行时视口框 ----------------
  console.log("\n-- ② 运行时视口（1280×720）必须画在画布里 --");
  const vp = data.viewport || {};
  check(vp.showViewport === true, "store.showViewport 默认 = true", String(vp.showViewport));
  const vpOn = vp.on || {};
  check(!vp.sampleError, "画布像素可读（getImageData 未被污染）", vp.sampleError || "可读");
  check(
    typeof vpOn.count === "number" && vpOn.count > 200,
    "★ 画布上有青色视口框像素",
    `${vpOn.count ?? 0} 像素`
  );
  const cv = vp.coverage || {};
  const covOf = (k) => (typeof cv[k] === "number" ? cv[k] : -1);
  check(
    ["left", "right", "top", "bottom"].every((k) => covOf(k) >= 0.25),
    "★ 四条边都覆盖到（虚线断续，覆盖率 ≥25% 即「线真的画了」）",
    `L ${(covOf("left") * 100).toFixed(0)}% / R ${(covOf("right") * 100).toFixed(0)}% / `
      + `T ${(covOf("top") * 100).toFixed(0)}% / B ${(covOf("bottom") * 100).toFixed(0)}%`
  );
  const vpBox = vpOn.bbox || {};
  const vpExp = vp.expected || {};
  const dL = vpBox.x - vpExp.x;
  const dR = vpBox.x2 - vpExp.x2;
  const dB = vpBox.y2 - vpExp.y2;
  check(
    near(dL, 0, 6) && near(dR, 0, 6) && near(dB, 0, 6),
    "★ 视口框的包围盒与 runtimeViewRect() 的世界坐标换算一致（±6px）",
    `左 ${round1(dL)} / 右 ${round1(dR)} / 下 ${round1(dB)}（期望 ${round1(vpExp.w)}×${round1(vpExp.h)}）`
  );
  check(
    typeof vp.labelPixelsAboveTopEdge === "number" && vp.labelPixelsAboveTopEdge > 15,
    "★ 框线上方有标签像素（「1280 × 720 窗口/视口 …」那一行真的画出来了）",
    `${vp.labelPixelsAboveTopEdge ?? 0} 像素`
  );
  const vpOff = vp.off || {};
  check(
    typeof vpOff.count === "number" && vpOff.count === 0,
    "★ 关掉 store.showViewport 后青色像素归零（反向判据：取样命中的确实是这个图层）",
    `关后 ${vpOff.count ?? "?"} 像素`
  );

  // ---------------- ③ 黄色虚线（碰撞体框）位置 ----------------
  console.log("\n-- ③ 黄色虚线（碰撞体框）必须围住选中对象 --");
  const col = data.collider || {};
  const colSample = col.sample || {};
  check(!col.sampleError, "画布像素可读", col.sampleError || "可读");
  check(
    typeof colSample.count === "number" && colSample.count > 60,
    "★ 画布上有黄色虚线像素（选中对象的碰撞体框）",
    `${colSample.count ?? 0} 像素`
  );
  /**
   * 四边判据用「数虚线段数」而不是「像素覆盖率」。
   *
   * 覆盖率在这里天生就低：碰撞体框是 `setLineDash([3,3])` + `lineWidth 1.2` +
   * `strokeRect(x+0.5)`，1px 采样带里只有实线段中心的像素能达到颜色阈值，
   * 虚线本身一半是空隙，抗锯齿再把边缘线稀释一遍 —— 实测四边稳定在 24%
   * （这不是缺陷，是这种画法的必然结果）。用 25% 当门槛等于给一个**永远够不着**
   * 的阈值，红了也说明不了任何事。
   *
   * 改成沿每条边在 ±2px 窄带里扫一遍、数"命中像素的连续段数"：
   * 虚线 [3,3] 沿 55~82px 的边约能数出 8~10 段，而"这条边没画"就是 0 段。
   * 它对 dash 比例、线宽、抗锯齿都不敏感 —— 这才是"边真的画了"的判据。
   * 覆盖率仍然输出在 `collider.coverage` 里当参考值。
   */
  const cEdge = col.edges || {};
  const cRuns = (k) => (cEdge[k] && typeof cEdge[k].runs === "number" ? cEdge[k].runs : -1);
  check(
    ["left", "right", "top", "bottom"].every((k) => cRuns(k) >= 3),
    "★ 碰撞体框四条边都画出来了（每条边 ≥3 段虚线段，对 dash 稳健）",
    `段数 L ${cRuns("left")} / R ${cRuns("right")} / T ${cRuns("top")} / B ${cRuns("bottom")}`
  );
  const cCovPct = (k) => `${(((col.coverage || {})[k] || 0) * 100).toFixed(0)}%`;
  console.log(
    `       参考（不作门槛）：覆盖率 L ${cCovPct("left")} / R ${cCovPct("right")} / `
      + `T ${cCovPct("top")} / B ${cCovPct("bottom")}`
  );
  const colBox = colSample.bbox || {};
  const colExp = col.expected || {};
  const cL = colBox.x - colExp.x;
  const cR = colBox.x2 - colExp.x2;
  const cT = colBox.y - colExp.y;
  const cB = colBox.y2 - colExp.y2;
  check(
    near(cL, 0, 6) && near(cR, 0, 6) && near(cT, 0, 6) && near(cB, 0, 6),
    "★ 碰撞体框的包围盒贴着**对象自己**的屏幕矩形（±6px）",
    `左 ${round1(cL)} / 右 ${round1(cR)} / 上 ${round1(cT)} / 下 ${round1(cB)}`
  );
  check(
    col.yellowInOriginBugRect === 0,
    "★ 反向判据：以世界原点为心的旧矩形里一个黄色像素都没有（旧 bug 的现场）",
    `旧矩形内 ${col.yellowInOriginBugRect ?? "?"} 像素`
  );
  const center = col.center || {};
  const distObj = center.sampled && center.object
    ? Math.hypot(center.sampled.x - center.object.x, center.sampled.y - center.object.y)
    : -1;
  const distOrigin = center.sampled && center.originBug
    ? Math.hypot(center.sampled.x - center.originBug.x, center.sampled.y - center.originBug.y)
    : -1;
  check(
    distObj >= 0 && distObj <= 6 && distOrigin > distObj,
    "★ 框的中心离对象中心近、离「原点矩形」远（这就是「虚线位置对不对」的直接量化）",
    `距对象 ${round1(distObj)}px · 距原点矩形 ${round1(distOrigin)}px`
  );

  // ---------------- ④ 聚焦 ----------------
  console.log("\n-- ④ F / 双击必须聚焦选中对象 --");
  const fo = data.focus || {};
  const fit = fo.fitNoSel || {};
  const fitCenter = fo.zoomToFitCenter || {};
  check(
    near(fit.camX, fitCenter.x, 1) && near(fit.camY, fitCenter.y, 1),
    "前置：无选中时视图 = zoomToFit（相机在地图中心）",
    `(${round1(fit.camX)}, ${round1(fit.camY)}) vs (${round1(fitCenter.x)}, ${round1(fitCenter.y)})`
  );
  const fNo = fo.fNoSel || {};
  check(
    near(fNo.zoom, fit.zoom, 0.001) && near(fNo.camX, fit.camX, 1),
    "★ 无选中按 F 仍 = 缩放到整张地图（旧肌肉记忆没被破坏）",
    `zoom ${round1(fNo.zoom)} vs ${round1(fit.zoom)}`
  );
  const fSel = fo.fSel || {};
  const expCam = fo.expectCam || {};
  check(
    near(fSel.camX, expCam.x, 1) && near(fSel.camY, expCam.y, 1),
    "★ 选中后按 F：相机中心 = 对象中心（这就是「把视图对上去」）",
    `(${round1(fSel.camX)}, ${round1(fSel.camY)}) vs (${expCam.x}, ${expCam.y})`
  );
  check(
    near(fSel.zoom, fo.expectFocusZoom, 0.02),
    "★ 选中后按 F：zoom = focusRect 公式值（框住对象，留 20% 边距）",
    `${round1(fSel.zoom)} vs ${round1(fo.expectFocusZoom)}`
  );
  check(
    fSel.zoom > fit.zoom,
    "★ 选中后按 F 的 zoom 比全图机位更近（对象真的被放大了，而不是「越按越看不见」）",
    `${round1(fSel.zoom)} > ${round1(fit.zoom)}`
  );
  const dbl = fo.dbl || {};
  check(
    dbl.selectedSingle === true,
    "双击对象会选中它",
    `selection=${dbl.selectedSingle}`
  );
  check(
    near(dbl.camX, expCam.x, 1) && near(dbl.camY, expCam.y, 1) && near(dbl.zoom, fo.expectFocusZoom, 0.02),
    "★ 画布上双击对象 = 同一套聚焦（相机与 zoom 都与 F 一致）",
    `cam (${round1(dbl.camX)}, ${round1(dbl.camY)}) zoom ${round1(dbl.zoom)}`
  );

  // ---------------- ⑤ 公开字段：骨架，不判定 ----------------
  const sp = data.scriptParams || {};
  console.log("\n-- ⑤ 脚本公开字段（骨架，不参与 pass/fail）--");
  console.log(`  skip ${sp.note || "由另一条实现线负责"}`);
  console.log(`       记录：面板锚点=${Boolean(sp.inspectorHasParamsAnchor)} · bwe.params=${Boolean(sp.bweParamsInEditor)}`);

  // ---------------- PNG 截图取样（独立于画布取样的第二证据） ----------------
  console.log("\n-- 截图取样（PNG，独立于画布 getImageData 的第二证据）--");
  check(existsSync(SHOT_PATH), "截到了图", SHOT_PATH);
  if (existsSync(SHOT_PATH)) {
    let img = null;
    try {
      img = decodePng(readFileSync(SHOT_PATH));
    } catch (e) {
      check(false, "截图可解码", String(e));
    }
    if (img) {
      check(img.width >= 1200 && img.height >= 800, "截图尺寸正常", `${img.width}×${img.height}`);
      const shot = data.shot || {};
      const cb = shot.canvas || {};
      /** 画布局部坐标 → PNG 坐标 */
      const toPng = (r) => ({ x: (r.x || 0) + (cb.left || 0), y: (r.y || 0) + (cb.top || 0), w: r.w, h: r.h });
      const canvasRegion = { x: cb.left || 0, y: cb.top || 0, w: cb.w || img.width, h: cb.h || img.height };
      const isCyan = compileMatcher(COLOR_SPEC, "cyan");
      const isYellow = compileMatcher(COLOR_SPEC, "yellow");
      /**
       * 画布上的 DOM 浮层矩形（画布局部坐标 → PNG 坐标，外扩 4px）。
       *
       * 它们**不是画布像素**（画布侧 getImageData 看不到，所以那边 count 恰好只有框本身），
       * 但截图是**整窗合成**，会一起拍进去。而且 `.canvas-hud.tl` 是暖色文字 + 半透明底，
       * 落屏值约 `223,166,64`，正好命中"黄色"判据 —— 不挖掉它，黄色包围盒会被拽到
       * 画布左上角，中心偏 (-218,-138)，看起来像"虚线画错位置"，其实产品是对的。
       * 探针在 `shot.hudRects` 里把这些矩形报出来，这里逐块挖掉。
       */
      const hudHoles = (Array.isArray(shot.hudRects) ? shot.hudRects : []).map((r) => ({
        x: r.x + (cb.left || 0) - 4,
        y: r.y + (cb.top || 0) - 4,
        w: r.w + 8,
        h: r.h + 8
      }));

      const cyanAll = samplePng(img, isCyan, canvasRegion, hudHoles);
      check(
        cyanAll.count > 200,
        "★ 截图（整窗）里画布区域有青色像素 —— 视口框真的出现在屏幕上",
        `${cyanAll.count} 像素`
      );
      // 只要终态截图里视口框存在，就再判一次"框落在哪"：和世界坐标换算的期望矩形对得上
      const expVp = toPng(shot.expectedViewport || {});
      if (expVp.w > 0) {
        /**
         * ⚠ 取样窗口要按 ±24 扩，不能只扩 8。
         *
         * 视口框**上方那行标签**（`1280 × 720 窗口 · …`）也是同一套青色
         * （`rgba(120,224,255,0.98)`），而它画在框线上方 6~15px 处
         * （`viewport.labelPixelsAboveTopEdge` 就是这个量，实测 ~1000 像素）。
         * 只扩 8 的话标签有一半落在窗口外，ratio 被天然拉到 67.6% ——
         * 那是**取样口径**的假红，不是框画歪了（框本身的 bboxDelta ≤1.5px）。
         * 实测按 ±24 取样后 ratio = 100.0%。
         */
        const PAD = 24;
        const inside = samplePng(img, isCyan, {
          x: expVp.x - PAD,
          y: expVp.y - PAD,
          w: expVp.w + PAD * 2,
          h: expVp.h + PAD * 2
        }, hudHoles);
        check(
          cyanAll.count > 0 && inside.count / cyanAll.count > 0.9,
          "★ 截图里的青色像素 ≥90% 落在期望视口矩形附近（位置对得上，不只是「有青色」）",
          `${((inside.count / Math.max(1, cyanAll.count)) * 100).toFixed(1)}%`
        );
        // 反向判据：期望矩形之外不该有成片青色（证明框没有被画到别处去）
        check(
          cyanAll.count - inside.count < cyanAll.count * 0.1,
          "★ 反向判据：期望视口矩形之外的青色像素 <10%",
          `框外 ${cyanAll.count - inside.count} / ${cyanAll.count} 像素`
        );
      }
      const yellowAll = samplePng(img, isYellow, canvasRegion, hudHoles);
      check(
        yellowAll.count > 40,
        "★ 截图里画布区域有黄色像素 —— 碰撞体虚线真的出现在屏幕上",
        `${yellowAll.count} 像素`
      );
      const expCol = toPng(shot.expectedCollider || {});
      if (expCol.w > 0) {
        /**
         * ⚠ 黄色只能在**对象邻域**里取样，不能用整块画布的包围盒。
         *
         * 画布左上角有 `.canvas-hud.tl` 那个 HUD 标签（颜色 `223,166,64`），
         * 正好落在 yellow 的判据里（r-b≥90 是设计给 `#f0a92b` 的，那个 HUD 也满足）。
         * 用整画布的包围盒时，HUD 把左/上边界拽到画布角落，中心自然偏 (-218,-138) ——
         * 又是**取样口径**的假红：这类 HUD 属于界面文字，不是"碰撞体虚线"。
         *
         * 改成只在实际绘制对象的邻域取样（外扩 12px）。这同时让断言更严格：
         * 它证明的是"这个对象的黄框中心 = 这个对象的中心"，正是用户报的那件事。
         * 实测邻域内 83 像素、中心偏差 (0.5, 0)px。
         */
        const PAD = 12;
        // ⚠ 别把这个局部变量叫 `near`：会遮蔽上面那个 near(a,b,tol) 数值比较函数，
        // 于是下一行的 near(dx, 0, 8) 变成"拿对象当函数调" —— 语法检查照过，
        // 只有真跑到这里才 TypeError。改名成 yellowNear。
        const yellowNear = samplePng(img, isYellow, {
          x: expCol.x - PAD,
          y: expCol.y - PAD,
          w: expCol.w + PAD * 2,
          h: expCol.h + PAD * 2
        });
        check(
          yellowNear.count > 20,
          "★ 截图里对象邻域（±12px）有黄色虚线像素",
          `${yellowNear.count} 像素`
        );
        const yb = yellowNear.bbox;
        const cx = yb ? yb.x + yb.w / 2 : NaN;
        const cy = yb ? yb.y + yb.h / 2 : NaN;
        const dx = cx - (expCol.x + expCol.w / 2);
        const dy = cy - (expCol.y + expCol.h / 2);
        check(
          near(dx, 0, 8) && near(dy, 0, 8),
          "★ 截图中黄色包围盒的中心 = 绘制对象的中心（不是画布原点/左上角）",
          `Δ (${round1(dx)}, ${round1(dy)})`
        );
        /**
         * 反向判据（截图侧）：旧 bug 会画出的"以世界原点为中心"的框区域里必须没有黄色。
         *
         * 为什么要它：只断言"框在对象那儿"是**不够**的 —— 一个"两处都画"的实现
         * （比如新旧两段代码并存）会让中心断言照样通过。加上这条才是完整的
         * 状态迁移验证：新位置出现了 **且** 旧位置消失了。
         * 画布侧已有同样的判据（collider.yellowInOriginBugRect=0），
         * 这里在真实合成图上再验一遍 —— 画布 getImageData 看不到 DOM 浮层，
         * 截图会；两者互补才能排除"画布上没画、但屏幕上被别的东西凑出来了"。
         */
        const expOrig = toPng(shot.originBugRect || {});
        if (expOrig.w > 0) {
          const atOrigin = samplePng(img, isYellow, {
            x: expOrig.x - 4,
            y: expOrig.y - 4,
            w: expOrig.w + 8,
            h: expOrig.h + 8
          }, (Array.isArray(shot.hudRects) ? shot.hudRects : []).map((r) => ({
            x: r.x + (cb.left || 0) - 4,
            y: r.y + (cb.top || 0) - 4,
            w: r.w + 8,
            h: r.h + 8
          })));
          check(
            atOrigin.count === 0,
            "★ 截图中反向判据：旧 bug 的原点矩形里 0 个黄色像素（虚线没有画回世界原点）",
            `${atOrigin.count} 像素（已排除画布 HUD 浮层）`
          );
        }
      }
      console.log(`  截图：${SHOT_PATH}`);
    }
  }

  if (fail > 0) {
    console.log("\n--- 探针原始数据（截断 3000 字） ---");
    console.log(JSON.stringify(data, null, 2).slice(0, 3000));
  }
  return summarize();
}

function summarize() {
  console.log("\n------------------------------------");
  console.log(`证据：${JSON_PATH}`);
  console.log(`截图：${SHOT_PATH}`);
  if (fail === 0) {
    console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 0 → ALL PASS`);
    return 0;
  }
  console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 ${fail} → FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  return 1;
}

process.exitCode = await main();
