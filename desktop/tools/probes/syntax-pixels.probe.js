/**
 * 探针：为「像素级着色验收」准备一屏**包含全部六类**的样例，并量出每类的屏幕矩形。
 *
 * ── 为什么注入测试文本，而不是在示例脚本里滚着找 ──────────────────────
 * 第一版是"滚动 8 个位置去找 tk-string / tk-global 的可见样例"，两个问题：
 *   ① 截图只能拍**一个**滚动位置，而样例分散在不同位置 → 必须每次滚回去重拍；
 *   ② `Math` 这类内置 API 在示例脚本里可能只在很靠下的地方出现一次，
 *      换个示例工程就一个都采不到，验收会随素材漂移而变成假绿。
 * 注入一段固定文本后：六类都在同一屏、位置确定、断言可复现。
 *
 * 真实脚本上的着色覆盖由 `verify-js-editor-ui.mjs` 的结构断言负责
 * （它数的是真实示例脚本里各类 token 的个数），两者互补。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);

  q("[data-load-js-demo]").click();
  await sleep(2000);

  let ta = q("textarea.js-source");
  if (!ta) return { error: "no editor" };

  /**
   * 样例：每类至少一行，且都在前 14 行内（1600x1000 下代码区约 30 行可见，
   * 留足余量，避免不同 DPI 下最后一行被裁掉）。
   * 每行的注释写在行尾，避免"注释先出现把整行都吞掉"。
   */
  const SNIPPET = [
    "// 注释行：这一整行都是 comment 色",
    "var name = 'hello';",
    'var other = "world";',
    "var count = 42;",
    "function sample(ctx) {",
    "  var radius = Math.max(1, 3);",
    "  var data = JSON.stringify({});",
    "  bwe.world.find('player');",
    "  bwe.draw.text('hi', 1, 2);",
    "  if (count > 0) { return true; }",
    "  return false;",
    "}",
    "",
    "// 末尾注释：留白避免最后一行贴边",
    ""
  ].join("\n");

  ta.focus();
  ta.setSelectionRange(0, 0);
  ta.value = SNIPPET;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.scrollTop = 0;
  ta.scrollLeft = 0;
  ta.dispatchEvent(new Event("scroll", { bubbles: true }));
  await sleep(600);

  const codeEl = q(".js-code");
  const code = codeEl.getBoundingClientRect();
  const vis = { x: code.x + 2, y: code.y + 2, r: code.x + code.width - 2, b: code.y + code.height - 2 };

  const pickVisible = (cls) => {
    const cands = Array.from(document.querySelectorAll(".js-hl ." + cls)).filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      if (r.x < vis.x || r.y < vis.y) return false;
      if (r.x + r.width > vis.r || r.y + r.height > vis.b) return false;
      return String(el.textContent || "").trim().length >= 1;
    });
    return cands[0] ?? null;
  };

  const KINDS = ["tk-comment", "tk-string", "tk-keyword", "tk-bwe", "tk-global", "tk-number"];
  const picks = [];
  for (const cls of KINDS) {
    const el = pickVisible(cls);
    if (!el) {
      picks.push({ cls, text: null });
      continue;
    }
    const r = el.getBoundingClientRect();
    picks.push({
      cls,
      text: String(el.textContent || "").trim().slice(0, 20),
      color: getComputedStyle(el).color,
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height)
    });
  }

  return {
    picks,
    code: { x: Math.round(code.x), y: Math.round(code.y), w: Math.round(code.width), h: Math.round(code.height) },
    missing: picks.filter((p) => !p.text).map((p) => p.cls),
    snippetLines: SNIPPET.split("\n").length
  };
})()
