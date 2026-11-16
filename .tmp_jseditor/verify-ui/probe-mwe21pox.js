/**
 * JS 编辑器的端到端探针（在真实渲染进程里执行，由 desktop/tools/verify-js-editor-ui.mjs 读盘注入）。
 *
 * ── 为什么是**独立文件**而不是内嵌在验收脚本里的模板字符串 ──────────────
 * 一开始它内嵌在 .mjs 里当模板字面量，结果接连踩了四次同一类坑：
 *   ① 注释里出现反引号 → 把整段模板截断；
 *   ② 字符串里写换行转义 → 注入后变成真实换行，字符串跨行 → SyntaxError；
 *   ③ 正则里写空白类转义 → 模板当成未知转义吃掉反斜杠，**静默匹配不到东西**；
 *   ④ 每次都要数"这里该写一个还是两个反斜杠"。
 * 这些都是**看不出来的**：③ 尤其糟，它不报错、只是让断言变成假的绿或假的红。
 * 独立文件后这些全部消失 —— 写进 .js 的就是浏览器要执行的东西，零转义。
 *
 * ⚠ 本文件本身也踩过同一个坑：头注释里写出「点星斜杠」这个三字符序列会**提前闭合块注释**，
 *   后面的说明文字就变成了会被执行的代码（解析器直接报错）。所以这里刻意不写出那个序列，
 *   并且用 `node --check` 做语法闸门。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────
 * 每一步都**从真实 UI 出发**（点隐藏探针按钮、发键盘事件、读 DOM 文本），
 * 不直接调编辑器内部函数 —— 直接调函数等于绕过"接线"，而接线恰恰是最容易断的地方
 * （本项目多次出现"功能实现了但没人调它"）。
 *
 * 返回值：一个对象，字段由 verify 脚本逐条断言。失败也不抛：抛了主进程只会看到空结果。
 */
