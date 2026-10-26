/**
 * 模块库面板（左栏「模块」页）。
 *
 * 两个区，从上到下：
 *   规则包 Packs —— 已经调好的一整组积木（拼接结果）。脱到对象上整包生效，
 *                   这是"模块组合/拼接"给用户的入口。
 *   所有积木 Modules —— 单个模块的货架，按八类分组。
 *
 * 货架上只回答"这块是干什么的"；参数在独立的「模块编辑器」里调
 * （选中对象后点工具栏「模块」，或按 M）。
 */

import type { ModuleCategoryId, ModuleDef, RulePack } from "../core/model.ts";
import { MODULE_CATEGORIES, categoryOf, searchModules, makeInstance, moduleDef } from "../data/modules.ts";
import { applyPack, packFromModules, packIssues, packSummary } from "../data/packs.ts";
import { store } from "../core/store.ts";
import { el, input, button, emptyState } from "../core/dom.ts";
import { I } from "../ui/icons.ts";
import { info, warn, ok, error, contextMenu, modal, confirmDialog } from "../ui/toast.ts";

let searchText = "";
let filterCat: ModuleCategoryId | null = null;

export function renderModulePanel(host: HTMLElement): void {
  host.replaceChildren();
  const wrap = el("div", { class: "col" });
  wrap.style.padding = "10px";

  // ---------- 规则包区 ----------
  const packHead = el("div", { class: "row" });
  packHead.appendChild(el("div", { class: "group-label" }, `规则包 Packs（${store.project?.packs.length ?? 0}）`));
  packHead.appendChild(el("div", { class: "spacer" }));
  packHead.appendChild(
    button("把当前对象打包", () => packSelected(), {
      size: "sm",
      iconPath: I.pack,
      title: "把选中对象的全部模块存成一个包，之后可以一键套到别的对象上"
    })
  );
  wrap.appendChild(packHead);
  wrap.appendChild(
    el(
      "div",
      { class: "hint" },
      "包 = 一整组调好的积木。拖到画布上的对象，或双击套到当前选中对象。"
    )
  );

  const packBox = el("div", { class: "col" });
  packBox.style.marginTop = "6px";
  renderPacks(packBox);
  wrap.appendChild(packBox);

  // ---------- 所有积木 ----------
  const modHead = el("div", { class: "row" });
  modHead.appendChild(el("div", { class: "group-label" }, "所有积木 Modules"));
  modHead.appendChild(el("div", { class: "spacer" }));
  wrap.appendChild(modHead);

  const s = input(searchText, {
    placeholder: "搜索模块：移动 / 点击 / 范围 / 血量…",
    onChange: (v) => {
      searchText = v;
      renderList(listBox);
    }
  });
  wrap.appendChild(s);

  const chips = el("div", { class: "row tight wrap" });
  chips.style.marginTop = "8px";
  const allChip = el("button", { type: "button", class: "btn sm" + (filterCat === null ? " primary" : " ghost") }, "全部");
  allChip.addEventListener("click", () => {
    filterCat = null;
    refreshChips();
    renderList(listBox);
  });
  chips.appendChild(allChip);
  for (const c of MODULE_CATEGORIES) {
    const b = el("button", { type: "button", class: "btn sm" + (filterCat === c.id ? " primary" : " ghost") }, c.label.split(" ")[0]);
    b.title = `${c.label}｜${c.blurb}`;
    b.dataset.cat = c.id;
    b.addEventListener("click", () => {
      filterCat = filterCat === c.id ? null : c.id;
      refreshChips();
      renderList(listBox);
    });
    chips.appendChild(b);
  }
  wrap.appendChild(chips);

  const listBox = el("div", { class: "col" });
  listBox.style.marginTop = "10px";
  listBox.style.gap = "0";
  wrap.appendChild(listBox);
  host.appendChild(wrap);

  renderList(listBox);

  function refreshChips(): void {
    for (const b of Array.from(chips.children) as HTMLButtonElement[]) {
      if (b === allChip) {
        b.className = "btn sm" + (filterCat === null ? " primary" : " ghost");
        continue;
      }
      const on = b.dataset.cat === filterCat;
      b.className = "btn sm" + (on ? " primary" : " ghost");
    }
  }
}

