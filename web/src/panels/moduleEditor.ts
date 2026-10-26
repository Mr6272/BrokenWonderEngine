/**
 * 独立模块编辑器。
 *
 * 为什么从右侧 Inspector 拆出来：
 *   模块参数是编辑器里改得最频繁的东西，挤在对象属性下面只有 300px 宽，
 *   数字框、滑块、素材名全在抢位置。这里给模块一个真正的工作台：
 *   左列是模块栈（拖手柄排序），右列是当前模块的完整参数区。
 *
 * 拖拽纪律：只有左侧的「⠿」手柄 draggable，卡片本身和参数控件都不是拖拽源，
 * 所以在滑块上拖动只会改数值，绝不会把模块拖走。
 */

import type { ModuleCategoryId, ModuleDef, ModuleInstance, SceneObject } from "../core/model.ts";
import { MODULE_CATEGORIES, categoryOf, makeInstance, moduleDef, searchModules } from "../data/modules.ts";
import { store } from "../core/store.ts";
import { el, input, button, select, switchToggle, fieldRow, stepper, sliderWithInput, paramResetButton } from "../core/dom.ts";
import { I } from "../ui/icons.ts";
import { KINDS, TRIGGERS, triggerOptions } from "../ui/terms.ts";
import { contextMenu, info, ok, warn, confirmDialog, modal } from "../ui/toast.ts";

export interface ModuleEditorOpts {
  /** 打开时直接进入「添加模块」页 */
  picking?: boolean;
  /** 打开时选中第几块积木 */
  selectedIndex?: number;
}

