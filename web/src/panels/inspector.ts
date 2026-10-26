/**
 * 右栏「对象 Inspector」—— 编辑器里停留最久的界面。
 *
 * 结构固定为两块，顺序不乱：
 *   上：这个对象是什么、在哪、长什么样（对应 Unity 的 Transform / Sprite Renderer）
 *   下：模块概览（真正的模块编辑在独立窗口里完成）
 *
 * 为什么模块编辑要拆出去：右侧栏宽度有限，模块参数（滑块 + 数字框 + 素材名）
 * 挤在这里必然互相抢位置。右栏只保留"一眼看清挂了什么"，点一下打开宽屏工作台。
 */

import type { SceneObject } from "../core/model.ts";
import { moduleDef, categoryOf, moduleSummary } from "../data/modules.ts";
import { store } from "../core/store.ts";
import { el, input, button, select, switchToggle, fieldRow, numText } from "../core/dom.ts";
import { I, iconForKind } from "../ui/icons.ts";
import { KINDS } from "../ui/terms.ts";
import { ok, info, warn, confirmDialog } from "../ui/toast.ts";
import { openModuleEditor } from "./moduleEditor.ts";

export function renderInspector(host: HTMLElement): void {
  host.replaceChildren();
  const wrap = el("div", { class: "col" });
  wrap.style.padding = "10px";

  if (!store.project) {
    wrap.appendChild(el("div", { class: "hint" }, "还没有打开工程"));
    host.appendChild(wrap);
    return;
  }

  const sel = store.selection;
  if (!sel.length) {
    host.appendChild(emptyInspector());
    return;
  }
  if (sel.length > 1) {
    wrap.appendChild(multiSelectCard(sel));
    host.appendChild(wrap);
    return;
  }

  const obj = sel[0];
  wrap.appendChild(identityCard(obj));
  wrap.appendChild(placeCard(obj));
  wrap.appendChild(modulesCard(obj));
  host.appendChild(wrap);
}

function emptyInspector(): HTMLElement {
  const box = el("div", { class: "col" });
  box.style.padding = "10px";
  box.appendChild(
    el(
      "div",
      { class: "empty" },
      (() => {
        const ns = "http://www.w3.org/2000/svg";
        const s = document.createElementNS(ns, "svg");
        s.setAttribute("viewBox", "0 0 24 24");
        s.setAttribute("width", "30");
        s.setAttribute("height", "30");
        s.setAttribute("fill", "none");
        s.setAttribute("stroke", "currentColor");
        s.setAttribute("stroke-width", "1.6");
        s.setAttribute("class", "icon");
        const p = document.createElementNS(ns, "path");
        p.setAttribute("d", I.target);
        s.appendChild(p);
        return s;
      })(),
      el("div", { class: "t" }, "还没选中对象"),
      el("div", { class: "d" }, "在画布上点一个角色或物件，这里就会出现它的属性与模块。框选可以一次处理多个。")
    )
  );
  return box;
}

// ---------------- 身份 ----------------