// ---------------- 规则包 ----------------

function renderPacks(box: HTMLElement): void {
  box.replaceChildren();
  if (!store.project) return;
  const packs = store.project.packs;
  if (!packs.length) {
    box.appendChild(
      emptyState(
        I.pack,
        "还没有自己的规则包",
        "先在某个对象上调好一组积木，然后点上面的「把当前对象打包」。下面这些是内置模板，可以直接用。",
        button("载入内置模板", () => loadTemplates(), { size: "sm", variant: "primary" })
      )
    );
    return;
  }
  for (const p of packs) {
    box.appendChild(packCard(p));
  }
}

function packCard(pack: RulePack): HTMLElement {
  const card = el("div", { class: "mod-card open" });
  card.style.setProperty("--cat-color", "var(--cat-dialogue)");

  const head = el("div", { class: "mod-head" });
  head.appendChild(el("span", { class: "t" }, pack.name));
  head.appendChild(el("div", { class: "spacer" }));
  card.appendChild(head);

  const body = el("div", { class: "mod-body" });
  body.appendChild(el("div", { class: "blurb" }, pack.blurb || packSummary(pack)));

  // 包内积木清单
  const list = el("div", { class: "col" });
  list.style.gap = "2px";
  for (const m of pack.modules) {
    const def = moduleDef(m.defId);
    const row = el("div", { class: "hint" }, `· ${def ? def.title : `未知模块 ${m.defId}`}`);
    if (def) row.title = `${def.title}（${def.code}）`;
    list.appendChild(row);
  }
  body.appendChild(list);

  const issues = packIssues(pack);
  for (const it of issues) {
    const w = el("div", { class: "hint", style: { color: "var(--warn)" } }, `⚠ ${it}`);
    body.appendChild(w);
  }

  const acts = el("div", { class: "mod-actions" });
  acts.appendChild(
    button("套到选中对象", () => applyToSelection(pack), {
      size: "sm",
      variant: "primary",
      iconPath: I.check,
      disabled: !store.selection.length
    })
  );
  acts.appendChild(
    button("改名", () => renamePack(pack), { size: "sm", variant: "ghost" })
  );
  acts.appendChild(el("div", { class: "spacer" }));
  acts.appendChild(
    button("删除", () => void deletePack(pack), { size: "sm", variant: "ghost", iconPath: I.trash })
  );
  body.appendChild(acts);
  card.appendChild(body);

  // 拖到画布上整包生效
  card.draggable = true;
  card.addEventListener("dragstart", (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (!dt) return;
    dt.setData("application/x-bwe-pack", pack.id);
    dt.setData("text/plain", pack.id);
    dt.effectAllowed = "copy";
  });
  card.addEventListener("dblclick", () => applyToSelection(pack));
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: "套到选中对象", onClick: () => applyToSelection(pack), disabled: !store.selection.length },
      { label: "套到当前场景所有同类对象", onClick: () => applyToSameKind(pack) },
      { divider: true },
      { label: "改名", onClick: () => renamePack(pack) },
      { label: "复制一份", onClick: () => duplicatePack(pack) },
      { label: "删除", onClick: () => void deletePack(pack) }
    ]);
  });
  return card;
}

function applyToSelection(pack: RulePack): void {
  if (!store.selection.length) {
    warn("先在画布上选一个对象");
    return;
  }
  let added = 0;
  let overwritten = 0;
  for (const o of store.selection) {
    const r = applyPack(o.id, pack);
    if (r) {
      added += r.added;
      overwritten += r.overwritten;
    }
  }
  const parts = [`新增 ${added} 块积木`];
  if (overwritten) parts.push(`覆盖 ${overwritten} 块同类`);
  ok(`已套用「${pack.name}」：${parts.join("，")}`);
  window.dispatchEvent(new CustomEvent("bwe:commit"));
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
}

