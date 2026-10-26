/**
 * 场景与图层面板。
 *
 * 俯视角 RPG 的典型结构：一张地图一个场景，场景之间用传送口连。
 * 因此刻意做成「场景列表 + 图层开关」两段，不引入嵌套文件夹那类复杂结构。
 */

import type { SceneModel } from "../core/model.ts";
import { createLayer, createScene } from "../core/model.ts";
import { store } from "../core/store.ts";
import { el, input, button, fieldRow, numText } from "../core/dom.ts";
import { I } from "../ui/icons.ts";
import { ok, warn, info, confirmDialog, contextMenu } from "../ui/toast.ts";

export function renderScenePanel(host: HTMLElement): void {
  host.replaceChildren();
  const wrap = el("div", { class: "col" });
  wrap.style.padding = "10px";

  if (!store.project) {
    wrap.appendChild(el("div", { class: "hint" }, "还没有打开工程"));
    host.appendChild(wrap);
    return;
  }

  // ---- 场景列表 ----
  const head = el("div", { class: "row" });
  head.appendChild(el("div", { class: "group-label" }, "场景 Scenes"));
  head.appendChild(el("div", { class: "spacer" }));
  head.appendChild(button("新建", () => newScene(), { size: "sm", variant: "primary", iconPath: I.plus }));
  wrap.appendChild(head);

  const list = el("div", { class: "item-list" });
  for (const s of store.project.scenes) {
    list.appendChild(sceneItem(s));
  }
  wrap.appendChild(list);

  // ---- 当前场景设置 ----
  const scene = store.scene;
  if (scene) {
    const setHead = el("div", { class: "group-label" }, "当前场景 Settings");
    setHead.style.marginTop = "14px";
    wrap.appendChild(setHead);

    const nameI = input(scene.name, {
      hint: "名字会出现在「加载另一张地图」模块的下拉里",
      onChange: (v) => {
        const t = v.trim();
        if (t && t !== scene.name) {
          scene.name = t;
          store.markDirty();
          store.emitScene();
        }
      }
    });
    wrap.appendChild(fieldRow("名称 Name", nameI));

    const wI = input(String(scene.widthTiles), {
      numeric: true,
      onChange: (v) => {
        const n = Math.max(4, Math.min(500, Number(v) || scene.widthTiles));
        scene.widthTiles = n;
        store.markDirty();
        window.dispatchEvent(new CustomEvent("bwe:repaint"));
      }
    });
    wrap.appendChild(fieldRow("宽 Width（格）", wI));

    const hI = input(String(scene.heightTiles), {
      numeric: true,
      onChange: (v) => {
        const n = Math.max(4, Math.min(500, Number(v) || scene.heightTiles));
        scene.heightTiles = n;
        store.markDirty();
        window.dispatchEvent(new CustomEvent("bwe:repaint"));
      }
    });
    wrap.appendChild(fieldRow("高 Height（格）", hI));

    wrap.appendChild(
      el(
        "div",
        { class: "hint" },
        `实际尺寸 ${scene.widthTiles * (store.project.tileSize || 32)} × ${scene.heightTiles * (store.project.tileSize || 32)} px，格子 ${store.project.tileSize}px`
      )
    );

    // ---- 图层 ----
    const layerHead = el("div", { class: "group-label" }, "图层 Layers");
    layerHead.style.marginTop = "14px";
    wrap.appendChild(layerHead);
    const layerList = el("div", { class: "item-list" });
    scene.layers.forEach((l, idx) => {
      const item = el("div", { class: "item" });
      const eye = el("span");
      eye.appendChild(iconSvg(I.eye));
      eye.style.opacity = l.visible ? "1" : ".35";
      eye.style.width = "16px";
      eye.title = l.visible ? "点击隐藏这个图层" : "点击显示这个图层";
      eye.addEventListener("click", (e) => {
        e.stopPropagation();
        l.visible = !l.visible;
        store.markDirty();
        window.dispatchEvent(new CustomEvent("bwe:repaint"));
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      });

      const lock = el("span");
      lock.appendChild(iconSvg(I.lock));
      lock.style.opacity = l.locked ? "1" : ".25";
      lock.style.width = "16px";
      lock.title = l.locked ? "已锁定，点击解锁" : "点击锁定，防止误拖";
      lock.addEventListener("click", (e) => {
        e.stopPropagation();
        l.locked = !l.locked;
        store.markDirty();
        info(l.locked ? `图层「${l.name}」已锁定` : `图层「${l.name}」已解锁`);
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      });

      const grow = el("div", { class: "grow" });
      grow.appendChild(el("div", { class: "name" }, l.name));
      const count = scene.objects.filter((o) => o.layerId === l.id).length;
      grow.appendChild(el("div", { class: "sub" }, `${count} 个对象`));

      item.appendChild(eye);
      item.appendChild(grow);
      item.appendChild(lock);
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: "上移一层", disabled: idx === 0, onClick: () => moveLayer(idx, -1) },
          { label: "下移一层", disabled: idx === scene.layers.length - 1, onClick: () => moveLayer(idx, 1) },
          { divider: true },
          {
            label: "删除该图层",
            disabled: scene.layers.length <= 1,
            onClick: () => void removeLayer(l.id)
          }
        ]);
      });
      layerList.appendChild(item);
    });
    wrap.appendChild(layerList);
    wrap.appendChild(
      button("新建图层", () => {
        const l = createLayer(`图层 ${scene.layers.length + 1}`);
        scene.layers.push(l);
        store.markDirty();
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      }, { size: "sm", iconPath: I.plus })
    );

  }

  host.appendChild(wrap);

  function moveLayer(idx: number, dir: number): void {
    if (!scene) return;
    const to = idx + dir;
    if (to < 0 || to >= scene.layers.length) return;
    const [l] = scene.layers.splice(idx, 1);
    scene.layers.splice(to, 0, l);
    store.markDirty();
    window.dispatchEvent(new CustomEvent("bwe:refresh"));
    window.dispatchEvent(new CustomEvent("bwe:repaint"));
  }

  async function removeLayer(id: string): Promise<void> {
    if (!scene) return;
    const layer = scene.layers.find((l) => l.id === id);
    if (!layer) return;
    if (scene.layers.length <= 1) {
      warn("至少留一个图层");
      return;
    }
    const used = scene.objects.filter((o) => o.layerId === id).length;
    if (used > 0) {
      const yes = await confirmDialog(
        `图层「${layer.name}」上还有 ${used} 个对象`,
        "删掉图层后，这些对象会被移到最后一个图层，不会被删除。",
        "删除图层",
        true
      );
      if (!yes) return;
    }
    const fallback = scene.layers[scene.layers.length - 1];
    scene.layers = scene.layers.filter((l) => l.id !== id);
    for (const o of scene.objects) if (o.layerId === id) o.layerId = fallback.id;
    store.markDirty();
    ok("图层已删除");
    window.dispatchEvent(new CustomEvent("bwe:refresh"));
  }
}

