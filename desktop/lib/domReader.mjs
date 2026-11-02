/**
 * 渲染侧执行的 DOM 读取逻辑（纯源码字符串，由 tapSeq 通过 executeJavaScript 注入）。
 *
 * ── 为什么单独成文件，而不是写在 tapSeq.mjs 的模板字符串里 ──────────────
 * 踩过的坑：把这段代码嵌在 `executeJavaScript(\`...\`)` 的模板字符串里时，
 * 正则 `\s` 与 `${}` 插值层层转义，改一个字符就可能让注入脚本语法错误或求值成怪值
 * （实测出现过 `probeCode` 求值成 `NaN`、注入为空的诡异现象，排查了很久）。
 *
 * 现在做法：**这段代码以纯文本保存**，tapSeq 直接读文件内容 + 把选择器 JSON 拼在**末尾**。
 * 没有嵌套模板、没有二次转义 —— 正则里的 `\s` 就是 JSON/JS 源码里的 `\s`，
 * 所见即所得。代价是多一个文件，换来「不可能因转义写坏」。
 *
 * 约定：
 *   · 本文件内容会被包裹成 `(() => { ... })()` 执行
 *   · 末尾的 `__SELECTORS__` 会被替换成 JSON 数组（脚本负责替换，不是模板插值）
 *   · 返回值必须是**数组**（每项一个选择器的读数）
 */

// 注意：下面是**会被注入到浏览器执行**的代码文本，不要在这里 import 任何东西。
export const DOM_READER_SOURCE = `
const readOne = (sel) => {
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
};

const readAll = (sel) => {
  try {
    const nodes = Array.from(document.querySelectorAll(sel));
    return nodes.map((el, i) => {
      const rect = el.getBoundingClientRect();
      const tidy = (s) => (s || "").replace(/\\s+/g, " ").trim();
      return {
        selector: sel,
        found: true,
        index: i,
        tag: el.tagName,
        cls: String(el.className || "").slice(0, 80),
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
    });
  } catch (e) {
    return [{ selector: sel, found: false, error: "选择器语法错误：" + e.message }];
  }
};

// 后缀 \`*\` 表示"读全部匹配项"；否则只读第一个（与 --probe-selector 一致）
const results = __SELECTORS__.map((raw) => {
  const all = raw.endsWith("*");
  const sel = all ? raw.slice(0, -1) : raw;
  return all
    ? { selector: sel, all: true, items: readAll(sel) }
    : readOne(sel);
});
return results;
`;