function applyToSameKind(pack: RulePack): void {
  const scene = store.scene;
  const one = store.single;
  if (!scene || !one) {
    warn("先只选中一个对象，再执行这个操作");
    return;
  }
  const same = scene.objects.filter((o) => o.kind === one.kind);
  if (same.length <= 1) {
    info(`场景里没有其他「${one.kind}」类型的对象`);
    return;
  }
  void confirmDialog(
    `把「${pack.name}」套到 ${same.length} 个同类对象？`,
    "同名模块会被覆盖参数，其余会追加。",
    "套用"
  ).then((yes) => {
    if (!yes) return;
    let n = 0;
    for (const o of same) {
      if (applyPack(o.id, pack)) n++;
    }
    ok(`已套用到 ${n} 个对象`);
    window.dispatchEvent(new CustomEvent("bwe:commit"));
    window.dispatchEvent(new CustomEvent("bwe:refresh"));
  });
}

function packSelected(): void {
  const one = store.single;
  if (!one) {
    warn("先在画布上只选中一个对象");
    info("打包的作用是：把「这一个对象上的一整套模块」存起来复用");
    return;
  }
  if (!one.modules.length) {
    warn(`「${one.name}」身上还没有模块`);
    info("先给它加几块积木，再打包");
    return;
  }
  modal({
    title: "把当前对象打包",
    body: () => {
      const box = el("div", { class: "col" });
      box.appendChild(
        el("div", { class: "hint" }, `将把「${one.name}」身上的 ${one.modules.length} 块积木存成一个规则包。`)
      );
      const nameField = el("div", { class: "field" });
      nameField.appendChild(el("label", null, "包名 Name"));
      const nameI = input(`${one.name} 配置`, { hint: "起个好记的名字，之后一眼能认出来" });
      nameField.appendChild(nameI);
      box.appendChild(nameField);
      const blurbField = el("div", { class: "field" });
      blurbField.appendChild(el("label", null, "说明 Description"));
      const blurbI = input("", { placeholder: "这个包用来做什么（可留空）" });
      blurbField.appendChild(blurbI);
      box.appendChild(blurbField);

      (box as unknown as { __submit?: () => void }).__submit = () => {
        if (!store.project) return;
        const pack = packFromModules(nameI.value.trim() || `${one.name} 配置`, blurbI.value.trim(), one.modules);
        store.project.packs.push(pack);
        store.markDirty();
        ok(`已存成规则包「${pack.name}」`);
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      };
      return box;
    },
    actions: [
      {
        label: "保存为规则包",
        variant: "primary",
        onClick: (close) => {
          (close as unknown as { __submit?: () => void }).__submit?.();
          close();
        }
      },
      { label: "取消", variant: "ghost", onClick: (close) => close() }
    ]
  });
}

function renamePack(pack: RulePack): void {
  modal({
    title: "重命名规则包",
    body: () => {
      const box = el("div", { class: "col" });
      const nf = el("div", { class: "field" });
      nf.appendChild(el("label", null, "包名 Name"));
      const nameI = input(pack.name);
      nf.appendChild(nameI);
      box.appendChild(nf);
      const df = el("div", { class: "field" });
      df.appendChild(el("label", null, "说明 Description"));
      const descI = input(pack.blurb);
      df.appendChild(descI);
      box.appendChild(df);
      (box as unknown as { __submit?: () => void }).__submit = () => {
        pack.name = nameI.value.trim() || pack.name;
        pack.blurb = descI.value.trim();
        store.markDirty();
        ok("已更新");
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      };
      return box;
    },
    actions: [
      {
        label: "保存",
        variant: "primary",
        onClick: (close) => {
          (close as unknown as { __submit?: () => void }).__submit?.();
          close();
        }
      },
      { label: "取消", variant: "ghost", onClick: (close) => close() }
    ]
  });
}