function newScene(): void {
  if (!store.project) return;
  const s = createScene(`场景 ${store.project.scenes.length + 1}`, store.project.gridW, store.project.gridH);
  store.project.scenes.push(s);
  store.setScene(s);
  store.markDirty();
  ok(`已新建「${s.name}」`);
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
}

function sceneItem(s: SceneModel): HTMLElement {
  const item = el("div", { class: "item" + (store.scene === s ? " selected" : "") });
  const dot = el("span", { class: "dot" });
  dot.style.background = store.scene === s ? "var(--accent)" : "var(--line)";
  item.appendChild(dot);
  const grow = el("div", { class: "grow" });
  grow.appendChild(el("div", { class: "name" }, s.name));
  grow.appendChild(
    el("div", { class: "sub" }, `${s.objects.length} 个对象 · ${s.widthTiles}×${s.heightTiles} 格`)
  );
  item.appendChild(grow);
  item.addEventListener("click", () => {
    if (store.scene === s) return;
    store.setScene(s);
    info(`已切换到「${s.name}」`);
    window.dispatchEvent(new CustomEvent("bwe:repaint"));
  });
  item.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: "复制这张地图", onClick: () => duplicateScene(s) },
      {
        label: "删除这张地图",
        disabled: (store.project?.scenes.length ?? 0) <= 1,
        onClick: () => void deleteScene(s)
      }
    ]);
  });
  return item;
}

function duplicateScene(s: SceneModel): void {
  if (!store.project) return;
  const copy: SceneModel = JSON.parse(JSON.stringify(s));
  copy.id = crypto.randomUUID();
  copy.name = s.name + " 副本";
  copy.layers = copy.layers.map((l) => ({ ...l, id: crypto.randomUUID() }));
  const idMap = new Map<string, string>();
  s.layers.forEach((l, i) => idMap.set(l.id, copy.layers[i].id));
  copy.objects = copy.objects.map((o) => ({
    ...o,
    id: crypto.randomUUID(),
    layerId: idMap.get(o.layerId) ?? copy.layers[0].id
  }));
  store.project.scenes.push(copy);
  store.setScene(copy);
  store.markDirty();
  ok(`已复制出「${copy.name}」`);
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
}

async function deleteScene(s: SceneModel): Promise<void> {
  if (!store.project) return;
  if (store.project.scenes.length <= 1) {
    warn("至少留一张地图");
    return;
  }
  const yes = await confirmDialog(
    `删除「${s.name}」？`,
    `这张地图上的 ${s.objects.length} 个对象会一起删掉，且不能撤销。`,
    "删除地图",
    true
  );
  if (!yes) return;
  store.project.scenes = store.project.scenes.filter((x) => x !== s);
  store.setScene(store.project.scenes[0]);
  store.markDirty();
  ok("地图已删除");
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
}

function iconSvg(path: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", "15");
  s.setAttribute("height", "15");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.8");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", path);
  s.appendChild(p);
  return s;
}

void numText;