function identityCard(obj: SceneObject): HTMLElement {
  const box = el("div", { class: "col" });

  const id = el("div", { class: "identity" });
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.8");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", iconForKind(obj.kind));
  icon.appendChild(p);
  icon.style.color = "var(--text-2)";
  id.appendChild(icon);
  id.appendChild(el("span", { class: "kind-badge" }, `${KINDS[obj.kind].cn} ${KINDS[obj.kind].en}`));
  id.appendChild(el("div", { class: "spacer" }));
  box.appendChild(id);

  const nameI = input(obj.name, {
    placeholder: "对象名称",
    onChange: (v) => {
      const t = v.trim();
      if (t && t !== obj.name) {
        obj.name = t;
        store.markDirty();
        window.dispatchEvent(new CustomEvent("bwe:repaint"));
      }
    }
  });
  box.appendChild(fieldRow("名称 Name", nameI));

  const kindSel = select(
    (Object.keys(KINDS) as (keyof typeof KINDS)[]).map((k) => ({ value: k, label: `${KINDS[k].cn} ${KINDS[k].en}` })),
    obj.kind,
    {
      onChange: (v) => {
        obj.kind = v as SceneObject["kind"];
        store.markDirty();
        info(KINDS[obj.kind].hint);
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      }
    }
  );
  box.appendChild(fieldRow("类型 Type", kindSel, KINDS[obj.kind].hint));

  const tagI = input(obj.tags.join(","), {
    placeholder: "标签，逗号分开",
    hint: "标签用于批量匹配：给所有敌人打上「敌人」，范围检测就能一次全管",
    onChange: (v) => {
      const tags = v
        .split(/[,，、|]/)
        .map((s) => s.trim())
        .filter(Boolean);
      obj.tags = Array.from(new Set(tags));
      store.markDirty();
    }
  });
  box.appendChild(fieldRow("标签 Tag", tagI));

  const layerSel = select(
    (store.scene?.layers ?? []).map((l) => ({ value: l.id, label: l.name })),
    obj.layerId,
    {
      onChange: (v) => {
        obj.layerId = v;
        store.markDirty();
        window.dispatchEvent(new CustomEvent("bwe:repaint"));
      }
    }
  );
  box.appendChild(fieldRow("图层 Layer", layerSel));

  return cardBox("对象 GameObject", box, iconForKind(obj.kind));
}

// ---------------- 位置与显示 ----------------

function placeCard(obj: SceneObject): HTMLElement {
  const box = el("div", { class: "col" });
  const t = store.project?.tileSize ?? 32;

  const numField = (label: string, value: number, hint: string, set: (v: number) => void, unit?: string) => {
    const i = input(numText(value), {
      numeric: true,
      hint,
      onChange: (v) => {
        const n = Number(v);
        if (Number.isFinite(n)) {
          set(n);
          store.markDirty();
          window.dispatchEvent(new CustomEvent("bwe:repaint"));
        }
      }
    });
    const wrap = el("div", { class: "with-unit" });
    wrap.appendChild(i);
    if (unit) wrap.appendChild(el("span", { class: "unit" }, unit));
    i.style.width = "88px";
    box.appendChild(fieldRow(label, wrap, hint));
  };

  numField("位置 X Position", obj.x, "像素，往右变大（单位 px）", (v) => (obj.x = v), "px");
  numField("位置 Y Position", obj.y, "像素，往下变大（俯视角 Y 轴向下）", (v) => (obj.y = v), "px");
  numField("旋转 Rotation", obj.rotation, "角度，顺时针", (v) => (obj.rotation = v), "°");
  numField("缩放 X Scale", obj.scaleX, "1 表示原始大小", (v) => (obj.scaleX = Math.max(0.05, v)), "×");
  numField("缩放 Y Scale", obj.scaleY, "", (v) => (obj.scaleY = Math.max(0.05, v)), "×");
  numField("排序层级 Sort Order", obj.z, "数值大的盖住小的", (v) => (obj.z = Math.round(v)));

  const colliderHead = el("div", { class: "group-label" }, "碰撞体 Collider 2D");
  box.appendChild(colliderHead);
  numField("半宽 Half W", obj.halfW, "0 表示不参与碰撞", (v) => (obj.halfW = Math.max(0, v)), "px");
  numField("半高 Half H", obj.halfH, "", (v) => (obj.halfH = Math.max(0, v)), "px");

  const quick = el("div", { class: "row tight" });
  quick.appendChild(
    button("按精灵尺寸", () => {
      const a = store.findAsset(obj.assetId);
      if (!a) {
        warn("这个对象还没有绑定精灵");
        return;
      }
      obj.halfW = Math.round((a.width || t) / 2);
      obj.halfH = Math.round((a.height || t) / 2);
      store.markDirty();
      window.dispatchEvent(new CustomEvent("bwe:refresh"));
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
    }, { size: "sm" })
  );
  quick.appendChild(
    button("一格大小", () => {
      obj.halfW = Math.round(t / 2);
      obj.halfH = Math.round(t / 2);
      store.markDirty();
      window.dispatchEvent(new CustomEvent("bwe:refresh"));
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
    }, { size: "sm" })
  );
  quick.appendChild(
    button("清空碰撞体", () => {
      obj.halfW = 0;
      obj.halfH = 0;
      store.markDirty();
      window.dispatchEvent(new CustomEvent("bwe:refresh"));
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
    }, { size: "sm" })
  );
  box.appendChild(quick);

  const toggles = el("div", { class: "row" });
  toggles.appendChild(
    labeledSwitch("显示 Visible", obj.visible, (v) => {
      obj.visible = v;
      store.markDirty();
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
    })
  );
  toggles.appendChild(
    labeledSwitch("锁定 Locked", obj.locked, (v) => {
      obj.locked = v;
      store.markDirty();
      window.dispatchEvent(new CustomEvent("bwe:hint", { detail: v ? "已锁定，画布上点不到它了" : "已解锁" }));
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
    })
  );
  box.appendChild(toggles);

  // 动画设置
  const sprite = store.findAsset(obj.assetId);
  if (sprite && sprite.kind !== "AUDIO") {
    const animHead = el("div", { class: "group-label" }, "精灵与动画 Sprite / Animation");
    box.appendChild(animHead);
    const modeSel = select(
      [
        { value: "默认", label: "默认（循环播放）" },
        { value: "只显示首帧", label: "只显示首帧" },
        { value: "单次播放", label: "单次播放" }
      ],
      obj.animMode,
      {
        onChange: (v) => {
          obj.animMode = v;
          store.markDirty();
          window.dispatchEvent(new CustomEvent("bwe:repaint"));
        }
      }
    );
    box.appendChild(fieldRow("播放模式 Mode", modeSel));
    const fps = input(numText(obj.animFps), {
      numeric: true,
      onChange: (v) => {
        const n = Math.max(1, Math.min(60, Number(v) || 8));
        obj.animFps = n;
        store.markDirty();
        window.dispatchEvent(new CustomEvent("bwe:repaint"));
      }
    });
    box.appendChild(fieldRow("帧率 Frame Rate", fps, "每秒播放几帧"));
  }

  return cardBox("变换与显示 Transform", box);
}

