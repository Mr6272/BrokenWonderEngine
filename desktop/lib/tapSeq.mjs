/**
 * 桌面壳 · 交互序列执行器（`--tap-seq`）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 * `--tap` 只能「点一次 → 截图 → 退出」，而真实验收常常需要**多步交互 + 每步取证**：
 *   点折叠按钮 → 量侧栏宽度 → 点展开入口 → 再量宽度
 * 三个数字要来自**同一次运行**，否则中间状态（用户手速、缓存、随机布局）都会混进来。
 *
 * ── 语法（刻意做得极简，用分号分段）───────────────────────────────────
 *   --tap-seq="click:[data-sidebar-collapse]; probe:.sidebar,.panel; wait:200; click:[data-sidebar-toggle]; probe:.sidebar,.panel"
 *
 * 支持的段类型（大小写不敏感，段内首尾空白会被裁掉）：
 *   · `click:<selector>`   点击一个元素（会先 scrollIntoView）。
 *                          可选第三段：`click:<selector>|<waitMs>`（点完等多久，覆盖默认 250ms）
 *   · `probe:<sel1>,<sel2>` 读每个选择器**第一个**匹配元素的 rect + 文本，
 *                          结果追加到 sequence（与 --probe-dom 的 selectors 同构）
 *   · `probe:<sel>*`        （选择器后缀 `*`）读该选择器**全部**匹配项，按 DOM 顺序逐条记录，
 *                          每条带 `index`。用于"列表里有几条、分别是什么"这类断言 ——
 *                          只读第一个的话，"顺序对不对/总共几条"根本测不出来。
 *   · `wait:<ms>`           纯等待（等动画/重排）
 *
 * ── 三条设计取舍 ───────────────────────────────────────────────────────
 * 1. **找不到元素不判死**：与 `--tap` 一致 —— 打印 `未找到` 并继续下一段。
 *    B 用它排查 bug 时，最怕的是「因为第 2 步没找到元素，后面的证据全没了」。
 * 2. **每个 click 之后默认等 250ms**：面板重建/折叠动画不在 click 返回时完成，
 *    立刻 probe 会量到中间态（这正是折叠 bug 里最容易误判的坑）。
 * 3. **probe 结果带 `step`（第几段）与 `phase`（段类型）**，B 能直接按顺序对比：
 *      sequence: [{ step, phase, selector, found, rect: {...}, text, ... }]
 */

/** click 之后默认等待（毫秒）：让折叠动画/面板重建落定。 */
const DEFAULT_CLICK_WAIT_MS = 250;
/** 单段 wait 上限，防止有人写错数字导致卡很久。 */
const MAX_WAIT_MS = 5000;

/** 渲染侧读取一个选择器的函数体（与 probeDom 的 selectors 逻辑保持同构）。 */
const READ_ONE_SELECTOR_JS = `
  (sel) => {
    let el = null;
    try {
      el = document.querySelector(sel);
    } catch (e) {
      return { selector: sel, found: false, error: "选择器语法错误：" + e.message };
    }
    if (!el) return { selector: sel, found: false, matchCount: 0 };
    const rect = el.getBoundingClientRect();
    const tidy = (s) => (s || "").replace(/\\s+/g, " ").trim();
    return {
      selector: sel,
      found: true,
      tag: el.tagName,
      id: el.id || "",
      cls: String(el.className || "").slice(0, 80),
      matchCount: document.querySelectorAll(sel).length,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      text: tidy(el.textContent).slice(0, 200),
      textLength: tidy(el.textContent).length,
      visible: Boolean(rect.width && rect.height)
    };
  }
`;

/**
 * 解析 `--tap-seq` 字符串为步骤数组。
 *
 * 纯函数（不碰窗口），因此可以单测：语法解析错了一步，整套取证就废了，
 * 而这层的错误往往表现为「静默少执行一步」，比报错更难发现。
 *
 * @param {string} raw
 * @returns {{steps: Array<{type:string, selector?:string, selectors?:string[], waitMs?:number, raw:string}>, errors: string[]}}
 */
