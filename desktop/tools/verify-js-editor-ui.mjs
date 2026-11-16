/**
 * JS 编辑器增强功能的**真实端到端验收**（真 Electron / 真 store / 真 DOM）。
 *
 * 为什么不能只靠单测：`jsEditorLogic.ts` 的单测证明「查找偏移算对了」，
 * 但证明不了「查找条真的弹出来了、替换真的写回了工程、编译按钮真的连到了 /api/js-check」。
 * 本仓库出过的「提示承诺 vs 实际接线」断裂，全部只在端到端复现时才暴露
 * （本次就抓到两个：全仓库 7 处 `bwe:commit` 无人接收 → 一堆操作不可撤销；
 *  撤销后剧本编辑器不重建 → 数据回退了面板还显示改后的内容）。
 *
 * 探针脚本在 `desktop/tools/probes/js-editor-ui.probe.js`，**独立文件**。
 * 为什么不用内嵌模板字符串：内嵌时注释里的反引号会截断脚本、正则里的转义会被模板吃掉、
 * 字符串里的换行转义会变成真实换行 —— 这三类都是"不报错但结果错"的静默坑，
 * 我在这个文件里接连踩了四次。独立文件后零转义，`node --check` 也能在跑之前拦住语法错。
 *
 * 跑法：
 *   node desktop/tools/verify-js-editor-ui.mjs
 *
 * 退出码：0 通过；1 断言失败；2 前置条件不满足（缺 Electron / 缺探针文件）。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const ELECTRON = join(REPO, "desktop", "vendor", "electron", process.platform === "win32" ? "electron.exe" : "electron");
const MAIN = join(REPO, "desktop", "main.mjs");
const PROBE = join(HERE, "probes", "js-editor-ui.probe.js");
const OUT = join(REPO, ".tmp_jseditor", "verify-ui");

let pass = 0;
let fail = 0;
const results = [];

function check(cond, name, detail) {
  if (typeof name !== "string") throw new TypeError(`断言名必须是字符串（参数顺序写反了？）：${String(name)}`);
  const okFlag = cond === true;
  results.push({ name, ok: okFlag, detail: detail ?? "" });
  if (okFlag) {
    pass++;
    console.log(`  ok  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 数一份 CSS 里的规则数（去掉注释后数花括号，处理 @media 的嵌套）。 */
function countCssRules(cssText) {
  const stripped = String(cssText ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  return (stripped.match(/\{/g) || []).length;
}

function runElectron({ userDataDir, probeScript, probeOut }) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      ELECTRON,
      [MAIN, `--user-data=${userDataDir}`, `--e2e-script=${probeScript}`, `--e2e-out=${probeOut}`, "--console"],
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
    }, 180000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output });
    });
  });
}

