/**
 * 搜索面板（活动栏「搜索」）。
 *
 * 为什么需要：工程一大，找东西就只能靠"记得它在哪个面板"。
 * 这里做一次跨域搜索：对象名、脚本名与脚本文本、素材名、模块标题。
 *
 * 纪律：
 *   - 纯本地搜索，不发任何请求；素材的二进制内容不参与匹配（那是 base64，搜了也没用）；
 *   - 结果分组、每条都能一条点击抵达（选中对象 / 打开脚本那一行）；
 *   - 输入防抖 200ms：工程上千对象时逐字全量扫不能每敲一个字符跑一次。
 */

import { el, input } from "../core/dom.ts";
import { store } from "../core/store.ts";
import { I } from "../ui/icons.ts";
import { scriptLang } from "../core/model.ts";
import { requestOpenScriptPanel } from "./scriptPanel.ts";

/** 搜索结果的统一形状：点一下就能到对应位置。 */
interface Hit {
  group: string;
  label: string;
  detail: string;
  gotoTab: "canvas" | "script";
  objectId?: string;
  scriptName?: string;
  scriptLine?: number;
  lang?: "js" | "yarn";
}

let query = "";

/**
 * 从别处（JS 编辑器的「工程内」按钮）带一个查询词进搜索面板。
 *
 * 为什么要有它：搜索词是模块级状态，面板一渲染就 `box.focus()`。如果由编辑器
 * 直接 import 并调用渲染函数，用户会看到「焦点跳到搜索框 → 面板又被重建 → 焦点丢失」。
 * 所以这里只**写入查询词**，由外壳决定什么时候切页、什么时候渲染，
 * 顺序是「先切页 → 再渲染」，焦点只被抢一次。
 */
export function setSearchQuery(q: string): void {
  query = String(q ?? "");
}

export function renderSearchPanel(host: HTMLElement): void {
  host.replaceChildren();
  const wrap = el("div", { class: "col" });
  wrap.style.padding = "10px";

  const head = el("div", { class: "row tight" });
  head.appendChild(el("div", { class: "group-label" }, "搜索 Search"));
  wrap.appendChild(head);

  const box = input(query, {
    placeholder: "搜对象名 / 脚本内容 / 素材 / 模块…",
    hint: "在工程内搜索；脚本会搜源码文本"
  });
  wrap.appendChild(box);

  const resultHost = el("div", { class: "col" });
  resultHost.style.marginTop = "8px";
  wrap.appendChild(resultHost);
  host.appendChild(wrap);

  let timer = 0;
  const run = (): void => {
    query = box.value;
    const hits = searchAll(query);
    renderResults(resultHost, hits);
  };
  box.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(run, 200);
  });
  box.focus();

  renderResults(resultHost, searchAll(query));
}

function renderResults(host: HTMLElement, hits: Hit[]): void {
  host.replaceChildren();
  if (!query.trim()) {
    host.appendChild(
      el("div", { class: "hint" },
        "输入关键词开始搜索。可以搜：\n"
        + "· 对象名（例如「玩家」「宝箱」）\n"
        + "· 脚本源码里的函数或注释\n"
        + "· 素材名、模块标题（例如「生命值」）")
    );
    return;
  }
  if (!hits.length) {
    host.appendChild(el("div", { class: "hint" }, "没有匹配。换个关键词，或确认这段内容在当前工程里。"));
    return;
  }

  // 分组显示：同一类结果放在一起，用户按"我知道它是对象还是脚本"来扫
  const groups = new Map<string, Hit[]>();
  for (const h of hits) {
    const arr = groups.get(h.group);
    if (arr) arr.push(h);
    else groups.set(h.group, [h]);
  }

  for (const [group, arr] of groups) {
    host.appendChild(el("div", { class: "group-label" }, `${group} · ${arr.length}`));
    for (const h of arr.slice(0, 40)) {
      const row = el("div", { class: "item" });
      row.appendChild(el("span", { class: "name" }, h.label));
      row.appendChild(el("span", { class: "sub" }, h.detail));
      row.style.cursor = "pointer";
      row.addEventListener("click", () => goto(h));
      host.appendChild(row);
    }
    if (arr.length > 40) {
      host.appendChild(el("div", { class: "hint" }, `还有 ${arr.length - 40} 条，输入更精确的关键词缩小范围`));
    }
  }
}

function goto(h: Hit): void {
  if (h.gotoTab === "script" && h.scriptName) {
    requestOpenScriptPanel(h.lang, h.scriptName);
    if (h.scriptLine) {
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent("bwe:script-goto-line", { detail: { line: h.scriptLine } }));
      }, 60);
    }
    // 剧本页在编辑区打开（左栏只是列表），所以还要通知外壳切标签
    window.dispatchEvent(new CustomEvent("bwe:open-script-tab"));
    return;
  }
  const obj = store.scene?.objects.find((o) => o.id === h.objectId);
  if (obj) {
    store.select(obj);
    window.dispatchEvent(new CustomEvent("bwe:open-canvas-tab"));
  }
}

function searchAll(q: string): Hit[] {
  const p = store.project;
  const needle = q.trim().toLowerCase();
  if (!p || !needle) return [];
  const hits: Hit[] = [];

  // 1. 当前场景对象
  const scene = store.scene;
  if (scene) {
    for (const o of scene.objects) {
      if (o.name.toLowerCase().includes(needle)) {
        hits.push({
          group: "对象",
          label: o.name,
          detail: `${o.kind} · ${scene.name} · (${Math.round(o.x)}, ${Math.round(o.y)})`,
          gotoTab: "canvas",
          objectId: o.id
        });
      }
    }
  }

  // 2. 脚本：先匹配名字，再逐行扫源码（只扫前 400 行，长脚本不该拖慢输入）
  for (const [name, entry] of Object.entries(p.scripts ?? {})) {
    if (!entry) continue;
    const lang = scriptLang(entry);
    if (name.toLowerCase().includes(needle)) {
      hits.push({
        group: "脚本",
        label: name,
        detail: `${lang === "js" ? "JS" : "Yarn"} · 名字匹配`,
        gotoTab: "script",
        scriptName: name,
        lang,
        scriptLine: 1
      });
      continue;
    }
    const lines = (entry.source ?? "").split("\n");
    for (let i = 0; i < Math.min(lines.length, 400); i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push({
          group: "脚本内容",
          label: `${name}:${i + 1}`,
          detail: lines[i].trim().slice(0, 70),
          gotoTab: "script",
          scriptName: name,
          lang,
          scriptLine: i + 1
        });
        // 同一份脚本最多给 5 条，避免一个高频词把列表占满
        if (hits.filter((x) => x.group === "脚本内容" && x.scriptName === name).length >= 5) break;
      }
    }
  }

  // 3. 素材
  for (const a of p.assets) {
    if (a.name.toLowerCase().includes(needle)) {
      hits.push({
        group: "素材",
        label: a.name,
        detail: `${a.kind} · ${a.src}`,
        gotoTab: "canvas"
      });
    }
  }

  return hits;
}

void I;