export function parseTapSeq(raw) {
  const errors = [];
  const steps = [];
  const text = String(raw ?? "").trim();
  if (!text) return { steps, errors };

  for (const chunk of text.split(";")) {
    const seg = chunk.trim();
    if (!seg) continue;
    const colon = seg.indexOf(":");
    if (colon < 0) {
      errors.push(`段「${seg}」缺少「类型:参数」格式`);
      continue;
    }
    const type = seg.slice(0, colon).trim().toLowerCase();
    const arg = seg.slice(colon + 1).trim();

    if (type === "click") {
      // 可选 `|waitMs` 后缀：click:sel|1000
      const pipe = arg.lastIndexOf("|");
      let selector = arg;
      let waitMs = DEFAULT_CLICK_WAIT_MS;
      if (pipe >= 0) {
        const maybeMs = Number(arg.slice(pipe + 1));
        if (Number.isFinite(maybeMs) && maybeMs >= 0) {
          waitMs = Math.min(maybeMs, MAX_WAIT_MS);
          selector = arg.slice(0, pipe);
        }
      }
      if (!selector) {
        errors.push(`段「${seg}」click 缺少选择器`);
        continue;
      }
      steps.push({ type: "click", selector, waitMs, raw: seg });
      continue;
    }

    if (type === "probe") {
      const selectors = arg.split(",").map((s) => s.trim()).filter(Boolean);
      if (selectors.length === 0) {
        errors.push(`段「${seg}」probe 缺少选择器`);
        continue;
      }
      steps.push({ type: "probe", selectors, raw: seg });
      continue;
    }

    if (type === "wait") {
      const ms = Number(arg);
      if (!Number.isFinite(ms) || ms < 0) {
        errors.push(`段「${seg}」wait 需要非负毫秒数`);
        continue;
      }
      steps.push({ type: "wait", waitMs: Math.min(ms, MAX_WAIT_MS), raw: seg });
      continue;
    }

    errors.push(`段「${seg}」类型「${type}」未知（只支持 click / probe / wait）`);
  }

  return { steps, errors };
}

/**
 * 执行解析好的步骤序列。
 *
 * @param {import("electron").BrowserWindow} window
 * @param {Array} steps      parseTapSeq 的产物
 * @param {(msg:string)=>void} log
 * @returns {Promise<{sequence: Array, errors: string[]}>}
 *          sequence 每项：{ step, phase, selector, found, rect?, text?, ... }
 */
