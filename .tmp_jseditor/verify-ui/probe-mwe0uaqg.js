(async () => {
  const out = { steps: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const text = (el) => (el ? String(el.textContent || "").trim() : null);
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

  // ---- ② 找到编辑器 ----
  out.hasEditor = Boolean(q(".js-code") && q("textarea.js-source"));
  out.editorRect = rect(q(".js-code"));
  out.sourceRect = rect(q("textarea.js-source"));
  out.projectName = window.__BWE__?.store?.project?.name ?? null;
  if (!out.hasEditor) return out;

  const ta = q("textarea.js-source");
  const codeBox = q(".js-code");
  out.initialText = ta.value;
  out.initialLines = ta.value.split("\n").length;

  // ---- ③ 结构：工具面板 / 页签 ----
  out.hasTools = Boolean(q(".js-tools"));
  out.tabLabels = qa(".js-tab").map((b) => text(b));
  out.hasApiPane = Boolean(q(".js-tools .js-api"));

  // ---- ④ 大纲页签 ----
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

  // ---- ⑤ Ctrl+F 打开查找条 ----
  ta.focus();
  ta.setSelectionRange(0, 0);
  ta.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
  await sleep(150);
  const findbar = q(".js-findbar");
  out.findbarVisible = Boolean(findbar && getComputedStyle(findbar).display !== "none");
  const findInput = q("[data-js-find-input]");
  out.hasFindInput = Boolean(findInput);
  if (!findInput) return out;

  // ---- ⑥ 搜一个真实出现在脚本里的标识符 ----
  // 用脚本里必然存在的关键字：先找 "function"（示例脚本里一定有）
  const needle = "function";
  out.needle = needle;
  out.expectedMatches = (ta.value.match(/function/g) || []).length;
  findInput.value = needle;
  findInput.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(200);
  out.findCountText = text(q("[data-js-find-count]"));
  out.markCount = qa(".js-hl mark").length;
  out.overlayVisible = (() => {
    const hl = q(".js-hl");
    return Boolean(hl && getComputedStyle(hl).display !== "none");
  })();

  // ---- ⑦ 全部替换 ----
  const replaceInput = q("[data-js-replace-input]");
  out.hasReplaceInput = Boolean(replaceInput);
  if (replaceInput) {
    // 先切到替换模式（Ctrl+H）
    // ⚠ 必须发给**当前焦点元素**：Ctrl+F 之后焦点在查找输入框里（那是真实用户体验），
    // 把按键硬塞给 textarea 等于绕过了"谁来接这个键"这一段 —— 第一版就是这么写的，
    // 结果测出来的是"Ctrl+H 不生效"，而实际上是用户根本不会在那种状态下按到 textarea 上。
    const active = document.activeElement || ta;
    out.activeBeforeCtrlH = {
      tag: active.tagName,
      cls: active.className,
      isFindInput: active.hasAttribute("data-js-find-input"),
      isReplaceInput: active.hasAttribute("data-js-replace-input")
    };
    active.dispatchEvent(new KeyboardEvent("keydown", { key: "h", ctrlKey: true, bubbles: true, cancelable: true }));
    await sleep(200);
    out.focusAfterCtrlH = (document.activeElement || {}).className || null;
    out.replaceRowDisplay = (() => {
      const row = q("[data-js-replace-input]")?.parentElement;
      return row ? getComputedStyle(row).display : null;
    })();
    out.replaceVisible = (() => {
      const ri = q("[data-js-replace-input]");
      return Boolean(ri && ri.offsetParent !== null);
    })();
    const ri = q("[data-js-replace-input]");
    const fbar = q(".js-findbar");
    out.replaceVisibleDetail = {
      rowDisplay: out.replaceRowDisplay,
      findbarDisplay: fbar ? getComputedStyle(fbar).display : null,
      findbarRect: rect(fbar),
      replaceRect: rect(ri),
      findbarInlineDisplay: fbar ? fbar.style.display : null
    };
    const replacement = "FUNCTION_";
    replaceInput.value = replacement;
    // 「全部替换」按钮文案是中文，按文案找（保持与 UI 一致）
    const btns = qa(".js-findbar button");
    const allBtn = btns.find((b) => text(b) === "全部替换");
    out.hasReplaceAllBtn = Boolean(allBtn);
    if (allBtn) {
      allBtn.click();
      await sleep(250);
      out.textAfterReplace = ta.value;
      out.replacedCount = (ta.value.match(/FUNCTION_/g) || []).length;
      out.storeSource = window.__BWE__?.store?.project?.scripts?.[
        (window.__BWE__?.store?.project?.scripts ? Object.keys(window.__BWE__.store.project.scripts) : [])
          .find((k) => {
            const s = window.__BWE__.store.project.scripts[k];
            return s && typeof s.source === "string" && s.source.includes("FUNCTION_");
          }) || ""
      ]?.source ?? null;
      out.storeHasReplacement = typeof out.storeSource === "string" && out.storeSource.includes("FUNCTION_");
      // 撤销回原样，避免污染后续断言（也验证了替换进的是同一条编辑路径）
      const undo = window.__BWE__?.editor?.undo;
      out.hasUndo = typeof undo === "function";
      if (out.hasUndo) {
        undo.call(window.__BWE__.editor);
        await sleep(400);
        // ⚠ 撤销会重建剧本编辑器（applySnapshot → bwe:refresh-script-ui），
        // 所以**必须重新查询** textarea：旧的引用已经脱离 DOM，读它只会得到替换后的旧值。
        // 第一版就是读的旧引用，于是"撤销没生效"这条断言永远是红的 —— 而它其实生效了。
        // 这条坑本身值得记录：验收脚本读陈旧 DOM 引用 = 确定性的假红。
        const taAfter = q("textarea.js-source");
        out.textAfterUndo = taAfter ? taAfter.value : null;
        out.undoRestored = Boolean(taAfter) && !taAfter.value.includes("FUNCTION_");
        const storeAfter = window.__BWE__.store.project.scripts[
          Object.keys(window.__BWE__.store.project.scripts)[0]
        ];
        out.storeAfterUndo = storeAfter ? storeAfter.source.slice(0, 40) : null;
        out.storeUndoClean = Boolean(storeAfter) && !String(storeAfter.source).includes("FUNCTION_");
      }
    }
  }

  // ---- ⑧ 编译（真的打到 /api/js-check）----
  const buildTab = qa(".js-tab").find((b) => (b.dataset.jsToolsTab || "") === "build");
  out.hasBuildTab = Boolean(buildTab);
  if (buildTab) {
    buildTab.click();
    await sleep(80);
    const compileBtn = qa(".js-tabpane.on button").find((b) => text(b) === "编译");
    out.hasCompileBtn = Boolean(compileBtn);
    if (compileBtn) {
      compileBtn.click();
      await sleep(2500);
      const outEl = q(".js-compile-out");
      out.compileText = outEl ? String(outEl.textContent || "").slice(0, 200) : null;
      out.compileLen = outEl ? String(outEl.textContent || "").length : 0;
      out.compileMeta = text(q(".js-compile-meta"));
      out.compileState = text(q(".js-tabpane.on .hint"));
      // ES5 产物里不该再有箭头函数/const（降级生效的证据）
      out.transpiledHasArrow = /=>/.test(String(outEl?.textContent || ""));
      out.transpiledHasConst = /\bconst\b/.test(String(outEl?.textContent || ""));
    }
  }

  // ---- ⑨ 查找引用（F12 / Shift+F12 的落地验证；语言服务不可用时要降级而不是报错）----
  const refsTab = qa(".js-tab").find((b) => (b.dataset.jsToolsTab || "") === "refs");
  if (refsTab) {
    refsTab.click();
    await sleep(80);
    // ⚠ 必须重新查询 textarea：上面的撤销已经重建过剧本编辑器，ta 是脱离 DOM 的旧节点。
    // 往旧节点上 setSelectionRange + dispatchEvent 不会触发任何真实逻辑（事件冒泡不到树上），
    // 而测试只会看到"查不到引用" —— 又是一次「读陈旧引用 = 确定性假红」。
    const taNow = q("textarea.js-source");
    // 光标放到脚本里第一个真正的函数名上（"function onStart" 里的 onStart）
    // ⚠ 这段代码在模板字符串里：反斜杠必须写成双份，反引号字符一个都不能出现
    //   （写一个 \s 会被模板当成未知转义变成 s，于是匹配不到函数名 → refSymbol=null；
    //    注释里出现一个反引号则直接截断整段脚本）。
    const m = new RegExp("function[ \t]+([A-Za-z_$][\\w$]*)").exec(taNow.value);
    const nameStart = m ? m.index + m[0].indexOf(m[1]) : 0;
    out.refSymbol = m ? m[1] : null;
    taNow.focus();
    taNow.setSelectionRange(nameStart + 1, nameStart + 1);
    taNow.dispatchEvent(new KeyboardEvent("keydown", { key: "F12", shiftKey: true, bubbles: true, cancelable: true }));
    await sleep(2000);
    out.refsEmptyHint = text(q(".js-tabpane.on .hint:not(:first-child)"));
    out.refsRows = qa(".js-tabpane.on .js-ref-row").length;
    out.refsTitle = text(q(".js-tabpane.on .hint"));
    // 辅助区默认是折叠的（把高度先给代码）。但 F12 是**用户主动触发**的动作，
    // 结果折叠着就等于"按了没反应"，所以必须在动作时自动展开。
    const auxBox = q(".js-aux-section");
    out.auxCollapsedAfterF12 = Boolean(auxBox && auxBox.classList.contains("collapsed"));
    out.auxHeight = rect(auxBox)?.h ?? 0;
    out.toolsVisible = (() => {
      const t = q(".js-tools");
      if (!t) return false;
      const r = t.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })();
  }

  // ---- ⑩ 悬浮提示（/api/script-quickinfo 的真实落地）----
  // 鼠标悬停 300ms 才发起请求，所以这里要真的等；坐标取某个 bwe. 符号的屏幕位置，
  // 用 measureCharWidth 的前提（等宽 + 行高 19px）反推 —— 与编辑器内部算法同源，
  // 但**不复用内部函数**：复用就等于用自己的实现证明自己是对的。
  {
    const taNow2 = q("textarea.js-source");
    const src = taNow2.value;
    const hit = src.indexOf("bwe.");
    if (hit >= 0) {
      const before = src.slice(0, hit);
      // 反斜杠在这个模板字符串里要写双份：注入到渲染进程的代码才有一份
      const lineNo = before.split("\n").length - 1;
      const col = hit - (before.lastIndexOf("\n") + 1);
      // 量一个字符宽：与编辑器同字体同字号的隐藏 span
      const cs = getComputedStyle(taNow2);
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
      const r = taNow2.getBoundingClientRect();
      // 先把目标行滚进视野，否则鼠标坐标可能落在编辑器外
      taNow2.scrollTop = Math.max(0, lineNo * lh - 60);
      await sleep(60);
      const visLine = lineNo - Math.round(taNow2.scrollTop / lh);
      const x = r.left + padL + cw * (col + 1);
      const y = r.top + padT + lh * visLine + lh / 2;
      taNow2.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }));
      await sleep(1200);
      const hoverEl = q(".js-hover");
      out.hoverVisible = Boolean(hoverEl && getComputedStyle(hoverEl).display !== "none");
      out.hoverCode = text(q(".js-hover-code"));
      out.hoverDoc = text(q(".js-hover-doc"));
      out.hoverRect = rect(hoverEl);
    }
  }

  // ---- ⑪ 括号配对高亮（纯前端，逐键可见）----
  {
    const taNow3 = q("textarea.js-source");
    const open = taNow3.value.indexOf("{");
    if (open >= 0) {
      taNow3.focus();
      taNow3.setSelectionRange(open + 1, open + 1);
      taNow3.dispatchEvent(new Event("select", { bubbles: true }));
      await sleep(200);
      out.bracketMarks = qa(".js-hl .js-hl-bracket").length;
    }
  }

  out.stepsDone = true;
  return out;
})()