export function openModuleEditor(target?: SceneObject | null, opts: ModuleEditorOpts = {}): void {
  if (!store.project) {
    warn("还没有打开工程");
    return;
  }
  const picked = target ?? store.single;
  if (!picked || !store.scene?.objects.includes(picked)) {
    warn("先在画布上选中一个对象，再打开模块编辑器");
    return;
  }
  const obj: SceneObject = picked;
  if (store.selection.length > 1 && !target) {
    warn("模块编辑器一次只编辑一个对象，已使用第一个选中的对象");
  }

  let selected = Math.max(0, Math.min(obj.modules.length - 1, opts.selectedIndex ?? 0));
  let picking = opts.picking === true || obj.modules.length === 0;
  let query = "";
  let filter: ModuleCategoryId | null = null;
  let dragFrom = -1;

  const side = el("div", { class: "me-side" });
  const main = el("div", { class: "me-main" });

  const close = modal({
    title: `模块编辑器 — ${obj.name || "未命名对象"}`,
    xwide: true,
    body: () => {
      const wrap = el("div", { class: "me-wrap" });
      const top = el("div", { class: "me-top" });

      const who = el("div", { class: "me-who" });
      who.appendChild(el("span", { class: "me-kind" }, KINDS[obj.kind]?.cn ?? obj.kind));
      who.appendChild(el("strong", null, obj.name || "未命名对象"));
      who.appendChild(el("span", { class: "hint" }, `${obj.modules.length} 块积木 · 拖左侧「⠿」排序`));
      top.appendChild(who);
      top.appendChild(el("div", { class: "spacer" }));

      top.appendChild(button("＋ 添加模块", () => {
        picking = true;
        query = "";
        filter = null;
        render();
      }, { size: "sm", variant: "primary", iconPath: I.plus, title: "从模块库里再挑一块积木" }));

      wrap.appendChild(top);
      wrap.appendChild(el("div", { class: "module-editor" }, side, main));
      render();
      return wrap;
    },
    actions: [
      { label: "完成", variant: "primary", onClick: (c) => c() }
    ],
    onClose: () => {
      refreshBehind();
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
    }
  });

  function refreshBehind(): void {
    window.dispatchEvent(new CustomEvent("bwe:refresh"));
  }

  function render(): void {
    renderSide();
    if (picking) renderPicker();
    else renderDetail();
  }

  // ---------------- 左列：模块栈 ----------------

  function renderSide(): void {
    side.replaceChildren();
    const head = el("div", { class: "me-side-head" });
    head.appendChild(el("div", { class: "group-label" }, `模块栈（${obj.modules.length}）`));
    head.appendChild(el("div", { class: "spacer" }));
    head.appendChild(button("＋", () => {
      picking = true;
      query = "";
      filter = null;
      render();
    }, { size: "sm", variant: "ghost", title: "添加模块" }));
    side.appendChild(head);

    if (!obj.modules.length) {
      side.appendChild(el("div", { class: "me-side-empty" }, "还没有模块。点「＋」从仓库里拿一块。"));
    }

    obj.modules.forEach((inst, idx) => {
      const def = moduleDef(inst.defId);
      const cat = def ? categoryOf(def.category) : null;
      const item = el("div", {
        class: [
          "me-item",
          idx === selected && !picking ? "active" : "",
          inst.enabled ? "" : "off"
        ].filter(Boolean).join(" "),
        title: def ? `${def.title}（${def.code}）\n${def.blurb}` : inst.defId,
        role: "button",
        tabindex: "0"
      });
      item.style.setProperty("--cat-color", cat?.color ?? "var(--line)");

      const handle = el("span", { class: "drag-handle", title: "拖拽调整模块顺序" }, "⠿");
      handle.draggable = true;
      handle.addEventListener("dragstart", (e) => {
        dragFrom = idx;
        const dt = e.dataTransfer;
        if (dt) {
          dt.setData("text/plain", String(idx));
          dt.effectAllowed = "move";
        }
        item.classList.add("dragging");
      });
      handle.addEventListener("dragend", () => {
        dragFrom = -1;
        item.classList.remove("dragging");
        side.querySelectorAll(".drop-target").forEach((n) => n.classList.remove("drop-target"));
      });
      item.appendChild(handle);

      const dot = el("span", { class: "me-dot" });
      item.appendChild(dot);

      const text = el("div", { class: "me-item-text" });
      text.appendChild(el("div", { class: "t" }, def?.title ?? inst.defId));
      text.appendChild(el("div", { class: "s" }, inst.enabled ? (def ? def.blurb : "未知模块") : "已停用 · 参数保留"));
      item.appendChild(text);

      if (!inst.enabled) item.appendChild(el("span", { class: "me-off-badge" }, "停用"));

      item.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".drag-handle")) return;
        selected = idx;
        picking = false;
        render();
      });
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selected = idx;
          picking = false;
          render();
        }
      });

      item.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (dragFrom !== idx) item.classList.add("drop-target");
      });
      item.addEventListener("dragleave", () => item.classList.remove("drop-target"));
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        item.classList.remove("drop-target");
        const from = Number(e.dataTransfer?.getData("text/plain") ?? dragFrom);
        if (!Number.isInteger(from) || from < 0 || from >= obj.modules.length || from === idx) return;
        const [m] = obj.modules.splice(from, 1);
        obj.modules.splice(idx, 0, m);
        selected = idx;
        dragFrom = -1;
        store.markDirty();
        refreshBehind();
        ok("模块顺序已调整");
        render();
      });

      side.appendChild(item);
    });

    side.appendChild(el("div", { class: "me-side-hint hint" }, "只有「⠿」能拖；滑块、数字框、开关都不会触发排序。"));
  }

  // ---------------- 右列：添加模块 ----------------

  function renderPicker(): void {
    main.replaceChildren();
    const head = el("div", { class: "me-main-head" });
    head.appendChild(button("← 返回", () => {
      picking = false;
      render();
    }, { size: "sm", variant: "ghost" }));
    head.appendChild(el("div", { class: "me-main-title" }, "添加模块"));
    head.appendChild(el("div", { class: "spacer" }));
    head.appendChild(el("span", { class: "hint" }, "点一下立刻挂到当前对象上"));
    main.appendChild(head);

    const search = input(query, {
      placeholder: "搜索模块名、参数或分类…",
      width: "100%",
      onChange: (v) => {
        query = v;
        renderPickerList(list);
      }
    });
    search.classList.add("me-search");
    main.appendChild(search);

    const chips = el("div", { class: "me-chips" });
    const all = el("button", { type: "button", class: "me-chip" + (filter === null ? " active" : "") }, "全部");
    all.addEventListener("click", () => {
      filter = null;
      updateChips();
      renderPickerList(list);
    });
    chips.appendChild(all);
    for (const cat of MODULE_CATEGORIES) {
      const b = el("button", {
        type: "button",
        class: "me-chip" + (filter === cat.id ? " active" : ""),
        title: cat.blurb
      }, cat.label.split(" ")[0]);
      b.style.setProperty("--cat-color", cat.color);
      b.addEventListener("click", () => {
        filter = filter === cat.id ? null : cat.id;
        updateChips();
        renderPickerList(list);
      });
      chips.appendChild(b);
    }
    main.appendChild(chips);

    const list = el("div", { class: "me-picker-list" });
    main.appendChild(list);
    renderPickerList(list);

    function updateChips(): void {
      const buttons = Array.from(chips.children) as HTMLElement[];
      buttons[0]?.classList.toggle("active", filter === null);
      for (let i = 0; i < MODULE_CATEGORIES.length; i++) {
        buttons[i + 1]?.classList.toggle("active", filter === MODULE_CATEGORIES[i].id);
      }
    }
  }

  function renderPickerList(host: HTMLElement): void {
    host.replaceChildren();
    let list = searchModules(query);
    if (filter) list = list.filter((m) => m.category === filter);
    if (!list.length) {
      host.appendChild(el("div", { class: "me-empty" }, "没有匹配的模块。换个关键词，或切到「全部」分类。"));
      return;
    }
    const groups = new Map<ModuleCategoryId, ModuleDef[]>();
    for (const m of list) {
      const arr = groups.get(m.category) ?? [];
      arr.push(m);
      groups.set(m.category, arr);
    }
    for (const cat of MODULE_CATEGORIES) {
      const defs = groups.get(cat.id);
      if (!defs?.length) continue;
      const group = el("div", { class: "me-picker-group" });
      const gh = el("div", { class: "me-picker-group-head" });
      gh.style.setProperty("--cat-color", cat.color);
      gh.appendChild(el("span", { class: "me-dot" }));
      gh.appendChild(el("span", null, cat.label));
      gh.appendChild(el("span", { class: "hint" }, cat.blurb));
      group.appendChild(gh);
      for (const def of defs) {
        const row = el("div", {
          class: "me-pick-row",
          role: "button",
          tabindex: "0"
        });
        row.style.setProperty("--cat-color", cat.color);
        const text = el("div", { class: "me-pick-text" });
        text.appendChild(el("div", { class: "t" }, def.title));
        text.appendChild(el("div", { class: "s" }, def.blurb));
        row.appendChild(text);
        row.appendChild(el("span", { class: "me-code" }, def.code));
        row.appendChild(el("span", { class: "me-pick-add" }, "＋"));
        row.addEventListener("click", () => addModule(def));
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            addModule(def);
          }
        });
        group.appendChild(row);
      }
      host.appendChild(group);
    }
  }

  function addModule(def: ModuleDef): void {
    const inst = makeInstance(def);
    obj.modules.push(inst);
    selected = obj.modules.length - 1;
    picking = false;
    store.markDirty();
    refreshBehind();
    info(`已把「${def.title}」挂到 ${obj.name || "对象"} 上`);
    render();
  }

  // ---------------- 右列：模块参数 ----------------

  function renderDetail(): void {
    main.replaceChildren();
    if (!obj.modules.length) {
      const empty = el("div", { class: "me-empty" });
      empty.appendChild(el("div", { class: "t" }, "这个对象还没有模块"));
      empty.appendChild(el("div", { class: "d" }, "模块决定对象会做什么。先加一块「固定不动」或「换装部件」试试。"));
      empty.appendChild(button("从模块库添加", () => {
        picking = true;
        render();
      }, { variant: "primary", iconPath: I.plus }));
      main.appendChild(empty);
      return;
    }
    selected = Math.max(0, Math.min(obj.modules.length - 1, selected));
    const inst = obj.modules[selected];
    const def = moduleDef(inst.defId);
    if (!def) {
      main.appendChild(el("div", { class: "me-empty" }, `找不到模块定义：${inst.defId}。可能来自更新版本的工程。`));
      return;
    }
    const cat = categoryOf(def.category);

    const head = el("div", { class: "me-detail-head" });
    const badge = el("span", { class: "me-cat" }, cat.label);
    badge.style.setProperty("--cat-color", cat.color);
    head.appendChild(badge);
    head.appendChild(el("div", { class: "me-detail-title" }, def.title));
    head.appendChild(el("span", { class: "me-detail-code" }, def.code));
    head.appendChild(el("div", { class: "spacer" }));
    head.appendChild(switchToggle(inst.enabled, (v) => {
      inst.enabled = v;
      store.markDirty();
      refreshBehind();
      info(v ? `已启用「${def.title}」` : `已停用「${def.title}」（参数保留）`);
      render();
    }, "停用后参数保留，方便做 A/B 对比"));
    head.appendChild(button("", () => {
      const copy: ModuleInstance = {
        defId: inst.defId,
        values: { ...inst.values },
        trigger: inst.trigger,
        enabled: inst.enabled,
        collapsed: false
      };
      obj.modules.splice(selected + 1, 0, copy);
      selected += 1;
      store.markDirty();
      refreshBehind();
      ok("已复制这块积木");
      render();
    }, { size: "sm", variant: "ghost", iconPath: I.copy, title: "复制模块" }));
    head.appendChild(button("", () => moveModule(selected, -1), { size: "sm", variant: "ghost", iconPath: I.up, title: "上移", disabled: selected === 0 }));
    head.appendChild(button("", () => moveModule(selected, 1), { size: "sm", variant: "ghost", iconPath: I.down, title: "下移", disabled: selected === obj.modules.length - 1 }));
    head.appendChild(button("", () => void removeModule(selected, def.title), { size: "sm", variant: "ghost", iconPath: I.trash, title: "移除模块" }));
    main.appendChild(head);

    const blurb = el("div", { class: "me-blurb" });
    blurb.style.setProperty("--cat-color", cat.color);
    blurb.appendChild(el("div", { class: "b" }, def.blurb));
    blurb.appendChild(el("div", { class: "d" }, def.detail));
    main.appendChild(blurb);

    const body = el("div", { class: "me-params" });
    if (def.triggers.length > 1) {
      const cur = inst.trigger ?? def.triggers[0];
      const tSel = select(triggerOptions(def.triggers), cur, {
        onChange: (v) => {
          inst.trigger = v as ModuleInstance["trigger"];
          store.markDirty();
          refreshBehind();
          info(`「${def.title}」改成：${TRIGGERS[v as keyof typeof TRIGGERS].cn}`);
        }
      });
      body.appendChild(fieldRow("触发时机 Event", tSel, TRIGGERS[cur].hint));
    } else if (def.triggers.length === 1) {
      body.appendChild(el("div", { class: "me-trigger hint" }, `触发时机：${TRIGGERS[def.triggers[0]].cn}`));
    }

    for (const p of def.params) {
      body.appendChild(paramRow(inst, p, def, render));
    }
    main.appendChild(body);

    const foot = el("div", { class: "me-detail-foot" });
    foot.appendChild(el("span", { class: "hint" }, "参数会自动保存到工程；关窗口后画布会同步刷新。"));
    main.appendChild(foot);
  }

  function moveModule(idx: number, dir: number): void {
    const to = idx + dir;
    if (to < 0 || to >= obj.modules.length) return;
    const [m] = obj.modules.splice(idx, 1);
    obj.modules.splice(to, 0, m);
    selected = to;
    store.markDirty();
    refreshBehind();
    render();
  }

  async function removeModule(idx: number, title: string): Promise<void> {
    const inst = obj.modules[idx];
    const hasValues = inst && Object.keys(inst.values).length > 0;
    if (hasValues) {
      const yes = await confirmDialog(
        `移除「${title}」？`,
        "这块积木上的参数设置会一起丢掉。只想临时关掉的话，用标题右侧的开关就行，参数会保留。",
        "移除",
        true
      );
      if (!yes) return;
    }
    obj.modules.splice(idx, 1);
    selected = Math.max(0, Math.min(obj.modules.length - 1, selected));
    if (!obj.modules.length) picking = false;
    store.markDirty();
    refreshBehind();
    ok(`已移除「${title}」`);
    render();
  }
}

