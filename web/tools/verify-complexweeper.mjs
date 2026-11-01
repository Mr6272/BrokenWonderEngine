#!/usr/bin/env node
/**
 * 复雷加殊（Complexweeper）规则交叉验证 —— Node 侧（第三方 oracle）。
 *
 * ## 它到底验证了什么
 *
 * 唯一事实来源是 `docs/complexweeper-rules.md`。规则要求「三方独立交叉验证」：
 * `test/fixtures/complexweeper.json` 由 Python 生成，Java 的 `ComplexMineRulesTest`
 * 与这个 Node 脚本各读同一份 fixtures 断言。本脚本的做法是**方案 B**：
 *
 *   1. 用 esbuild 把 `web/src/app/minigames.ts` 打成一个临时 ESM bundle（只导出规则纯函数）。
 *      浏览器试玩里真正生效的就是这些函数，因此这里跑的是**产品代码本身**，
 *      不是在 .mjs 里重抄一份规则（那种做法只能证明「两份手抄一致」，证明不了实现正确）。
 *   2. 拿 bundle 里的 `complexLabel` / `complexRatioOk` 对 fixtures 全量断言。
 *   3. 另起一套**独立实现**（本文件内的暴力求和 / 暴力 chord 判定）作为第二 oracle，
 *      与 TS 实现做随机棋盘对拍 —— 这条才是「两个实现真的相等」，而不是 fixtures 自洽。
 *   4. 顺带断言零回归口径：普通模式（雷值恒为 +1）下 `sumIm` 全 0、`sumRe === counts`。
 *   5. 结构性断言：`renderMinesweeper` 内部必须**调用**这些纯函数（防止将来有人把逻辑抄回去分叉）。
 *
 * ## 它没有验证什么（报告里必须说清）
 *
 *   - **不验证 DOM 渲染**：`draw()` 的颜色/字号/`data-n` 补丁需要真实浏览器，
 *     本脚本只断言「取色函数返回值」这一层，不保证视觉像素正确。
 *   - **不验证 Java 侧实现**：`ComplexRules.java` 与这里只靠共享 fixtures 间接对齐，
 *     没有源码级比对。「两边都过 fixtures」= 两边都符合契约，不等于逐字节相同。
 *   - **不验证随机布雷分布**：`placeMines` 依赖 DOM 闭包状态，未在此处驱动；
 *     `Math.floor(rand()*4)` 的 1/4 均匀性是规则约定，未做统计检验。
 *
 * 用法：
 *   node web/tools/verify-complexweeper.mjs          # 全量（默认）
 *   node web/tools/verify-complexweeper.mjs --keep   # 保留临时 bundle
 *
 * 退出码：0 = 全部通过；1 = 有失败项（任何一项 FAIL 都会非 0 退出）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const WEB = resolve(HERE, "..");
const SRC = resolve(WEB, "src", "app", "minigames.ts");
const FIXTURES = resolve(ROOT, "test", "fixtures", "complexweeper.json");
const TMP = resolve(WEB, ".build", "verify-complexweeper");

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    return true;
  }
  fail++;
  failures.push({ name, detail });
  console.log(`  FAIL  ${name}${detail ? "  [" + detail + "]" : ""}`);
  return false;
}

function section(title) {
  console.log(`\n${title}`);
}

/**
 * 打临时 bundle。入口只 re-export 纯规则函数，避免把整个编辑器 UI 拖进来。
 * 若 esbuild 不可用，判 FAIL 并给出可执行的修复建议 —— 绝不静默跳过。
 */