function summarize() {
  console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==`);
  console.log(`  中间产物：${OUT}`);
  return fail === 0 ? 0 : 1;
}

async function main() {
  if (!existsSync(ELECTRON)) {
    console.error(`[verify-js-editor-ui] 缺少 Electron：${ELECTRON}\n  先运行 node desktop/tools/fetch-electron.mjs`);
    return 2;
  }
  if (!existsSync(PROBE)) {
    console.error(`[verify-js-editor-ui] 缺少探针脚本：${PROBE}`);
    return 2;
  }

  // 先把探针当普通 JS 做一次语法闸门：语法错时直接给出**具名**原因，
  // 而不是让 Electron 报一句 "Script failed to execute"（那句话不告诉你在哪一行）。
  const probeSource = readFileSync(PROBE, "utf8");
  {
    const { writeFileSync, rmSync } = await import("node:fs");
    const tmp = join(OUT, "probe-syntax-check.mjs");
    mkdirSync(OUT, { recursive: true });
    writeFileSync(tmp, probeSource, "utf8");
    const r = spawn(process.execPath, ["--check", tmp], { stdio: "pipe" });
    let err = "";
    r.stderr.on("data", (d) => (err += d.toString("utf8")));
    const code = await new Promise((res) => r.on("close", res));
    rmSync(tmp, { force: true });
    check(code === 0, "探针脚本本身语法正确（node --check）", err.split("\n").slice(0, 3).join(" "));
    if (code !== 0) return summarize();
  }

  mkdirSync(OUT, { recursive: true });
  const stamp = Date.now().toString(36);
  const userDataDir = join(OUT, `ud-${stamp}`);
  const probeScript = join(OUT, `probe-${stamp}.js`);
  const probeOut = join(OUT, `out-${stamp}.json`);
  mkdirSync(userDataDir, { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(probeScript, probeSource, "utf8");

  console.log("== JS 编辑器端到端（真 Electron / 真 store / 真 DOM）==");
  const { code, output } = await runElectron({ userDataDir, probeScript, probeOut });
  check(code === 0, `Electron 正常退出（exit=${code}）`);

  if (!existsSync(probeOut)) {
    check(false, "生成了端到端结果 JSON");
    console.log(output.slice(-3000));
    return summarize();
  }
  let data;
  try {
    data = JSON.parse(readFileSync(probeOut, "utf8"));
  } catch (e) {
    check(false, "结果 JSON 可解析", String(e));
    console.log(output.slice(-2000));
    return summarize();
  }

  // ---- ① 前提 ----
  check(data.hasLoadDemo === true, "存在载入示例工程的探针按钮");
  check(typeof data.projectName === "string" && data.projectName.length > 0, `工程已载入（${data.projectName}）`);
  check(data.hasEditor === true, "JS 编辑器渲染出来了（.js-code + textarea.js-source）");
  check((data.sourceRect?.h ?? 0) >= 240, "代码区高度 ≥ 240（不再是写死 320 的一半被挤掉）", JSON.stringify(data.sourceRect));

  // ---- ② 工具面板 ----
  check(data.hasTools === true, "下部工具面板存在（.js-tools）");
  check(Array.isArray(data.tabLabels) && data.tabLabels.length >= 5, "五个页签都在", JSON.stringify(data.tabLabels));
  check(data.hasApiPane === true, "API 速查仍挂在最后一个页签（没有丢功能）");

  // ---- ③ 大纲 ----
  check(data.hasOutlineTab === true, "有「大纲」页签");
  check((data.outlineRows ?? 0) > 0, "大纲抽出了条目", `rows=${data.outlineRows} first=${data.outlineFirst}`);
  check(typeof data.caretAfterOutlineClick === "number", "点大纲条目能移动光标", `caret=${data.caretAfterOutlineClick}`);

  // ---- ④ 查找 ----
  check(data.findbarVisible === true, "★ Ctrl+F 真的打开了查找条");
  check(data.hasFindInput === true, "查找条里有输入框");
  check(
    typeof data.findCountText === "string" && /\d/.test(data.findCountText),
    "查找计数显示了数字",
    `count=${data.findCountText} expected≈${data.expectedMatches}`
  );
  check((data.markCount ?? 0) > 0, "★ 高亮覆盖层里出现了搜索命中标记（.js-mark，搜索高亮真的画出来了）", `marks=${data.markCount}`);
  check(data.overlayVisible === true, "覆盖层不是 display:none");
  // 覆盖层与 textarea 的排版度量必须逐项一致，否则高亮整体错位（这条是硬约束，见 docs/scripting-api.md §5.1）
  check(
    Array.isArray(data.overlayMetrics?.mismatch) && data.overlayMetrics.mismatch.length === 0,
    "★ .js-hl 与 .js-source 的排版度量逐项一致（错了会整体错位）",
    data.overlayMetrics?.mismatch?.length ? `不一致项：${data.overlayMetrics.mismatch.join(",")}` : "6 项全同"
  );

  // ---- ⑤ 替换 ----
  check(data.hasReplaceInput === true, "有替换输入框");
  check(data.replaceVisible === true, "★ Ctrl+H 真的切到了替换模式", `row=${data.replaceRowDisplay} active=${JSON.stringify(data.activeBeforeCtrlH)}`);
  check(data.hasReplaceAllBtn === true, "有「全部替换」按钮");
  check((data.replacedCount ?? 0) > 0, "★ 替换真的改了 textarea 内容", `count=${data.replacedCount}`);
  check(data.storeHasReplacement === true, "★ 改动同步进了 store（不是只改了 DOM）");
  check(data.undoRestored === true, "★ 替换是一次可撤销编辑（Ctrl+Z 后编辑器文本回退）", `afterUndo 前 30 字：${String(data.textAfterUndo ?? "").slice(0, 30)}`);
  check(data.storeUndoClean === true, "★ 撤销同时回退了 store 里的源码（不是只回退 DOM）", `store 前 30 字：${String(data.storeAfterUndo ?? "").slice(0, 30)}`);

  // ---- ⑥ 编译 ----
  check(data.hasBuildTab === true, "有「编译」页签");
  check(data.hasCompileBtn === true, "编译页签里有「编译」按钮");
  if ((data.compileLen ?? 0) > 0) {
    check(true, "★ 编译产出了 ES5 代码（本地语言服务连通）", `meta=${data.compileMeta}`);
    check(data.transpiledHasArrow === false, "产物里没有箭头函数（确实降级了）");
    check(data.transpiledHasConst === false, "产物里没有 const/let（确实降级了）");
    check(data.transpiledHasTemplate === false, "产物里没有模板字符串（确实降级了）");
  } else {
    // 不假装成功：语言服务不可用时这条必须是红的，而不是"跳过"
    check(false, "编译产出了 ES5 代码（本地语言服务连通）", `state=${data.compileState} meta=${data.compileMeta}`);
  }

  // ---- ⑦ 引用 / 定义 ----
  check(typeof data.refsTitle === "string", "Shift+F12 有反馈（结果或降级说明）", `${data.refsRows} 条 · ${data.refsTitle}`);
  check(
    data.auxCollapsedAfterF12 === false,
    "★ Shift+F12 时辅助区自动展开（折叠着 = 按了没反应）",
    `collapsed=${data.auxCollapsedAfterF12} h=${data.auxHeight}`
  );
  check(data.toolsVisible === true, "工具面板在展开后真的可见（有尺寸）");
  check(
    (data.refsRows ?? 0) > 0 || /语言服务不可用/.test(String(data.refsTitle)),
    `★ 「${data.refSymbol ?? "?"}」要么查到引用/定义，要么明确说明语言服务不可用（不允许静默空着）`,
    `${data.refsRows} 条 · title=${data.refsTitle}`
  );

  // ---- ⑧ 悬浮提示 ----
  check(
    data.hoverVisible === true,
    "★ 鼠标悬停弹出类型提示（/api/script-quickinfo 连通）",
    `code=${String(data.hoverCode ?? "").slice(0, 70)}`
  );
  check(typeof data.hoverCode === "string" && data.hoverCode.length > 0, "悬浮提示里显示了签名", String(data.hoverCode ?? "").slice(0, 70));

  // ---- ⑨ 括号高亮 ----
  check((data.bracketMarks ?? 0) === 2, "★ 括号配对高亮同时标出开括号与闭括号", `marks=${data.bracketMarks}`);

  // ---- ⑨b 语法着色（结构性 + 颜色真实性）----
  //
  // 这里**不看 class 名就算过**：class 存在但 CSS 没定义对应规则时，元素上依然有那个类 ——
  // 断言 class 会绿，而屏幕是一片同色。所以要量 computed color：
  // 6 个类别必须两两不同、都不透明、都不等于默认文字色。
  {
    const kinds = ["tk-comment", "tk-string", "tk-number", "tk-keyword", "tk-bwe", "tk-global"];
    const counts = data.syntaxCounts ?? {};
    const missing = kinds.filter((k) => !(counts[k] > 0));
    check(
      missing.length === 0,
      "★ 六类语法着色都产出了元素（注释/字符串/数字/关键字/bwe/内置API）",
      missing.length ? `缺：${missing.join(",")}` : JSON.stringify(counts)
    );

    const colors = data.syntaxColors ?? {};
    const vals = kinds.map((k) => colors[k]).filter(Boolean);
    check(vals.length === kinds.length, "六类都量到了 computed color", JSON.stringify(colors));
    check(
      new Set(vals).size === kinds.length,
      "★ 六类颜色两两不同（不是『都染成同一个色』这种假通过）",
      `${new Set(vals).size} 种：${Array.from(new Set(vals)).join(" / ")}`
    );
    check(
      !vals.some((c) => /rgba\(0, 0, 0, 0\)|transparent/.test(String(c))),
      "★ 没有一类是透明的（透明 = 文字看不见）",
      vals.filter((c) => /rgba\(0, 0, 0, 0\)/.test(String(c))).join(",")
    );

    // 颜色必须来自 CSS 变量：换主题要跟着变（否则是写死的 hex，主题切换就废了）
    const vars = data.syntaxVars ?? {};
    const emptyVars = Object.entries(vars).filter(([, v]) => !v).map(([k]) => k);
    check(emptyVars.length === 0, "6 个着色变量都有值", emptyVars.join(","));
    const themes = data.syntaxThemes ?? {};
    check(
      themes["theme-cream"] && themes["theme-midnight"] && themes["theme-high-contrast"]
        && new Set(Object.values(themes)).size === 3,
      "★ 三套主题的着色不同（颜色走变量而不是写死 hex）",
      JSON.stringify(themes)
    );

    // textarea 必须透明（文字由覆盖层显示），但光标必须可见
    check(
      /rgba\(0, 0, 0, 0\)|transparent/.test(String(data.textareaColor)),
      "textarea 文字透明（避免与覆盖层叠成重影）",
      String(data.textareaColor)
    );
    check(
      !/rgba\(0, 0, 0, 0\)|transparent/.test(String(data.caretColor)),
      "textarea 光标可见（透明文字下最容易漏的就是它）",
      String(data.caretColor)
    );

    // 着色开关
    check(data.hasSyntaxBtn === true, "有语法着色开关按钮");
    check(
      (data.afterOffBwe ?? -1) === 0 && (data.afterOnBwe ?? 0) > 0,
      "★ 关掉着色后没有 tk-bwe、打开后又回来（开关真的生效）",
      `off=${data.afterOffBwe} on=${data.afterOnBwe}`
    );
    check(data.afterOffTextVisible === true, "关掉着色后文字仍然可见（不能变成一片空白）");

    // 输入法组字兜底
    check(
      data.composingClass === true && data.composingOverlayVisibility === "hidden",
      "★ 输入法组字期间切回 textarea 显示文字并隐藏覆盖层（否则看不见正在打的拼音）",
      `class=${data.composingClass} hl=${data.composingOverlayVisibility}`
    );
    check(
      !/rgba\(0, 0, 0, 0\)/.test(String(data.composingTextareaColor)),
      "组字期间 textarea 的文字是有色的（可见）",
      String(data.composingTextareaColor)
    );
    check(data.afterComposingClass === false, "组字结束后 composing 类被摘掉");

    // 覆盖层与 textarea 必须同原点（本次修掉的 40px 偏移回归锁）
    const al = data.align;
    check(
      al && Math.abs(al.deltaX) <= 2,
      "★ 搜索高亮与文字水平对齐（|deltaX| ≤ 2px，回归锁：曾偏 40px = 一个行号栏宽）",
      al ? `deltaX=${al.deltaX} line=${al.line} CJK=${al.hasCJK} 前缀 ${al.prefixChars} 字` : "没量到"
    );
    check(
      al && Math.abs(al.deltaY) <= 4,
      "★ 搜索高亮与文字垂直对齐（|deltaY| ≤ 4px）",
      al ? `deltaY=${al.deltaY}` : "没量到"
    );
  }

  // ---- ⑩ CSS 规则数对账 ----
  //
  // 这条自检是被真实事故逼出来的：js-editor.css 的一条注释里出现了「点星斜杠」三字符序列，
  // 提前闭合了块注释，紧跟其后的 .js-findbar-row 整条规则被浏览器**静默丢弃**
  // （CSS 容错：坏一条跳过一条）。语法合法、文件能读、肉眼看不出来。
  // 判据：浏览器解析出的规则数 vs 源文件去掉注释后的花括号数。
  {
    const cssPath = join(REPO, "web", "styles", "js-editor.css");
    const exists = existsSync(cssPath);
    check(exists, "web/styles/js-editor.css 存在");
    if (exists) {
      const expected = countCssRules(readFileSync(cssPath, "utf8"));
      const sheet = (data.cssSheets ?? []).find((x) => String(x.href || "").includes("js-editor.css"));
      check(sheet !== undefined, "浏览器解析到了 js-editor.css（样式表没被整体拒收）", JSON.stringify(data.cssSheets));
      if (sheet) {
        // 允许 ±2：@media 内层的计数方式与源文件嵌套花括号略有差异
        const diff = Math.abs(sheet.rules - expected);
        check(
          diff <= 2,
          "★ js-editor.css 规则数与源文件花括号数对得上（防注释误闭合吞规则）",
          `浏览器 ${sheet.rules} 条 vs 源文件 ${expected} 个 {，差 ${diff}`
        );
      }
    }
  }

  console.log(output.slice(-500));
  return summarize();
}

main().then((code) => {
  process.exitCode = code;
});