// ---------------- 参数行 ----------------

function paramRow(
  inst: ModuleInstance,
  p: ModuleDef["params"][number],
  def: ModuleDef,
  rerender: () => void
): HTMLElement {
  const cur = inst.values[p.key] ?? p.def;
  const defaultVal = p.def;

  const reset = () => {
    inst.values[p.key] = defaultVal;
    store.markDirty();
    window.dispatchEvent(new CustomEvent("bwe:refresh"));
    rerender();
  };

  if (p.type === "num") {
    const curNum = Number(cur);
    const value = Number.isFinite(curNum) ? curNum : Number(defaultVal);
    const hasRange = p.min !== undefined || p.max !== undefined;
    const control = hasRange
      ? sliderWithInput({
          value,
          min: p.min ?? 0,
          max: p.max ?? 100,
          step: p.step,
          hint: p.hint,
          onChange: (v) => {
            inst.values[p.key] = String(v);
            store.markDirty();
          }
        })
      : stepper({
          value,
          min: p.min,
          max: p.max,
          step: p.step,
          hint: p.hint,
          onChange: (v) => {
            inst.values[p.key] = String(v);
            store.markDirty();
          }
        });
    control.classList.add("me-control");
    const wrap = el("div", { class: "row tight me-num-row" });
    wrap.appendChild(control);
    if (p.unit) wrap.appendChild(el("span", { class: "unit" }, p.unit));
    wrap.appendChild(paramResetButton(reset));
    return fieldRow(p.label, wrap, p.hint);
  }

  if (p.type === "bool") {
    const on = cur === "开" || cur === "true" || cur === "1";
    const wrap = el("div", { class: "row tight" });
    wrap.appendChild(
      switchToggle(on, (v) => {
        inst.values[p.key] = v ? "开" : "关";
        store.markDirty();
      }, p.hint)
    );
    wrap.appendChild(paramResetButton(reset));
    return fieldRow(p.label, wrap, p.hint);
  }

  if (p.type === "pick" && p.options?.length) {
    if (p.options.length <= 3) {
      const seg = el("div", { class: "segmented" });
      for (const o of p.options) {
        const b = el("button", { type: "button", class: o === cur ? "active" : "" }, o.split(" ")[0]);
        b.title = o;
        b.addEventListener("click", () => {
          inst.values[p.key] = o;
          store.markDirty();
          Array.from(seg.children).forEach((c) => c.classList.remove("active"));
          b.classList.add("active");
        });
        seg.appendChild(b);
      }
      const wrap = el("div", { class: "row tight" });
      wrap.appendChild(seg);
      wrap.appendChild(paramResetButton(reset));
      return fieldRow(p.label, wrap, p.hint);
    }
    const wrap = el("div", { class: "row tight" });
    wrap.appendChild(
      select(
        p.options.map((o) => ({ value: o, label: o })),
        cur,
        {
          onChange: (v) => {
            inst.values[p.key] = v;
            store.markDirty();
          }
        }
      )
    );
    wrap.appendChild(paramResetButton(reset));
    return fieldRow(p.label, wrap, p.hint);
  }

  if (p.type === "note") {
    return el("div", { class: "me-note" }, p.def);
  }

  // obj / asset / tag / script：输入框 + 选择器
  const wrap = el("div", { class: "row tight" });
  const i = input(cur, {
    hint: p.hint,
    placeholder: p.type === "asset" ? "选素材" : p.type === "tag" ? "选标签" : p.type === "script" ? "选剧本" : "选对象",
    onChange: (v) => {
      inst.values[p.key] = v;
      store.markDirty();
    }
  });
  i.style.flex = "1";
  i.classList.add("me-text-input");
  wrap.appendChild(i);
  wrap.appendChild(button("选择", () => openPicker(p, inst, i), { size: "sm", variant: "outline" }));
  wrap.appendChild(paramResetButton(reset));
  return fieldRow(p.label, wrap, p.hint);
}