function duplicatePack(pack: RulePack): void {
  if (!store.project) return;
  const copy: RulePack = JSON.parse(JSON.stringify(pack));
  copy.id = crypto.randomUUID();
  copy.name = pack.name + " 副本";
  store.project.packs.push(copy);
  store.markDirty();
  ok("已复制规则包");
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
}

async function deletePack(pack: RulePack): Promise<void> {
  if (!store.project) return;
  const yes = await confirmDialog(
    `删除规则包「${pack.name}」？`,
    "已经套到对象上的模块不受影响，只是这个包本身没了。",
    "删除",
    true
  );
  if (!yes) return;
  store.project.packs = store.project.packs.filter((p) => p.id !== pack.id);
  store.markDirty();
  ok("已删除规则包");
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
}

function loadTemplates(): void {
  void import("../data/packs.ts").then(({ builtinPacks }) => {
    if (!store.project) return;
    const tpl = builtinPacks();
    for (const p of tpl) {
      if (!store.project.packs.some((x) => x.name === p.name)) store.project.packs.push(p);
    }
    store.markDirty();
    ok(`已载入 ${tpl.length} 个内置模板`);
    window.dispatchEvent(new CustomEvent("bwe:refresh"));
  });
}

// ---------------- 所有积木 ----------------

function renderList(box: HTMLElement): void {
  box.replaceChildren();
  const q = searchText.trim();

  if (q) {
    const found = searchModules(q).filter((m) => !filterCat || m.category === filterCat);
    if (!found.length) {
      box.appendChild(emptyState(I.search, "没有匹配的模块", "换个词试试，比如「移动」「点击」「范围」「血量」。"));
      return;
    }
    for (const m of found) box.appendChild(moduleRow(m));
    return;
  }

  for (const cat of MODULE_CATEGORIES) {
    if (filterCat && filterCat !== cat.id) continue;
    const list = searchModules("").filter((m) => m.category === cat.id);
    if (!list.length) continue;
    const label = el("div", { class: "group-label" }, cat.label);
    label.style.setProperty("--cat-color", cat.color);
    box.appendChild(label);
    const sub = el("div", { class: "hint" }, cat.blurb);
    sub.style.marginBottom = "6px";
    box.appendChild(sub);
    for (const m of list) box.appendChild(moduleRow(m));
    box.appendChild(el("div", { style: { height: "6px" } }));
  }
}

function moduleRow(def: ModuleDef): HTMLElement {
  const cat = categoryOf(def.category);
  const row = el("div", { class: "module-row" });
  row.style.setProperty("--cat-color", cat.color);
  row.appendChild(el("div", { class: "t" }, def.title));
  row.appendChild(el("div", { class: "d" }, def.blurb));
  row.title = `${def.title}（${def.code}）\n${def.detail}`;

  row.draggable = true;
  row.addEventListener("dragstart", (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (!dt) return;
    dt.setData("application/x-bwe-module", def.id);
    dt.setData("text/plain", def.id);
    dt.effectAllowed = "copy";
  });

  const attach = (toAll: boolean) => {
    if (!store.selection.length) {
      warn("先在画布上选一个对象，再加模块");
      info("模块是加在对象身上的：先点中一个角色或物件");
      return;
    }
    const targets = toAll ? store.selection : [store.selection[0]];
    for (const o of targets) {
      o.modules.push(makeInstance(def));
    }
    store.markDirty();
    ok(`已给 ${targets.length} 个对象加上「${def.title}」`);
    window.dispatchEvent(new CustomEvent("bwe:commit"));
    window.dispatchEvent(new CustomEvent("bwe:refresh"));
  };

  row.addEventListener("dblclick", () => attach(false));
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: "加到第一个选中对象", onClick: () => attach(false) },
      { label: "加到全部选中对象", onClick: () => attach(true), disabled: store.selection.length < 2 },
      { divider: true },
      { label: `类别：${cat.label}`, disabled: true },
      { label: def.code, disabled: true }
    ]);
  });
  return row;
}

void error;