function labeledSwitch(label: string, init: boolean, onChange: (v: boolean) => void): HTMLElement {
  const box = el("div", { class: "row tight" });
  box.appendChild(switchToggle(init, onChange));
  box.appendChild(el("span", { class: "hint" }, label));
  return box;
}

// ---------------- 模块概览 ----------------

function modulesCard(obj: SceneObject): HTMLElement {
  const box = el("div", { class: "col" });

  const head = el("div", { class: "row tight" });
  head.appendChild(el("div", { class: "group-label" }, `模块 Modules（${obj.modules.length}）`));
  head.appendChild(el("div", { class: "spacer" }));
  head.appendChild(
    button("编辑模块", () => openModuleEditor(obj), {
      size: "sm",
      variant: "primary",
      iconPath: I.module,
      title: "打开独立的模块编辑器"
    })
  );
  box.appendChild(head);

  if (!obj.modules.length) {
    box.appendChild(
      el(
        "div",
        { class: "hint" },
        "这个对象还没挂模块，所以不会做任何事。打开模块编辑器，从「玩法」「移动」「渲染」里挑一块。"
      )
    );
    box.appendChild(
      button("打开模块编辑器", () => openModuleEditor(obj, { picking: true }), {
        size: "sm",
        variant: "outline",
        iconPath: I.plus
      })
    );
    return cardBox("模块 Modules", box);
  }

  const list = el("div", { class: "mod-overview" });
  obj.modules.forEach((inst, idx) => {
    const def = moduleDef(inst.defId);
    const cat = def ? categoryOf(def.category) : null;
    const row = el("div", {
      class: "mod-overview-row" + (inst.enabled ? "" : " off"),
      role: "button",
      tabindex: "0",
      title: "打开模块编辑器调整参数"
    });
    row.style.setProperty("--cat-color", cat?.color ?? "var(--line)");
    row.appendChild(el("span", { class: "mod-overview-dot" }));
    const text = el("div", { class: "mod-overview-text" });
    text.appendChild(el("div", { class: "t" }, def?.title ?? inst.defId));
    text.appendChild(el("div", { class: "s" }, inst.enabled ? moduleSummary(def, inst) : "已停用 · 参数保留"));
    row.appendChild(text);
    row.appendChild(el("span", { class: "mod-overview-go" }, "编辑 ›"));
    const open = () => openModuleEditor(obj, { selectedIndex: idx });
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
    list.appendChild(row);
  });
  box.appendChild(list);
  box.appendChild(
    el("div", { class: "hint" }, "模块编辑器是独立窗口：左列拖「⠿」排序，右列调参数；滑块和数字框不会再触发拖动。")
  );
  return cardBox("模块 Modules", box);
}

