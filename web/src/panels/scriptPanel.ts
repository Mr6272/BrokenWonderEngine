/**
 * 剧本面板（Yarn Spinner 格式）。
 *
 * 三块信息分开放，互不遮挡：
 *   源码编辑   —— 左侧大区域，等宽字体
 *   节点结构   —— 这段剧本由哪几节组成、谁跳到谁
 *   检查结果   —— 语法与引用问题，逐条给行号
 *
 * 编辑即时生效（400ms 防抖），不需要"保存"按钮。
 * 语法保持 Yarn Spinner 原生，不引入私有扩展，方便与社区工具互通。
 */

import { el, input, button, textarea } from "../core/dom.ts";
import { I } from "../ui/icons.ts";
import { ok, info } from "../ui/toast.ts";
import { store } from "../core/store.ts";

interface YarnNode {
  title: string;
  startLine: number;
  endLine: number;
  choices: string[];
  jumps: string[];
  varsSet: string[];
  speakers: string[];
}

interface YarnCheck {
  line: number;
  message: string;
  error: boolean;
}

let currentScript = "";

export function renderScriptPanel(host: HTMLElement): void {
  host.replaceChildren();
  const wrap = el("div", { class: "col" });
  wrap.style.padding = "10px";

  const head = el("div", { class: "row" });
  head.appendChild(el("div", { class: "group-label" }, "剧本 Scripts"));
  head.appendChild(el("div", { class: "spacer" }));
  head.appendChild(button("新建", () => newScript(), { size: "sm", variant: "primary", iconPath: I.plus }));
  wrap.appendChild(head);

  const names = Object.keys(store.project?.scripts ?? {});
  if (!names.length) {
    wrap.appendChild(
      el(
        "div",
        { class: "empty" },
        el("div", { class: "t" }, "还没有剧本"),
        el("div", { class: "d" }, "点上面的「新建」，会给你一段能直接跑的示例剧本，照着改就行。"),
        button("新建剧本", () => newScript(), { variant: "primary", size: "sm" })
      )
    );
    host.appendChild(wrap);
    return;
  }

  if (!currentScript || !names.includes(currentScript)) currentScript = names[0];

  // 剧本切换
  const list = el("div", { class: "item-list" });
  for (const n of names) {
    const item = el("div", { class: "item" + (n === currentScript ? " selected" : "") });
    const dot = el("span", { class: "dot" });
    dot.style.background = n === currentScript ? "var(--accent)" : "var(--line)";
    item.appendChild(dot);
    const grow = el("div", { class: "grow" });
    grow.appendChild(el("div", { class: "name" }, n));
    const src = store.project?.scripts[n]?.source ?? "";
    const nodeCount = (src.match(/^\s*title\s*:/gm) ?? []).length;
    grow.appendChild(el("div", { class: "sub" }, `${nodeCount} 个节点 · ${src.split("\n").length} 行`));
    item.appendChild(grow);
    item.addEventListener("click", () => {
      currentScript = n;
      renderScriptPanel(host);
    });
    list.appendChild(item);
  }
  wrap.appendChild(list);

  const script = store.project?.scripts[currentScript];
  if (!script) {
    host.appendChild(wrap);
    return;
  }

  // 源码编辑
  const edHead = el("div", { class: "row" });
  edHead.style.marginTop = "8px";
  edHead.appendChild(el("div", { class: "group-label" }, "源码 Yarn"));
  edHead.appendChild(el("div", { class: "spacer" }));
  edHead.appendChild(el("span", { class: "hint" }, "改完即时生效"));
  wrap.appendChild(edHead);

  const ta = textarea(script.source, {
    onChange: (v) => {
      script.source = v;
      store.markDirty();
      scheduleCheck();
    }
  });
  ta.style.minHeight = "220px";
  ta.style.fontFamily = "var(--mono)";
  ta.style.fontSize = "12.5px";
  wrap.appendChild(ta);

  // 检查结果
  const resultHead = el("div", { class: "group-label" }, "检查 Check");
  resultHead.style.marginTop = "10px";
  wrap.appendChild(resultHead);
  const resultBox = el("div", { class: "col" });
  wrap.appendChild(resultBox);

  const nodeBox = el("div", { class: "col" });
  const nodeHead = el("div", { class: "group-label" }, "节点 Nodes");
  nodeHead.style.marginTop = "10px";
  wrap.appendChild(nodeHead);
  wrap.appendChild(nodeBox);

  // 变量
  const varBox = el("div", { class: "col" });
  const varHead = el("div", { class: "group-label" }, "变量 Variables");
  varHead.style.marginTop = "10px";
  wrap.appendChild(varHead);
  wrap.appendChild(varBox);

  host.appendChild(wrap);

  let timer = 0;
  function scheduleCheck(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(runCheck, 400);
  }

  function runCheck(): void {
    // 面板可能在工程被替换后还持有旧引用，这里再确认一次
    if (!script) return;
    const r = analyze(script.source);
    resultBox.replaceChildren();
    if (!r.checks.length) {
      resultBox.appendChild(el("div", { class: "hint", style: { color: "var(--ok)" } }, "没有问题，这段剧本可以直接跑。"));
    } else {
      for (const c of r.checks) {
        const line = el("div", { class: "hint" });
        line.style.color = c.error ? "var(--danger)" : "var(--warn)";
        line.textContent = `${c.error ? "要改" : "建议"}　第 ${c.line} 行　${c.message}`;
        line.style.cursor = "pointer";
        line.addEventListener("click", () => {
          const pos = lineOffset(script.source, c.line);
          ta.focus();
          ta.setSelectionRange(pos, Math.min(pos + 60, script.source.length));
        });
        resultBox.appendChild(line);
      }
    }

    nodeBox.replaceChildren();
    if (!r.nodes.length) {
      nodeBox.appendChild(el("div", { class: "hint" }, "没有解析到节点。一个节点从 title: 名字 开始，用 --- 进入正文，用 === 结束。"));
    } else {
      for (const n of r.nodes) {
        const card = el("div", { class: "card" });
        const h = el("header");
        h.appendChild(el("span", null, n.title));
        h.appendChild(el("div", { class: "spacer" }));
        h.appendChild(el("span", { class: "hint" }, `第 ${n.startLine}–${n.endLine} 行`));
        card.appendChild(h);
        const body = el("div", { class: "body" });
        const bits: string[] = [];
        if (n.choices.length) bits.push(`${n.choices.length} 个选项`);
        if (n.jumps.length) bits.push(`跳往 ${n.jumps.join("、")}`);
        if (n.speakers.length) bits.push(`说话人 ${n.speakers.join("、")}`);
        if (n.varsSet.length) bits.push(`记下 $${n.varsSet.join("、$")}`);
        body.appendChild(el("div", { class: "hint" }, bits.join("　·　") || "纯叙述节点"));
        if (n.choices.length) {
          const ul = el("ul");
          ul.style.margin = "4px 0 0";
          ul.style.paddingLeft = "16px";
          for (const c of n.choices) ul.appendChild(el("li", { class: "hint" }, c));
          body.appendChild(ul);
        }
        card.appendChild(body);
        card.style.marginBottom = "6px";
        card.style.cursor = "pointer";
        card.addEventListener("click", () => {
          const pos = lineOffset(script.source, n.startLine);
          ta.focus();
          ta.setSelectionRange(pos, Math.min(pos + 40, script.source.length));
        });
        nodeBox.appendChild(card);
      }
    }

    varBox.replaceChildren();
    if (!r.variables.length) {
      varBox.appendChild(
        el("div", { class: "hint" }, "还没有用到变量。写 <<set $见过老人 = true>> 就能记一件事，模块里的「变量条件」可以读它。")
      );
    } else {
      for (const v of r.variables) {
        const row = el("div", { class: "hint mono" }, `$${v}`);
        varBox.appendChild(row);
      }
    }
  }

  window.setTimeout(runCheck, 20);
}