async function buildRulesModule() {
  let esbuild;
  try {
    const nodeRequire = createRequire(import.meta.url);
    esbuild = nodeRequire("esbuild");
  } catch (e) {
    throw new Error(`缺少 esbuild（${e.message}）；先跑 npm i 再重试。不能用「跳过」当通过。`);
  }
  if (!existsSync(SRC)) throw new Error(`找不到 ${SRC}`);

  mkdirSync(TMP, { recursive: true });
  const entry = join(TMP, "rules-entry.mjs");
  const outfile = join(TMP, "rules.bundle.mjs");
  const exported = [
    "complexKindValue",
    "complexSum",
    "complexLabel",
    "complexRatioOk",
    "complexAutoOpen",
    "complexChordOk",
    "complexBoardSums",
    "complexNeighborIndices"
  ];
  const lines = [];
  void lines;
  // esbuild 解析的是文件系统路径（不认 file:// URL），所以入口里用相对路径指回源码。
  const rel = relative(TMP, SRC).split(sep).join("/");
  writeFileSync(
    entry,
    `export {\n  ${exported.join(",\n  ")}\n} from ${JSON.stringify(rel)};\n`,
    "utf8"
  );

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "warning"
  });
  const mod = await import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
  for (const name of exported) {
    if (typeof mod[name] !== "function") {
      throw new Error(`bundle 里没有导出 ${name}（minigames.ts 的规则函数被改名或删掉了？）`);
    }
  }
  return { mod, exported };
}

// ---------------- 独立实现（第二 oracle） ----------------
//
// 刻意用与 TS 侧不同的写法：值直接落成复数对数组、用 Map 累加、chord 用字符串指纹比较。
// 这样「两份实现碰巧同错」的概率远低于照抄。

const KIND_TO_PAIR = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
];

function refSums(cols, rows, kinds) {
  const total = cols * rows;
  const counts = Array.from({ length: total }, () => 0);
  const sumRe = Array.from({ length: total }, () => 0);
  const sumIm = Array.from({ length: total }, () => 0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!kinds[i]) continue;
      const [re, im] = KIND_TO_PAIR[kinds[i]] ?? [0, 0];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
          const n = rr * cols + cc;
          counts[n] += 1;
          sumRe[n] += re;
          sumIm[n] += im;
        }
      }
    }
  }
  return { counts, sumRe, sumIm };
}

function refLabel(re, im) {
  const n = re * re + im * im;
  // 换一种完全平方判定：枚举 0..32 的平方表（棋盘 8 邻域最多 8 颗雷，模长上界 8）。
  const squares = [];
  for (let r = 0; r <= 64; r++) squares.push(r * r);
  const hit = squares.indexOf(n);
  if (hit >= 0) return String(hit);
  return "\u221a" + n;
}

function refRatioOk(fR, fI, aR, aI) {
  // 用通分后的互质比较，等价于交叉相乘，但写法与 TS 侧不同（两侧都过才有意义）。
  const A = fR * aI - fI * aR;
  const B = fR * aR - fI * aI;
  return A === 0 || B === 0;
}

/** 确定性伪随机（mulberry32），保证本脚本每次跑同一批用例。 */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadFixtures() {
  if (!existsSync(FIXTURES)) {
    throw new Error(`找不到 fixtures：${FIXTURES}（绝对路径已打印，不许静默跳过）`);
  }
  const raw = JSON.parse(readFileSync(FIXTURES, "utf8"));
  for (const key of ["labels", "ratios", "sums"]) {
    if (!Array.isArray(raw[key])) throw new Error(`fixtures 缺少数组字段 ${key}`);
  }
  return raw;
}

