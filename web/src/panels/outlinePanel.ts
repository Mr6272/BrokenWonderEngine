/**
 * 场景对象大纲面板。
 *
 * 以树状列表展示当前场景的所有对象，按图层分组。
 * 点击条目可选中画布上的对象；悬停显示类型、位置、模块数。
 * 对于地图对象多的场景，比左栏场景列表更便于定位和管理。
 */

import type { SceneObject } from "../core/model.ts";
import { store } from "../core/store.ts";
import { el, button } from "../core/dom.ts";
import { I, iconForKind } from "../ui/icons.ts";
import { ok, info } from "../ui/toast.ts";

export function renderOutlinePanel(host: HTMLElement): void {
  host.replaceChildren();
  const wrap = el("div", { class: "col" });
  wrap.style.padding = "10px";

  if (!store.project) {
    wrap.appendChild(el("div", { class: "hint" }, "还没有打开工程"));
    host.appendChild(wrap);
    return;
  }

  const scene = store.scene;
  if (!scene) {
    wrap.appendChild(el("div", { class: "hint" }, "没有当前场景"));
    host.appendChild(wrap);
    return;
  }

  // 头部：对象总数 + 全选/全不选
  const head = el("div", { class: "row tight" });
  head.appendChild(el("div", { class: "group-label" }, `对象大纲（${scene.objects.length}）`));
  head.appendChild(el("div", { class: "spacer" }));
  head.appendChild(
    button("全部选中", () => {
      store.selectMany(scene.objects.filter((o) => !o.locked));
      ok(`已选中 ${scene.objects.length} 个对象`);
    }, { size: "sm" })
  );
  head.appendChild(
    button("清空选择", () => {
      store.clearSelection();
    }, { size: "sm", variant: "ghost" })
  );
  wrap.appendChild(head);

  // 按图层分组
  const layerMap = new Map<string, SceneObject[]>();
  for (const l of scene.layers) layerMap.set(l.id, []);
  const unlayered: SceneObject[] = [];
  for (const o of scene.objects) {
    const arr = layerMap.get(o.layerId);
    if (arr) arr.push(o);
    else unlayered.push(o);
  }

  for (const l of scene.layers) {
    const objs = layerMap.get(l.id) ?? [];
    if (!objs.length && l.visible && !l.locked) continue;

    const layerSection = el("div", { class: "card" });
    const layerHead = el("header");
    layerHead.appendChild(
      el("span", null, `${l.name}（${objs.length}）`)
    );
    const eye = el("span", { title: l.visible ? "隐藏图层" : "显示图层", style: { cursor: "pointer", marginLeft: "auto" } });
    eye.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "svg"));
    const svgEl = eye.firstChild as SVGSVGElement;
    svgEl.setAttribute("viewBox", "0 0 24 24");
    svgEl.setAttribute("width", "14");
    svgEl.setAttribute("height", "14");
    svgEl.setAttribute("fill", "none");
    svgEl.setAttribute("stroke", "currentColor");
    svgEl.setAttribute("stroke-width", "1.8");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", l.visible ? I.eye : "M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z");
    svgEl.appendChild(p);
    layerHead.appendChild(eye);
    eye.addEventListener("click", () => {
      l.visible = !l.visible;
      store.markDirty();
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
      window.dispatchEvent(new CustomEvent("bwe:refresh"));
    });
    layerSection.appendChild(layerHead);

    const body = el("div", { class: "body" });
    body.style.padding = "6px 10px";
    for (const o of objs) {
      body.appendChild(outlineItem(o));
    }
    layerSection.appendChild(body);
    wrap.appendChild(layerSection);
  }

  if (unlayered.length) {
    const section = el("div", { class: "card" });
    section.appendChild(el("header", null, `未分层（${unlayered.length}）`));
    const body = el("div", { class: "body" });
    body.style.padding = "6px 10px";
    for (const o of unlayered) body.appendChild(outlineItem(o));
    section.appendChild(body);
    wrap.appendChild(section);
  }

  host.appendChild(wrap);
}

function outlineItem(o: SceneObject): HTMLElement {
  const item = el("div", { class: "item" + (store.isSelected(o) ? " selected" : "") });
  item.style.padding = "4px 8px";
  item.style.gap = "8px";

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "14");
  icon.setAttribute("height", "14");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.6");
  const ip = document.createElementNS("http://www.w3.org/2000/svg", "path");
  ip.setAttribute("d", iconForKind(o.kind));
  icon.appendChild(ip);
  icon.style.color = o.locked ? "var(--text-3)" : "var(--text-2)";
  item.appendChild(icon);

  const grow = el("div", { class: "grow" });
  const name = el("div", { class: "name" }, o.name || "(无名)");
  name.title = o.name;
  grow.appendChild(name);
  const sub = el("div", { class: "sub" });
  sub.textContent = `${o.kind}　·　${Math.round(o.x)},${Math.round(o.y)}　·　模块 ${o.modules.length}`;
  grow.appendChild(sub);
  item.appendChild(grow);

  if (o.locked) {
    const lock = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    lock.setAttribute("viewBox", "0 0 24 24");
    lock.setAttribute("width", "12");
    lock.setAttribute("height", "12");
    lock.setAttribute("fill", "none");
    lock.setAttribute("stroke", "currentColor");
    lock.setAttribute("stroke-width", "1.6");
    const lp = document.createElementNS("http://www.w3.org/2000/svg", "path");
    lp.setAttribute("d", I.lock);
    lock.appendChild(lp);
    lock.style.color = "var(--text-3)";
    item.appendChild(lock);
  }

  item.addEventListener("click", () => {
    store.select(o);
    window.dispatchEvent(new CustomEvent("bwe:open-modules"));
    info(`已选中「${o.name || o.kind}」`);
  });
  // 双击 = 聚焦：在列表里找到对象之后，最想知道的就是「它在地图哪儿」。
  // zoom:true 连缩放一起调 —— 地图缩到 46% 时只居中，用户还是看不清这个小物件。
  item.addEventListener("dblclick", () => {
    store.select(o);
    window.dispatchEvent(new CustomEvent("bwe:focus-object", { detail: { id: o.id, zoom: true } }));
    window.dispatchEvent(new CustomEvent("bwe:refresh"));
  });

  return item;
}