function openPicker(p: ModuleDef["params"][number], inst: ModuleInstance, target: HTMLInputElement): void {
  const options: { value: string; label: string }[] = [];
  if (p.type === "asset") {
    for (const a of store.assets) options.push({ value: a.name, label: `${a.name}（${a.kind}）` });
  } else if (p.type === "tag") {
    const tags = new Set<string>();
    for (const o of store.scene?.objects ?? []) for (const t of o.tags) tags.add(t);
    for (const t of tags) options.push({ value: t, label: t });
  } else if (p.type === "script") {
    for (const k of Object.keys(store.project?.scripts ?? {})) options.push({ value: k, label: k });
  } else {
    for (const o of store.scene?.objects ?? []) options.push({ value: o.name, label: `${o.name}（${KINDS[o.kind].cn}）` });
  }

  if (!options.length) {
    info(
      p.type === "asset"
        ? "素材库还是空的，先去左栏「素材」导入图片"
        : p.type === "tag"
          ? "还没有对象打过标签。在对象面板的「标签」里填一个"
          : p.type === "script"
            ? "还没有剧本，去左栏「剧本」新建一段"
            : "当前场景还没有其他对象"
    );
    return;
  }

  const r = target.getBoundingClientRect();
  contextMenu(r.left, r.bottom + 2, [
    { label: "（留空 = 不指定）", onClick: () => { inst.values[p.key] = ""; target.value = ""; store.markDirty(); } },
    { divider: true },
    ...options.slice(0, 30).map((o) => ({
      label: o.label,
      onClick: () => {
        inst.values[p.key] = o.value;
        target.value = o.value;
        store.markDirty();
      }
    }))
  ]);
}