// ---------------- 批量编辑 ----------------

function multiSelectCard(sel: SceneObject[]): HTMLElement {
  const box = el("div", { class: "col" });
  box.appendChild(
    el("div", { class: "hint" }, `共选中 ${sel.length} 个对象。下面这些改动会同时作用到全部选中对象。`)
  );

  const row1 = el("div", { class: "row tight" });
  row1.appendChild(
    button("全部显示", () => {
      for (const o of sel) o.visible = true;
      store.markDirty();
      ok(`已显示 ${sel.length} 个对象`);
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
    }, { size: "sm" })
  );
  row1.appendChild(
    button("全部隐藏", () => {
      for (const o of sel) o.visible = false;
      store.markDirty();
      ok(`已隐藏 ${sel.length} 个对象`);
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
    }, { size: "sm" })
  );
  box.appendChild(row1);

  const row2 = el("div", { class: "row tight" });
  row2.appendChild(
    button("纵向对齐", () => {
      const x = sel[0].x;
      for (const o of sel) o.x = x;
      store.markDirty();
      ok("已按第一个对象的 X 对齐");
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
    }, { size: "sm" })
  );
  row2.appendChild(
    button("横向对齐", () => {
      const y = sel[0].y;
      for (const o of sel) o.y = y;
      store.markDirty();
      ok("已按第一个对象的 Y 对齐");
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
    }, { size: "sm" })
  );
  row2.appendChild(
    button("按行列排布", () => {
      const t = store.project?.tileSize ?? 32;
      sel.forEach((o, i) => {
        o.x = sel[0].x;
        o.y = sel[0].y + i * t;
      });
      store.markDirty();
      ok("已按纵向一格间距排开");
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
    }, { size: "sm" })
  );
  box.appendChild(row2);

  const row3 = el("div", { class: "row tight" });
  row3.appendChild(
    button("一起加模块", () => {
      info("去左栏「模块」页，对着积木点右键可以选「加到全部选中对象」");
      window.dispatchEvent(new CustomEvent("bwe:open-modules"));
    }, { size: "sm", iconPath: I.plus })
  );
  row3.appendChild(
    button("全部删除", () => {
      void confirmDialog(`删除 ${sel.length} 个对象？`, "这一步不能撤销。", "全部删除", true).then((yes) => {
        if (!yes || !store.scene) return;
        const kill = new Set(sel);
        store.scene.objects = store.scene.objects.filter((o) => !kill.has(o));
        store.clearSelection();
        store.markDirty();
        ok(`已删除 ${kill.size} 个对象`);
        window.dispatchEvent(new CustomEvent("bwe:repaint"));
      });
    }, { size: "sm", variant: "danger", iconPath: I.trash })
  );
  box.appendChild(row3);

  return cardBox(`批量编辑 ${sel.length} 个对象`, box);
}

/** 统一卡片外壳（与 CSS 的 .card 对应）。 */
function cardBox(title: string, body: HTMLElement, iconPath?: string): HTMLElement {
  const card = el("div", { class: "card" });
  const head = el("header");
  if (iconPath) {
    const ns = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", "14");
    s.setAttribute("height", "14");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "1.8");
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", iconPath);
    s.appendChild(p);
    head.appendChild(s);
  }
  head.appendChild(el("span", null, title));
  card.appendChild(head);
  card.appendChild(el("div", { class: "body" }, body));
  return card;
}