function newScript(): void {
  if (!store.project) return;
  let i = 1;
  let name = "剧本 1";
  while (store.project.scripts[name]) name = `剧本 ${++i}`;
  store.project.scripts[name] = {
    name,
    file: `Scripts/${name}.yarn`,
    source: STARTER
  };
  currentScript = name;
  store.markDirty();
  ok(`已新建「${name}」，里面是一段可以直接跑的示例`);
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
}

function lineOffset(src: string, line: number): number {
  const lines = src.split("\n");
  let off = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) off += lines[i].length + 1;
  return off;
}

// ---------------- 解析 ----------------

function analyze(source: string): { nodes: YarnNode[]; checks: YarnCheck[]; variables: string[] } {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const nodes: YarnNode[] = [];
  const checks: YarnCheck[] = [];
  const variables = new Set<string>();
  let cur: YarnNode | null = null;
  let inBody = false;
  const titles = new Set<string>();

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) return;

    const tm = /^title\s*:\s*(.+)$/.exec(line);
    if (tm) {
      if (cur) checks.push({ line: lineNo, message: `上一个节点「${cur.title}」没有用 === 收尾`, error: true });
      const title = tm[1].trim();
      if (!title) checks.push({ line: lineNo, message: "节点没有名字", error: true });
      else if (titles.has(title)) checks.push({ line: lineNo, message: `节点名「${title}」重复了，运行时只有一个能用`, error: true });
      titles.add(title);
      cur = { title, startLine: lineNo, endLine: lineNo, choices: [], jumps: [], varsSet: [], speakers: [] };
      nodes.push(cur);
      inBody = false;
      return;
    }
    if (line === "---") {
      inBody = true;
      return;
    }
    if (line === "===") {
      if (cur) cur.endLine = lineNo;
      cur = null;
      inBody = false;
      return;
    }
    if (!cur || !inBody) return;

    // 选项
    const cm = /^->\s*(.*)$/.exec(line);
    if (cm) {
      const text = cm[1].replace(/<<\s*if\s+.+?>>/, "").trim();
      cur.choices.push(text || "(空选项)");
      if (!text) checks.push({ line: lineNo, message: "选项没有文字，玩家会看到一行空白", error: false });
    }
    // 跳转
    const jm = /<<\s*jump\s+([^>]+?)\s*>>/g;
    let m: RegExpExecArray | null;
    while ((m = jm.exec(line))) cur.jumps.push(m[1].trim());
    if (/<<\s*stop\s*>>/.test(line)) cur.jumps.push("（结束）");
    // 变量
    const vm = /\$([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)/g;
    while ((m = vm.exec(line))) variables.add(m[1]);
    const sm = /<<\s*set\s+\$([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)/.exec(line);
    if (sm) cur.varsSet.push(sm[1]);
    // 说话人
    const spm = /^([^:\-<>#\s][^:]{0,17})\s*:\s*\S/.exec(line);
    if (spm && !line.startsWith("<<")) cur.speakers.push(spm[1].trim());
    // 括号闭合
    if (line.includes("<<") && !line.includes(">>")) {
      checks.push({ line: lineNo, message: "这一行的命令少了 >> 收尾", error: true });
    }
  });

  if (!nodes.length) {
    checks.push({ line: 1, message: "没有找到任何节点。一个节点长这样：title: 开场 / --- / 旁白: 你好 / ===", error: true });
  }

  // 跳转目标校验
  for (const n of nodes) {
    for (const j of n.jumps) {
      if (j === "（结束）") continue;
      if (!titles.has(j)) {
        checks.push({ line: n.startLine, message: `节点「${n.title}」跳到了不存在的「${j}」`, error: true });
      }
    }
  }
  // 孤立节点提示
  if (nodes.length > 1) {
    nodes.slice(1).forEach((n) => {
      const referenced = nodes.some((o) => o !== n && o.jumps.includes(n.title));
      if (!referenced) checks.push({ line: n.startLine, message: `节点「${n.title}」没有任何地方跳进来，玩家看不到它`, error: false });
    });
  }

  return { nodes, checks, variables: Array.from(variables) };
}

const STARTER = `title: 序章
---
旁白: 夜色压下来，风把火把吹得东倒西歪。
旅人: 这地方……三年前就该没人了。
-> 推门进去
    旁白: 门轴发出一声长叹。
    <<jump 门内>>
-> 转身离开
    旁白: 你决定不惹麻烦。
    <<stop>>
===

title: 门内
---
旁白: 屋里点着一盏灯。
<<if $问过路了>>
    老人: 你回来了。
<<else>>
    老人: 谁在外面？
    <<set $问过路了 = true>>
<<endif>>
===
`;

void input;
void info;