(async () => {
  const out = { steps: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const text = (el) => (el ? String(el.textContent || "").trim() : null);
  /** 取 computed color：语法着色断言必须量真实颜色，不能只数 class（见下方说明）。 */
  const colorOf = (el) => {
    if (!el) return null;
    return getComputedStyle(el).color;
  };
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
  };

  // ---- ① 载入内置 JS 示例工程（隐藏探针按钮，与「文件 → 俯视角 JS 示例」同一入口）----
  const loadDemo = q("[data-load-js-demo]");
  out.hasLoadDemo = Boolean(loadDemo);
  if (loadDemo) loadDemo.click();
  await sleep(1800);

  // ---- ② 编辑器结构 ----
  out.hasEditor = Boolean(q(".js-code") && q("textarea.js-source"));
  out.editorRect = rect(q(".js-code"));
  out.sourceRect = rect(q("textarea.js-source"));
  out.projectName = window.__BWE__?.store?.project?.name ?? null;
  if (!out.hasEditor) return out;

  let ta = q("textarea.js-source");
  out.initialLines = ta.value.split("\n").length;

  out.hasTools = Boolean(q(".js-tools"));
  out.tabLabels = qa(".js-tab").map((b) => text(b));
  out.hasApiPane = Boolean(q(".js-tools .js-api"));

  // ---- ③ 大纲页签 ----
  const outlineTab = qa(".js-tab").find((b) => (b.dataset.jsToolsTab || "") === "outline");
  out.hasOutlineTab = Boolean(outlineTab);
  if (outlineTab) {
    outlineTab.click();
    await sleep(120);
    out.outlineRows = qa(".js-tabpane.on .js-ref-row").length;
    out.outlineFirst = text(q(".js-tabpane.on .js-ref-row .js-ref-text"));
    const firstRow = q(".js-tabpane.on .js-ref-row");
    if (firstRow) {
      firstRow.click();
      await sleep(120);
      out.caretAfterOutlineClick = ta.selectionStart;
    }
  }

  // ---- ④ Ctrl+F 打开查找条 ----
  ta.focus();
  ta.setSelectionRange(0, 0);
  ta.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
  await sleep(150);
  const findbar = q(".js-findbar");
  out.findbarVisible = Boolean(findbar && getComputedStyle(findbar).display !== "none");
  const findInput = q("[data-js-find-input]");
  out.hasFindInput = Boolean(findInput);
  if (!findInput) return out;

  // ---- ⑤ 搜索并验证计数 / 高亮 ----
  const needle = "function";
  out.needle = needle;
  out.expectedMatches = (ta.value.match(/function/g) || []).length;
  findInput.value = needle;
  findInput.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(250);
  out.findCountText = text(q("[data-js-find-count]"));
  out.markCount = qa(".js-hl mark").length;
  out.overlayVisible = (() => {
    const hl = q(".js-hl");
    return Boolean(hl && getComputedStyle(hl).display !== "none");
  })();
  // 覆盖层的排版度量必须与 textarea 逐项一致，否则高亮整体错位一行/半格
  out.overlayMetrics = (() => {
    const hl = q(".js-hl");
    if (!hl) return null;
    const a = getComputedStyle(ta);
    const b = getComputedStyle(hl);
    const pick = (cs) => ({
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      lineHeight: cs.lineHeight,
      whiteSpace: cs.whiteSpace,
      tabSize: cs.tabSize,
      padding: cs.padding
    });
    const left = pick(a);
    const right = pick(b);
    return {
      mismatch: Object.keys(left).filter((k) => left[k] !== right[k]),
      textarea: left,
      overlay: right
    };
  })();

  // ---- ⑥ Ctrl+H 切替换模式 + 全部替换 ----
  const replaceInput = q("[data-js-replace-input]");
  out.hasReplaceInput = Boolean(replaceInput);
  if (replaceInput) {
    // ⚠ 发给**当前焦点元素**：Ctrl+F 之后焦点在查找输入框里（真实用户就是这样），
    // 把按键硬塞给 textarea 等于绕过"谁来接这个键"这段。
    const active = document.activeElement || ta;
    out.activeBeforeCtrlH = { tag: active.tagName, isFindInput: active.hasAttribute("data-js-find-input") };
    active.dispatchEvent(new KeyboardEvent("keydown", { key: "h", ctrlKey: true, bubbles: true, cancelable: true }));
    await sleep(250);
    const row = q("[data-js-replace-input]")?.parentElement;
    out.replaceRowDisplay = row ? getComputedStyle(row).display : null;
    out.replaceVisible = (() => {
      const ri = q("[data-js-replace-input]");
      return Boolean(ri && ri.offsetParent !== null);
    })();

    const replacement = "FUNCTION_";
    const ri = q("[data-js-replace-input]");
    ri.value = replacement;
    const allBtn = qa(".js-findbar button").find((b) => text(b) === "全部替换");
    out.hasReplaceAllBtn = Boolean(allBtn);
    if (allBtn) {
      allBtn.click();
      await sleep(300);
      out.replacedCount = (ta.value.match(/FUNCTION_/g) || []).length;
      out.storeHasReplacement = (() => {
        const scripts = window.__BWE__?.store?.project?.scripts || {};
        return Object.values(scripts).some((s) => s && String(s.source || "").includes("FUNCTION_"));
      })();
      // 撤销：验证"替换是一次可撤销编辑"。
      // ⚠ 撤销会重建剧本编辑器（applySnapshot → bwe:refresh-script-ui），
      //   所以必须**重新查询** textarea —— 旧引用已脱离 DOM，读它只会得到替换后的旧值
      //   （第一版读旧引用，于是"撤销没生效"永远红，而它其实生效了）。
      const undo = window.__BWE__?.editor?.undo;
      out.hasUndo = typeof undo === "function";
      if (out.hasUndo) {
        undo.call(window.__BWE__.editor);
        await sleep(450);
        const taAfter = q("textarea.js-source");
        out.textAfterUndo = taAfter ? taAfter.value : null;
        out.undoRestored = Boolean(taAfter) && !taAfter.value.includes("FUNCTION_");
        const scripts = window.__BWE__?.store?.project?.scripts || {};
        const firstKey = Object.keys(scripts)[0] || "";
        out.storeAfterUndo = scripts[firstKey] ? String(scripts[firstKey].source || "").slice(0, 40) : null;
        out.storeUndoClean = Boolean(firstKey) && !String(scripts[firstKey]?.source || "").includes("FUNCTION_");
      }
    }
  }

  // ---- ⑦ 编译（真的打到 /api/js-check）----
  const buildTab = qa(".js-tab").find((b) => (b.dataset.jsToolsTab || "") === "build");
  out.hasBuildTab = Boolean(buildTab);
  if (buildTab) {
    buildTab.click();
    await sleep(100);
    const compileBtn = qa(".js-tabpane.on button").find((b) => text(b) === "编译");
    out.hasCompileBtn = Boolean(compileBtn);
    if (compileBtn) {
      compileBtn.click();
      await sleep(2600);
      const outEl = q(".js-compile-out");
      const code = String(outEl?.textContent || "");
      out.compileLen = code.length;
      out.compileCode = code.slice(0, 200);
      out.compileMeta = text(q(".js-compile-meta"));
      out.compileState = text(q(".js-tabpane.on .hint"));
      // ES5 降级的证据：产物里不该有箭头函数 / const / let / 模板字符串
      out.transpiledHasArrow = /=>/.test(code);
      out.transpiledHasConst = /\bconst\b/.test(code);
      out.transpiledHasTemplate = /`/.test(code);
    }
  }

  // ---- ⑧ 查找引用（F12 / Shift+F12 的落地验证）----
  const refsTab = qa(".js-tab").find((b) => (b.dataset.jsToolsTab || "") === "refs");
  if (refsTab) {
    refsTab.click();
    await sleep(100);
    // ⚠ 必须重新查询 textarea：上面的撤销已经重建过剧本编辑器（见 ⑥ 的注释）
    ta = q("textarea.js-source");
    const m = new RegExp("function[ \t]+([A-Za-z_$][$\\w]*)").exec(ta.value);
    const nameStart = m ? m.index + m[0].indexOf(m[1]) : 0;
    out.refSymbol = m ? m[1] : null;
    ta.focus();
    ta.setSelectionRange(nameStart + 1, nameStart + 1);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "F12", shiftKey: true, bubbles: true, cancelable: true }));
    await sleep(2200);
    out.refsRows = qa(".js-tabpane.on .js-ref-row").length;
    out.refsTitle = text(q(".js-tabpane.on .hint"));
    // 辅助区默认折叠（把高度先给代码）。F12 是**用户主动触发**的动作，
    // 结果折叠着就等于"按了没反应"，所以必须在动作时自动展开。
    const auxBox = q(".js-aux-section");
    out.auxCollapsedAfterF12 = Boolean(auxBox && auxBox.classList.contains("collapsed"));
    out.auxHeight = rect(auxBox)?.h ?? 0;
    const toolsEl = q(".js-tools");
    const toolsRect = toolsEl ? toolsEl.getBoundingClientRect() : null;
    out.toolsVisible = Boolean(toolsRect && toolsRect.width > 0 && toolsRect.height > 0);
  }

  // ---- ⑨ 悬浮提示（/api/script-quickinfo 的真实落地）----
  // 鼠标悬停 300ms 才发起请求，所以这里要真的等。
  // 坐标用「等宽字体 + 行高」反推 —— 与编辑器内部同一套前提，但**不复用内部函数**：
  // 复用就等于用自己的实现证明自己是对的。
  {
    const taH = q("textarea.js-source");
    const src = taH.value;
    const hit = src.indexOf("bwe.");
    if (hit >= 0) {
      const before = src.slice(0, hit);
      const lineNo = before.split("\n").length - 1;
      const col = hit - (before.lastIndexOf("\n") + 1);
      const cs = getComputedStyle(taH);
      const probe = document.createElement("span");
      probe.textContent = "0".repeat(10);
      probe.style.cssText =
        "position:absolute;left:-9999px;white-space:pre;font-family:" + cs.fontFamily
        + ";font-size:" + cs.fontSize + ";letter-spacing:" + cs.letterSpacing;
      document.body.appendChild(probe);
      const cw = probe.getBoundingClientRect().width / 10;
      probe.remove();
      const lh = parseFloat(cs.lineHeight) || 19;
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padT = parseFloat(cs.paddingTop) || 0;
      const r = taH.getBoundingClientRect();
      // 先把目标行滚进视野，否则鼠标坐标可能落在编辑器外
      taH.scrollTop = Math.max(0, lineNo * lh - 40);
      await sleep(80);
      const visLine = lineNo - Math.round(taH.scrollTop / lh);
      const x = r.left + padL + cw * (col + 1);
      const y = r.top + padT + lh * visLine + lh / 2;
      taH.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }));
      await sleep(1300);
      const hoverEl = q(".js-hover");
      out.hoverVisible = Boolean(hoverEl && getComputedStyle(hoverEl).display !== "none");
      out.hoverCode = text(q(".js-hover-code"));
      out.hoverDoc = text(q(".js-hover-doc"));
      out.hoverRect = rect(hoverEl);
    }
  }

  // ---- ⑩ CSS 规则数对账（防「注释里的 */ 吞掉下一条规则」）----
  //
  // 这个自检是被真实事故逼出来的：js-editor.css 里一条注释里写了三个字符
  // （星号 + 斜杠 + 按钮名），恰好构成注释结束符，于是紧跟其后的
  // .js-findbar-row 整条规则被浏览器**静默丢弃** —— 语法合法、文件能读、
  // 肉眼完全看不出来，只有"解析出的规则数 vs 源文件花括号数"能发现。
  try {
    const countRules = (sheet) => {
      let n = 0;
      let rules = [];
      try {
        rules = Array.from(sheet.cssRules || []);
      } catch (e) {
        return -1;
      }
      for (const r of rules) {
        n++;
        if (r.cssRules) n += Math.max(0, countRules(r));
      }
      return n;
    };
    const detail = [];
    for (const sh of Array.from(document.styleSheets || [])) {
      const n = countRules(sh);
      if (n > 0) detail.push({ href: String(sh.href || "inline").split("/").pop(), rules: n });
    }
    out.cssSheets = detail;
  } catch (e) {
    out.cssError = String((e && e.message) || e);
  }

  // ---- ⑪ 括号配对高亮（纯前端，逐键可见）----
  {
    const taB = q("textarea.js-source");
    const open = taB.value.indexOf("{");
    if (open >= 0) {
      taB.focus();
      taB.setSelectionRange(open + 1, open + 1);
      taB.dispatchEvent(new Event("select", { bubbles: true }));
      await sleep(250);
      out.bracketMarks = qa(".js-hl .js-hl-bracket").length;
    }
  }


  // ---- ⑫ 语法着色（结构 + 颜色真实性 + 对齐 + 输入法兜底）----
  // 编辑器结构：.js-code > .js-gutter + .js-edit > (textarea + .js-hl)
  const editBox = q(".js-edit");
  out.hasEditBox = Boolean(editBox);
  out.overlayInsideEdit = Boolean(editBox && editBox.querySelector(".js-hl"));
  out.textareaInsideEdit = Boolean(editBox && editBox.querySelector("textarea.js-source"));

  // 覆盖层是否真的显示了文字（textarea 应当透明）
  out.textareaColor = colorOf(ta);
  out.textareaFill = getComputedStyle(ta).webkitTextFillColor;
  out.caretColor = getComputedStyle(ta).caretColor;
  const hl = q(".js-hl");
  out.overlayColor = colorOf(hl);
  out.overlayVisible = Boolean(hl) && getComputedStyle(hl).visibility !== "hidden";

  // ---- 结构：各类 token 是否真的产出 ----
  const kinds = ["tk-comment", "tk-string", "tk-number", "tk-keyword", "tk-bwe", "tk-global"];
  out.syntaxCounts = {};
  for (const k of kinds) out.syntaxCounts[k] = qa(".js-hl ." + k).length;

  // ---- 颜色：两两不同、不透明、不是默认色 ----
  out.syntaxColors = {};
  for (const k of kinds) out.syntaxColors[k] = colorOf(q(".js-hl ." + k));

  const vals = Object.values(out.colors).filter(Boolean);
  out.uniqueColors = new Set(vals).size;
  out.transparentCount = vals.filter((c) => /rgba\(0, 0, 0, 0\)|transparent/.test(c)).length;

  // ---- 颜色确实来自 CSS 变量（换主题会变）----
  out.syntaxVars = {};
  for (const v of ["--js-comment", "--js-string", "--js-number", "--js-keyword", "--js-bwe", "--js-global"]) {
    out.syntaxVars[v] = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  }

  // ---- 三主题各自的实际色值 ----
  out.syntaxThemes = {};
  const html = document.documentElement;
  const prevClass = html.className;
  for (const theme of ["theme-cream", "theme-midnight", "theme-high-contrast"]) {
    html.className = theme;
    await sleep(80);
    out.syntaxThemes[theme] = colorOf(q(".js-hl .tk-bwe"));
  }
  html.className = prevClass;
  await sleep(80);

  // ---- 对齐：搜索命中位置 vs textarea 理论位置 ----
  ta.focus();
  ta.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
  await sleep(200);
  const fi = q("[data-js-find-input]");
  fi.value = "bwe";
  fi.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(400);

  const marks = qa(".js-hl .js-mark");
  out.markCount = marks.length;
  if (marks.length) {
    const first = marks[0];
    const rMark = first.getBoundingClientRect();
    const rTa = ta.getBoundingClientRect();
    const cs = getComputedStyle(ta);

    const text = ta.value;
    // 读探针写下的真实偏移，而不是 indexOf 反推：同一个词在示例脚本里出现 40 次，
    // indexOf 永远返回第一个，而 marks[0] 是**搜索命中的第一个**（未必同一处）。
    const start = Number(first.getAttribute("data-off") ?? -1);
    const before = text.slice(0, Math.max(0, start));
    const lineNo = before.split("\n").length - 1;
    const lineStart = before.lastIndexOf("\n") + 1;
    const prefix = before.slice(lineStart); // 该行从行首到命中处的原文

    // ⚠ 横向位置**不能**用「字符宽 × 列号」估：那对纯 ASCII 成立，但脚本里大量中文注释，
    //   CJK 在等宽字体里是双宽，估出来会差几十像素（上一版就是这么报出假的 89px 偏移）。
    //   正确做法：把这段前缀原文放进一个**同字体同字号**的镜像 span 里量它的真实宽度。
    const mirror = document.createElement("span");
    mirror.textContent = prefix;
    mirror.style.cssText =
      "position:absolute;left:-9999px;top:0;white-space:pre;tab-size:2;"
      + "font-family:" + cs.fontFamily + ";font-size:" + cs.fontSize
      + ";letter-spacing:" + cs.letterSpacing + ";";
    document.body.appendChild(mirror);
    const prefixW = mirror.getBoundingClientRect().width;
    mirror.remove();

    const lh = parseFloat(cs.lineHeight) || 19;
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padT = parseFloat(cs.paddingTop) || 0;
    const visLine = lineNo - Math.round(ta.scrollTop / lh);
    const expX = rTa.x + padL + prefixW;
    const expY = rTa.y + padT + lh * visLine;
    out.align = {
      expectedX: Math.round(expX),
      expectedY: Math.round(expY),
      actualX: Math.round(rMark.x),
      actualY: Math.round(rMark.y),
      deltaX: Math.round(rMark.x - expX),
      deltaY: Math.round(rMark.y - expY),
      prefixChars: prefix.length,
      hasCJK: /[\u4e00-\u9fff]/.test(prefix),
      markText: first.textContent,
      line: lineNo + 1
    };
  }

  // ---- 着色开关 ----
  const btn = q("[data-js-syntax]");
  out.hasSyntaxBtn = Boolean(btn);
  if (btn) {
    out.syntaxBtnText = String(btn.textContent || "").trim();
    btn.click();
    await sleep(300);
    out.afterOffBwe = qa(".js-hl .tk-bwe").length;
    out.afterOffTextVisible = Boolean(String(q(".js-hl")?.textContent || "").length > 100);
    btn.click();
    await sleep(300);
    out.afterOnBwe = qa(".js-hl .tk-bwe").length;
  }

  // ---- 输入法组字兜底 ----
  ta.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  await sleep(80);
  out.composingClass = Boolean(q(".js-edit.composing"));
  out.composingTextareaColor = colorOf(ta);
  out.composingOverlayVisibility = getComputedStyle(q(".js-hl")).visibility;
  ta.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await sleep(120);
  out.afterComposingClass = Boolean(q(".js-edit.composing"));


  out.stepsDone = true;
  return out;
})()