async function main() {
  console.log("复雷加殊 Complexweeper · Node 交叉验证");
  console.log(`  fixtures : ${FIXTURES}`);
  console.log(`  被测源码 : ${SRC}`);

  const fixtures = loadFixtures();
  const { mod } = await buildRulesModule();
  const sourceText = readFileSync(SRC, "utf8");

  // ---- 1. fixtures: labels ----
  section(`1) fixtures labels（${fixtures.labels.length} 条）—— 断言真实 complexLabel`);
  for (const row of fixtures.labels) {
    const got = mod.complexLabel(row.re, row.im);
    check(`label(${row.re},${row.im}) === ${JSON.stringify(row.label)}`, got === row.label,
      got === row.label ? "" : `实际 ${JSON.stringify(got)}`);
  }
  // n 字段也交叉检查：确保 fixtures 与实现都在说同一个 n。
  for (const row of fixtures.labels) {
    const n = row.re * row.re + row.im * row.im;
    check(`n(${row.re},${row.im}) === ${row.n}`, n === row.n, n === row.n ? "" : `实际 ${n}`);
  }

  // ---- 2. fixtures: ratios ----
  section(`2) fixtures ratios（${fixtures.ratios.length} 条）—— 断言真实 complexRatioOk`);
  for (const row of fixtures.ratios) {
    const got = mod.complexRatioOk(row.fR, row.fI, row.aR, row.aI);
    check(
      `ratioOk(${row.fR},${row.fI},${row.aR},${row.aI}) === ${row.ok}`,
      got === row.ok,
      got === row.ok ? "" : `实际 ${got}`
    );
  }

  // ---- 3. fixtures: sums（雷值 → 复数和的累加规则） ----
  section(`3) fixtures sums（${fixtures.sums.length} 条）—— 断言 complexSum 与 label 一致`);
  const KIND_OF = { "+1": 1, "-1": 2, "+i": 3, "-i": 4 };
  for (const row of fixtures.sums) {
    const kinds = row.mines.map((m) => KIND_OF[m]);
    for (const m of row.mines) {
      check(`雷值 ${m} 是已知编码`, typeof KIND_OF[m] === "number", KIND_OF[m] ? "" : "未知雷值");
    }
    const sum = mod.complexSum(kinds);
    check(`sum(${JSON.stringify(row.mines)}) re === ${row.re}`, sum.re === row.re,
      sum.re === row.re ? "" : `实际 ${sum.re}`);
    check(`sum(${JSON.stringify(row.mines)}) im === ${row.im}`, sum.im === row.im,
      sum.im === row.im ? "" : `实际 ${sum.im}`);
    const label = mod.complexLabel(sum.re, sum.im);
    check(`label(${JSON.stringify(row.mines)}) === ${JSON.stringify(row.label)}`, label === row.label,
      label === row.label ? "" : `实际 ${JSON.stringify(label)}`);
  }

  // ---- 4. 独立实现对拍：labels ----
  section("4) labels 独立实现对拍（re,im ∈ [-8,8] 全量 289 组）");
  for (let re = -8; re <= 8; re++) {
    for (let im = -8; im <= 8; im++) {
      const got = mod.complexLabel(re, im);
      const want = refLabel(re, im);
      check(`label(${re},${im}) 与独立实现一致`, got === want, got === want ? "" : `${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
    }
  }

  // ---- 5. 独立实现对拍：ratioOk ----
  section("5) ratioOk 独立实现对拍（fR,fI,aR,aI ∈ [0,4] 全量 625 组）");
  for (let fR = 0; fR <= 4; fR++) {
    for (let fI = 0; fI <= 4; fI++) {
      for (let aR = 0; aR <= 4; aR++) {
        for (let aI = 0; aI <= 4; aI++) {
          const got = mod.complexRatioOk(fR, fI, aR, aI);
          const want = refRatioOk(fR, fI, aR, aI);
          check(`ratioOk(${fR},${fI},${aR},${aI}) 与独立实现一致`, got === want,
            got === want ? "" : `${got} vs ${want}`);
        }
      }
    }
  }

  // 文档第 4 节的结构化推论：标满且标对必然通过。
  section("6) 文档结构化断言：标满标对必过 / 常数样例");
  for (let aR = 0; aR <= 4; aR++) {
    for (let aI = 0; aI <= 4; aI++) {
      check(`ratioOk(${aR},${aI},${aR},${aI}) === true（标满标对）`,
        mod.complexRatioOk(aR, aI, aR, aI) === true);
    }
  }
  const constCases = [
    ["label(0,0)", () => mod.complexLabel(0, 0) === "0"],
    ["label(1,0)", () => mod.complexLabel(1, 0) === "1"],
    ["label(-1,0)", () => mod.complexLabel(-1, 0) === "1"],
    ["label(0,1)", () => mod.complexLabel(0, 1) === "1"],
    ["label(1,1)", () => mod.complexLabel(1, 1) === "\u221a2"],
    ["label(3,4)", () => mod.complexLabel(3, 4) === "5"],
    ["label(2,2)", () => mod.complexLabel(2, 2) === "\u221a8"],
    ["label(0,-2)", () => mod.complexLabel(0, -2) === "2"],
    ["ratioOk(0,0,0,0)", () => mod.complexRatioOk(0, 0, 0, 0) === true],
    ["ratioOk(1,0,1,0)", () => mod.complexRatioOk(1, 0, 1, 0) === true],
    ["ratioOk(1,0,0,1)", () => mod.complexRatioOk(1, 0, 0, 1) === true],
    ["ratioOk(2,0,0,2)", () => mod.complexRatioOk(2, 0, 0, 2) === true]
  ];
  for (const [name, fn] of constCases) check(name, fn());

  // ---- 7. 棋盘求和：随机对拍 + 零回归口径 ----
  section("7) complexBoardSums 随机棋盘对拍（40 局 × 多种尺寸）");
  const rng = makeRng(0x5eed1a);
  for (let round = 0; round < 40; round++) {
    const cols = 3 + Math.floor(rng() * 18);
    const rows = 3 + Math.floor(rng() * 18);
    const total = cols * rows;
    const density = rng();
    const kinds = Array.from({ length: total }, () => (rng() < density ? 1 + Math.floor(rng() * 4) : 0));
    const got = mod.complexBoardSums(cols, rows, kinds);
    const want = refSums(cols, rows, kinds);
    const same =
      got.counts.every((v, i) => v === want.counts[i]) &&
      got.sumRe.every((v, i) => v === want.sumRe[i]) &&
      got.sumIm.every((v, i) => v === want.sumIm[i]);
    check(`${cols}x${rows} 求和与独立实现一致`, same);
  }

  section("8) 零回归口径：普通模式（雷值恒 +1）sumIm 全 0 且 sumRe === counts");
  for (let round = 0; round < 20; round++) {
    const cols = 3 + Math.floor(rng() * 18);
    const rows = 3 + Math.floor(rng() * 18);
    const total = cols * rows;
    const kinds = Array.from({ length: total }, () => (rng() < 0.18 ? 1 : 0));
    const got = mod.complexBoardSums(cols, rows, kinds);
    check(`${cols}x${rows} 普通模式 sumIm 全为 0`, got.sumIm.every((v) => v === 0));
    check(`${cols}x${rows} 普通模式 sumRe 等于 counts`, got.sumRe.every((v, i) => v === got.counts[i]));
    // 普通模式的 label 必须就是今天的那个整数字符串。
    check(
      `${cols}x${rows} 普通模式 label 就是整数串`,
      got.sumRe.every((v, i) => mod.complexLabel(v, got.sumIm[i]) === String(got.counts[i]))
    );
  }

  // ---- 9. chord：随机对拍 ----
  section("9) complexChordOk 随机对拍（2000 组邻域）");
  for (let round = 0; round < 2000; round++) {
    const n = 8;
    const kinds = Array.from({ length: n }, () => (rng() < 0.4 ? 1 + Math.floor(rng() * 4) : 0));
    const flagged = kinds.map(() => rng() < 0.5);
    const got = mod.complexChordOk(kinds.map((kind, i) => ({ kind, flagged: flagged[i] })));
    // 独立实现：先数，再两条等式。
    let fR = 0, fI = 0, aR = 0, aI = 0, fCount = 0;
    kinds.forEach((kind, i) => {
      const real = kind === 1 || kind === 2;
      const imag = kind === 3 || kind === 4;
      if (real) aR++;
      if (imag) aI++;
      if (flagged[i]) {
        fCount++;
        if (real) fR++;
        if (imag) fI++;
      }
    });
    const wantOk = fCount === aR + aI && refRatioOk(fR, fI, aR, aI);
    check(`chord #${round} ok 与独立实现一致`, got.ok === wantOk, got.ok === wantOk ? "" : `${got.ok} vs ${wantOk}`);
    check(`chord #${round} 计数一致`,
      got.flagged === fCount && got.fR === fR && got.fI === fI && got.aR === aR && got.aI === aI,
      `实际 ${JSON.stringify(got)} / 期望 flagged=${fCount} fR=${fR} fI=${fI} aR=${aR} aI=${aI}`);
  }

  // chord 的语义边界：旗数对但比例错 → 不通过；旗数错 → 不通过。
  section("10) chord 语义边界（数量对但比例错必须拒绝）");
  check("数量对+比例错 → 拒绝",
    mod.complexChordOk([
      { kind: 1, flagged: true },   // 实雷已标
      { kind: 3, flagged: false }  // 虚雷漏标（旗数 1，真实雷数 2）
    ]).ok === false);
  check("虚报一颗（数量对但标在非雷格）→ 拒绝",
    mod.complexChordOk([
      { kind: 1, flagged: true },
      { kind: 3, flagged: true },  // 实1/虚1 全标 → 应通过
      { kind: 0, flagged: true }   // 多标一颗非雷 → 数量对不上
    ]).ok === false);
  check("全部标对 → 通过",
    mod.complexChordOk([
      { kind: 1, flagged: true },
      { kind: 3, flagged: true },
      { kind: 0, flagged: false }
    ]).ok === true);
  check("周围无雷、无旗 → 通过（0==0 且比例平凡成立）",
    mod.complexChordOk([{ kind: 0, flagged: false }, { kind: 0, flagged: false }]).ok === true);
  check("只有虚雷、没插旗 → 拒绝",
    mod.complexChordOk([{ kind: 3, flagged: false }]).ok === false);
  check("±1 抵消成 0 但仍有雷 → 自动展开必须拒绝",
    mod.complexAutoOpen(0, 0) === true && mod.complexAutoOpen(1, 0) === false);
  // 文档第 5 节核心机关：+1 与 −1 相邻 sum 为 (0,0) 显示 0 —— 但那是「真没有雷」才展开；
  // 有雷抵消时 sumRe/sumIm 也是 0，所以能否展开只能由「真实雷数」判定，此处断言 label 为 0。
  check("抵消：label(+1,-1 之和) 显示 0", mod.complexLabel(0, 0) === "0");

  // ---- 11. 结构性断言：产品代码真的在用这些函数 ----
  section("11) 结构性断言：renderMinesweeper 内部必须调用共享规则函数");
  // 目的不是「比对源码文本」，而是防止有人把逻辑抄回渲染闭包里导致两条实现分叉。
  const wiring = [
    ["complexLabel", /complexLabel\s*\(/g],
    ["complexBoardSums", /complexBoardSums\s*\(/g],
    ["complexChordOk", /complexChordOk\s*\(/g],
    ["complexAutoOpen", /complexAutoOpen\s*\(/g],
    ["complexNeighborIndices", /complexNeighborIndices\s*\(/g]
  ];
  for (const [name, re] of wiring) {
    const hits = sourceText.match(re) ?? [];
    // 定义处 1 次 + 至少 1 次调用点。
    check(`${name} 有定义且至少 1 处调用`, hits.length >= 2, `命中 ${hits.length} 次`);
  }
  check("普通模式数字仍走 data-n（CSS 配色零回归）",
    /root\.dataset\.n = String\(counts\[i\]\)/.test(sourceText));
  check("模式解析口径含 复雷/complex 且忽略大小写",
    /复雷\|complex[^/]*\/i\.test/.test(sourceText) || /\/复雷\|complex\/i/.test(sourceText));
  check("普通模式不加 chord（仅在 complex 分支调用）",
    /else if \(complex && revealed\[i\]\) chord\(i\)/.test(sourceText));

  // ---- 汇总 ----
  console.log("");
  if (fail) {
    console.log(`结果：${pass} 通过 / ${fail} 失败`);
    for (const f of failures.slice(0, 20)) console.log(`  - ${f.name}${f.detail ? "  " + f.detail : ""}`);
    if (failures.length > 20) console.log(`  ...另有 ${failures.length - 20} 条失败`);
  } else {
    console.log(`结果：${pass} 通过 / 0 失败 —— 全部断言绿。`);
  }
  if (!KEEP && existsSync(TMP)) {
    // 保留也无妨，但默认清掉临时 bundle，避免污染 web/.build/。
    try {
      rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响判定 */
    }
  }
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n致命错误：${err && err.message ? err.message : err}`);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});