export async function runTapSequence(window, steps, log = () => {}) {
  const sequence = [];
  const errors = [];
  let stepIndex = 0;

  for (const step of steps) {
    stepIndex += 1;
    const stepLabel = `#${stepIndex} ${step.raw}`;

    if (step.type === "wait") {
      log(`[seq] ${stepLabel} → 等待 ${step.waitMs}ms`);
      await new Promise((r) => setTimeout(r, step.waitMs));
      sequence.push({ step: stepIndex, phase: "wait", waitMs: step.waitMs, ok: true });
      continue;
    }

    if (step.type === "click") {
      try {
        const result = await window.webContents.executeJavaScript(
          `(() => {
            const el = document.querySelector(${JSON.stringify(step.selector)});
            if (!el) return { found: false };
            try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) { /* 非致命 */ }
            el.click();
            const r = el.getBoundingClientRect();
            return {
              found: true,
              tag: el.tagName,
              cls: String(el.className || "").slice(0, 80),
              rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
            };
          })()`,
          true
        );
        if (result?.found) {
          log(
            `[seq] ${stepLabel} → 已点击 <${result.tag}${result.cls ? `.${result.cls}` : ""}> `
            + `@ ${result.rect.x},${result.rect.y} ${result.rect.width}x${result.rect.height}`
          );
          sequence.push({ step: stepIndex, phase: "click", selector: step.selector, found: true, clicked: true, rect: result.rect, tag: result.tag, cls: result.cls });
        } else {
          log(`[seq] ${stepLabel} → 未找到 ${step.selector}（继续执行后续步骤）`);
          sequence.push({ step: stepIndex, phase: "click", selector: step.selector, found: false, clicked: false });
          errors.push(`第 ${stepIndex} 步未找到 ${step.selector}`);
        }
      } catch (e) {
        log(`[seq] ${stepLabel} → 点击失败：${e?.message || e}（继续）`);
        sequence.push({ step: stepIndex, phase: "click", selector: step.selector, found: false, clicked: false, error: String(e?.message || e) });
        errors.push(`第 ${stepIndex} 步点击失败：${e?.message || e}`);
      }
      // 等折叠动画/面板重建落定（见文件头取舍 2）
      if (step.waitMs) await new Promise((r) => setTimeout(r, step.waitMs));
      continue;
    }

    if (step.type === "probe") {
      try {
        const probeCode = `(() => {
            const readOne = ${READ_ONE_SELECTOR_JS};
            const readAll = (sel) => {
              // 读**全部**匹配项（按 DOM 顺序），用于"列表里有几条、分别是什么"这类断言
              try {
                return Array.from(document.querySelectorAll(sel)).map((el, i) => {
                  const rect = el.getBoundingClientRect();
                  const tidy = (s) => (s || "").replace(/\\s+/g, " ").trim();
                  return {
                    selector: sel,
                    found: true,
                    index: i,
                    tag: el.tagName,
                    cls: String(el.className || "").slice(0, 80),
                    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
                    text: tidy(el.textContent).slice(0, 200),
                    textLength: tidy(el.textContent).length,
                    visible: Boolean(rect.width && rect.height)
                  };
                });
              } catch (e) {
                return [{ selector: sel, found: false, error: "选择器语法错误：" + e.message }];
              }
            };
            return ${JSON.stringify(step.selectors)}.map((raw) => {
              // 后缀 * 表示"读全部匹配项"；否则只读第一个（与 --probe-selector 一致）
              const all = raw.endsWith("*");
              const sel = all ? raw.slice(0, -1) : raw;
              return all ? { selector: sel, all: true, items: readAll(sel) } : readOne(sel);
            });
          })()`;
        const results = await window.webContents.executeJavaScript(probeCode, true);
        // 显式校验：注入脚本一旦写坏（例如模板被提前闭合导致求值成 NaN），
        // executeJavaScript 会返回非数组。直接 for-of 只会抛 "results is not iterable"，
        // 完全指不出根因；这里给出可读原因。
        if (!Array.isArray(results)) {
          throw new Error(
            `探测返回值不是数组（实际 ${typeof results === "number" ? `number(${results})` : typeof results}）`
            + " —— 注入脚本可能没正常 return（检查 probeCode 模板是否被提前闭合）"
          );
        }
        for (const r of results) {
          // `*` 形式：展开成多条 sequence 记录，每条带 index（顺序可断言的依据）
          if (r?.all) {
            const items = r.items ?? [];
            if (items.length === 0) {
              log(`[seq] ${stepLabel} → ${r.selector}*: 无匹配`);
              sequence.push({ step: stepIndex, phase: "probe", selector: r.selector, found: false, rect: null, matchCount: 0, index: -1 });
              continue;
            }
            log(`[seq] ${stepLabel} → ${r.selector}*: ${items.length} 个`);
            for (const it of items) {
              log(`  #${it.index}「${(it.text || "").slice(0, 40)}」${it.rect?.width}x${it.rect?.height}`);
              sequence.push({
                step: stepIndex,
                phase: "probe",
                selector: r.selector,
                found: Boolean(it.found),
                index: it.index,
                rect: it.rect ?? null,
                text: it.text ?? "",
                textLength: it.textLength ?? 0,
                matchCount: items.length,
                visible: it.visible ?? false,
                error: it.error ?? null
              });
            }
            continue;
          }
          if (r?.found) {
            log(
              `[seq] ${stepLabel} → ${r.selector}: x=${r.rect.x} y=${r.rect.y} `
              + `${r.rect.width}x${r.rect.height}（匹配 ${r.matchCount} 个）`
            );
          } else {
            log(`[seq] ${stepLabel} → ${r?.selector ?? "?"}: 未找到`);
          }
          sequence.push({
            step: stepIndex,
            phase: "probe",
            selector: r?.selector ?? "",
            found: Boolean(r?.found),
            rect: r?.rect ?? null,
            text: r?.text ?? "",
            textLength: r?.textLength ?? 0,
            matchCount: r?.matchCount ?? 0,
            visible: r?.visible ?? false,
            error: r?.error ?? null
          });
        }
      } catch (e) {
        log(`[seq] ${stepLabel} → 探测失败：${e?.message || e}`);
        sequence.push({ step: stepIndex, phase: "probe", selector: step.selectors.join(","), found: false, rect: null, error: String(e?.message || e) });
        errors.push(`第 ${stepIndex} 步探测失败：${e?.message || e}`);
      }
      continue;
    }
  }

  return { sequence, errors };
}
