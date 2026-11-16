/**
 * AI 栏布局验收：**「AI 栏与场景编辑器对等站位」** 的机器判定。
 *
 * ── 为什么要单独一个验收脚本 ────────────────────────────────────────────
 * 用户反馈是「AI 工具的栏太小了，起码得和场景编辑器对等站位」。
 * 这句话可以退化成无数种「看起来差不多」的实现，而失败的形态都很隐蔽：
 *   · 把 AI 塞回底部面板（默认 220px，对话区被压成一条缝）—— 最容易「改一改又改回去」；
 *   · 宽度写死在 JS 里，CSS 的小窗口媒体查询根本不生效（两套宽度规则打架）；
 *   · 折叠只把内容 display:none，画布恢复时拿不到正确尺寸（缩放错一帧）。
 *
 * 所以这里把「对等站位」翻译成**可断言的结构事实**，在真 Electron 里量：
 *   1. 归属：AI 栏在 `.shell-main` 里，**不在** `.panel`（底部面板）里；
 *   2. 高度：AI 栏与辅助栏（场景编辑器同一行）同高 —— 这才是「对等站位」；
 *   3. 宽度：显著宽于底部面板高度能给的对话区，且 ≥ 320（可读下限）；
 *   4. 1280x720 验收下限：**无横向溢出**（任何一栏都不能把画布挤出可视区）；
 *   5. 折叠开关：点「收起」后宽度归零、再点回来恢复（折叠=宽度归零，不切 display）。
 *
 * 跑法：
 *   node desktop/tools/verify-ai-dock-layout.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const ELECTRON = join(REPO, "desktop", "vendor", "electron", process.platform === "win32" ? "electron.exe" : "electron");
const MAIN = join(REPO, "desktop", "main.mjs");
const OUT = join(REPO, ".tmp_ai", "verify-ai-dock");

let pass = 0;
let fail = 0;

/** 断言：条件在前、名字在后（写反过一次，导致"字符串恒真"的假绿，见 verify-script-write 的注释）。 */
function check(cond, name, detail) {
  if (typeof name !== "string") throw new TypeError(`断言名必须是字符串：${String(name)}`);
  const okFlag = cond === true;
  if (okFlag) {
    pass++;
    console.log(`  ok  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * 读取布局事实的取证脚本（走 `--e2e-script`，拿到真正的几何）。
 *
 * 为什么不用 `--probe-dom`：那个 JSON 的结构是「下拉框 / 面板文本 / 选择器矩形」，
 * 来自 `probeDom`；而 `rects` / `overflow` / `aiDockStructure` 是 `probeUiSkeleton`
 * 的产物、只打在控制台不落盘。想断言「与辅助栏同高」这类几何事实，
 * 直接用 e2e 脚本量最可靠（也就不用依赖日志文本解析）。
 */
const MEASURE_SCRIPT = `(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const dock = document.querySelector(".ai-dock");
  const de = document.documentElement;

  /**
   * 启动态先取证：二轮改动把 AI 栏改成**默认收起**（AI 是独立工作面，不是常驻侧栏）。
   * 这里先记下"启动第一眼"的样子，再由脚本自己展开去量右侧栏形态 ——
   * 没有这一步，后面的断言会在一个宽度为 0 的栏上量出全部红。
   */
  const boot = {
    dock: rect(".ai-dock"),
    collapsed: Boolean(dock && dock.classList.contains("collapsed")),
    hasAiPanel: Boolean(document.querySelector(".ai-panel")),
    editorArea: rect(".editor-area")
  };

  // 展开右侧栏（等价于点活动栏之外的那个入口；用 editor 的公开方法，避免依赖按钮在折叠态里可见）
  const ed = window.__BWE__ && window.__BWE__.editor;
  if (ed && typeof ed.toggleAiPanel === "function" && boot.collapsed) {
    ed.toggleAiPanel();
    await frame();
    await new Promise((r) => setTimeout(r, 80));
    await frame();
  }

  return {
    boot,
    rects: {
      aiDock: rect(".ai-dock"),
      aiDockBody: rect(".ai-dock-body"),
      aiResizer: rect(".ai-resizer"),
      auxPanel: rect(".aux-panel"),
      editorArea: rect(".editor-area"),
      bottomPanel: rect(".panel"),
      canvasWrap: rect(".canvas-wrap")
    },
    aiDockStructure: dock ? {
      parent: String(dock.parentElement?.className || ""),
      inBottomPanel: Boolean(dock.closest(".panel")),
      insideShellMain: Boolean(dock.closest(".shell-main")),
      collapsed: dock.classList.contains("collapsed")
    } : null,
    overflow: { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, scrollHeight: de.scrollHeight, clientHeight: de.clientHeight },
    viewport: { width: window.innerWidth, height: window.innerHeight }
  };
})()`;

const TOGGLE_SCRIPT = `(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const out = [];
  const read = (tag) => {
    const dock = document.querySelector(".ai-dock");
    const resizer = document.querySelector(".ai-resizer");
    if (!dock) { out.push({ tag, missing: true }); return; }
    const r = dock.getBoundingClientRect();
    out.push({
      tag,
      width: Math.round(r.width),
      height: Math.round(r.height),
      collapsed: dock.classList.contains("collapsed"),
      resizerDisplay: resizer ? getComputedStyle(resizer).display : "no-resizer"
    });
  };
  // 默认收起 → 先展开，才能量到「折叠前」的宽度（见 MEASURE_SCRIPT 里的 boot 注释）
  const ed = window.__BWE__ && window.__BWE__.editor;
  if (document.querySelector(".ai-dock.collapsed") && ed && typeof ed.toggleAiPanel === "function") {
    ed.toggleAiPanel();
    await frame();
    await new Promise((r) => setTimeout(r, 80));
    await frame();
  }
  read("before");
  const btn = document.querySelector("[data-ai-collapse]");
  if (!btn) { out.push({ tag: "no-button" }); return out; }
  btn.click();
  await frame();
  read("after-collapse");
  btn.click();
  await frame();
  read("after-expand");
  return out;
})()`;
function runElectron({ userDataDir, size, probeDom, e2eScript, e2eOut }) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [MAIN, `--user-data=${userDataDir}`, `--size=${size}`, "--console"];
    if (probeDom) args.push(`--probe-dom=${probeDom}`);
    if (e2eScript) args.push(`--e2e-script=${e2eScript}`, `--e2e-out=${e2eOut}`);
    // e2e 模式必须有窗口但不需要截图
    if (!e2eScript) args.push(`--shot=${join(userDataDir, "shot.png")}`);
    const child = spawn(ELECTRON, args, {
      cwd: REPO,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d.toString("utf8")));
    child.stderr.on("data", (d) => (output += d.toString("utf8")));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, 120000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output });
    });
  });
}

async function main() {
  if (!existsSync(ELECTRON)) {
    console.error(`[verify-ai-dock] 缺少 Electron：${ELECTRON}\n  先运行 node desktop/tools/fetch-electron.mjs`);
    return 2;
  }
  mkdirSync(OUT, { recursive: true });
  const stamp = Date.now().toString(36);
  const { writeFileSync } = await import("node:fs");
  const measureScript = join(OUT, `measure-${stamp}.txt`);
  writeFileSync(measureScript, MEASURE_SCRIPT, "utf8");

  // ================= 一、1600x1000：对等站位 =================
  console.log("== 一、1600x1000：AI 栏归属与高度 ==");
  {
    const ud = join(OUT, `ud-a-${stamp}`);
    mkdirSync(ud, { recursive: true });
    const outJson = join(OUT, `measure-a-${stamp}.json`);
    const { code, output } = await runElectron({ userDataDir: ud, size: "1600x1000", e2eScript: measureScript, e2eOut: outJson });
    check(code === 0, `进程正常退出（exit=${code}）`);
    if (!existsSync(outJson)) {
      check(false, "生成布局取证 JSON");
      console.log(output.slice(-2000));
      return summarise();
    }
    const sk = JSON.parse(readFileSync(outJson, "utf8"));
    const r = sk.rects ?? {};
    const st = sk.aiDockStructure ?? {};

    // ---- 启动态：二轮约定「AI 栏默认收起」，启动第一眼不该有那个 460px 小窗 ----
    const boot = sk.boot ?? {};
    check(boot.collapsed === true, "★ 启动时 AI 栏默认收起（AI 是独立工作面，不是常驻侧栏）", `collapsed=${boot.collapsed}`);
    check((boot.dock?.width ?? -1) === 0, "启动时 AI 栏宽度为 0", `宽=${boot.dock?.width}`);
    check(
      boot.hasAiPanel === false,
      "★ 启动时 DOM 里没有 .ai-panel（面板只在进入 AI 界面后才建，不是靠 display:none 藏）",
      `hasAiPanel=${boot.hasAiPanel}`
    );
    check(
      (boot.editorArea?.width ?? 0) >= 900,
      "启动时编辑区拿到空出来的整块宽度",
      `编辑区=${boot.editorArea?.width}`
    );

    check(Boolean(r.aiDock), "AI 栏存在（.ai-dock）", r.aiDock ? `${r.aiDock.width}x${r.aiDock.height} @ x=${r.aiDock.x}` : "null");
    check(st.insideShellMain === true, "AI 栏位于主工作区（.shell-main）内", `parent=${st.parent}`);
    check(st.inBottomPanel === false, "★ AI 栏不在底部面板里（不是旧的小面板）", `closest(.panel)=${st.inBottomPanel}`);
    check(st.collapsed === false, "AI 栏默认展开");

    // 「对等站位」的核心：与场景编辑器同一行、同高
    const h = r.aiDock?.height ?? 0;
    const auxH = r.auxPanel?.height ?? 0;
    check(h >= 600, `AI 栏是全高栏（高度 ${h}px ≥ 600）`, `高度=${h}`);
    check(
      Math.abs(h - auxH) <= 2,
      "★ AI 栏与辅助栏（场景编辑器同一行）同高 —— 这就是「对等站位」",
      `ai=${h} aux=${auxH} 差=${Math.abs(h - auxH)}`
    );

    // 宽度：必须显著宽于底部面板的高度，否则对话区还是被压扁
    const w = r.aiDock?.width ?? 0;
    const bottomH = r.bottomPanel?.height ?? 0;
    check(w >= 320, `AI 栏宽度 ≥ 320（可读下限），实际 ${w}`, `宽=${w}`);
    check(
      w > bottomH,
      "AI 栏的横向空间大于底部面板的纵向空间（说明不再是「一条缝」）",
      `ai宽=${w} 底部面板高=${bottomH}`
    );

    // 编辑区没有被挤没
    const editorW = r.editorArea?.width ?? 0;
    check(editorW >= 400, `编辑区仍保有可用宽度（${editorW}px ≥ 400）`, `编辑区=${editorW}`);
    check(Boolean(r.aiResizer), "AI 栏有拖宽手柄（可手动调宽度）");
  }

  // ================= 二、1280x720：验收下限无横向溢出 =================
  console.log("== 二、1280x720：验收下限不横向溢出 ==");
  {
    const ud = join(OUT, `ud-b-${stamp}`);
    mkdirSync(ud, { recursive: true });
    const outJson = join(OUT, `measure-b-${stamp}.json`);
    const { code, output } = await runElectron({ userDataDir: ud, size: "1280x720", e2eScript: measureScript, e2eOut: outJson });
    check(code === 0, `进程正常退出（exit=${code}）`);
    if (existsSync(outJson)) {
      const sk = JSON.parse(readFileSync(outJson, "utf8"));
      const of = sk.overflow ?? {};
      const r = sk.rects ?? {};
      check(
        of.scrollWidth === of.clientWidth,
        `无横向溢出（scrollWidth ${of.scrollWidth} === clientWidth ${of.clientWidth}）`
      );
      const w = r.aiDock?.width ?? 0;
      check(w >= 320, `1280 下 AI 栏仍 ≥ 320（不为溢出而压到不可用），实际 ${w}`, `宽=${w}`);
      const editorW = r.editorArea?.width ?? 0;
      check(editorW >= 300, `1280 下编辑区仍有可用宽度（${editorW}px ≥ 300）`, `编辑区=${editorW}`);
    } else {
      check(false, "生成 1280 的布局取证 JSON");
      console.log(output.slice(-1500));
    }
  }

  // ================= 三、折叠/展开 =================
  console.log("== 三、折叠/展开（宽度归零而非 display:none）==");
  {
    const ud = join(OUT, `ud-c-${stamp}`);
    mkdirSync(ud, { recursive: true });
    const script = join(OUT, `toggle-${stamp}.txt`);
    const outJson = join(OUT, `toggle-${stamp}.json`);
    writeFileSync(script, TOGGLE_SCRIPT, "utf8");
    const { code } = await runElectron({ userDataDir: ud, size: "1600x1000", e2eScript: script, e2eOut: outJson });
    check(code === 0, `折叠取证进程正常退出（exit=${code}）`);
    if (existsSync(outJson)) {
      const steps = JSON.parse(readFileSync(outJson, "utf8"));
      const before = steps.find((s) => s.tag === "before");
      const collapsed = steps.find((s) => s.tag === "after-collapse");
      const expanded = steps.find((s) => s.tag === "after-expand");
      check(Boolean(before && collapsed && expanded), "拿到折叠前/后/再展开三步取证");
      if (before && collapsed && expanded) {
        check(collapsed.width === 0, "折叠后宽度归零（内联 flex-basis 必须被清掉）", `宽=${collapsed.width}`);
        check(collapsed.collapsed === true, "折叠后带 collapsed 类");
        check(
          collapsed.resizerDisplay === "none",
          "折叠后拖宽手柄一起隐藏（否则留一根能拖的悬空竖线）",
          `display=${collapsed.resizerDisplay}`
        );
        check(expanded.width > 0, "再展开后宽度恢复", `宽=${expanded.width}`);
        check(
          Math.abs(expanded.width - before.width) <= 2,
          "再展开后宽度回到折叠前的值（不漂移）",
          `前 ${before.width} / 后 ${expanded.width}`
        );
      }
    } else {
      check(false, "生成折叠取证 JSON");
    }
  }

  return summarise();
}

function summarise() {
  console.log(`\nverify-ai-dock-layout: ${pass}/${pass + fail} 通过`);
  console.log(`证据目录：${OUT}`);
  return fail === 0 ? 0 : 1;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
