/**
 * 场景与图层面板。
 *
 * 俯视角 RPG 的典型结构：一张地图一个场景，场景之间用传送口连。
 * 因此刻意做成「场景列表 + 图层开关」两段，不引入嵌套文件夹那类复杂结构。
 */

import type { SceneModel } from "../core/model.ts";
import { createLayer, createScene, createUiScene, isUiScene, scenePixelSize, UI_DESIGN_H, UI_DESIGN_W } from "../core/model.ts";
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

  const worldScenes = store.project.scenes.filter((s) => !isUiScene(s));
  const uiScenes = store.project.scenes.filter((s) => isUiScene(s));

  // ---- 世界场景 ----
  const head = el("div", { class: "row" });
  head.appendChild(el("div", { class: "group-label" }, "世界场景 World Scenes"));
  head.appendChild(el("div", { class: "spacer" }));
  head.appendChild(button("新建", () => newScene(), { size: "sm", variant: "primary", iconPath: I.plus }));
  wrap.appendChild(head);

  const list = el("div", { class: "item-list" });
  for (const s of worldScenes) {
    list.appendChild(sceneItem(s));
  }
  if (!worldScenes.length) {
    list.appendChild(el("div", { class: "hint" }, "还没有世界场景。世界场景是角色/地块/触发区所在的地图。"));
  }
  wrap.appendChild(list);

  // ---- UI 场景 ----
  // UI 场景与世界场景分开列，是为了让用户一眼看到「界面在这里编辑」，
  // 而不是在一长串地图里找那张「其实是 HUD 的」。
  const uiHead = el("div", { class: "row" });
  uiHead.style.marginTop = "14px";
  uiHead.appendChild(el("div", { class: "group-label" }, "UI 场景 UI Scenes"));
  uiHead.appendChild(el("div", { class: "spacer" }));
  uiHead.appendChild(
    button("新建 UI", () => newUiScene(), {
      size: "sm",
      variant: "primary",
      iconPath: I.plus,
      title: "新建一张按设计分辨率（默认 1280×720）排版的界面画布"
    })
  );
  wrap.appendChild(uiHead);

  const uiList = el("div", { class: "item-list" });
  for (const s of uiScenes) uiList.appendChild(sceneItem(s));
  if (!uiScenes.length) {
    uiList.appendChild(
      el(
        "div",
        { class: "hint" },
        "还没有 UI 场景。点「新建 UI」建一张界面画布：这里的文字/图片/面板按设计分辨率排版，" +
          "不会和地图上的角色、地块混在同一个图层里。"
      )
    );
  }
  wrap.appendChild(uiList);

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

    if (isUiScene(scene)) {
      // ---- UI 场景：设计分辨率 ----
      // 世界场景的「格数」对 UI 没有意义（UI 按像素排版），所以这里换成设计分辨率。
      wrap.appendChild(
        el(
          "div",
          { class: "hint", style: { marginBottom: "6px" } },
          "UI 场景按设计分辨率排版：运行时会等比 contain 居中铺进真实窗口，所以窗口多大都不会裁掉内容。"
        )
      );
      const dwI = input(String(scene.designW ?? UI_DESIGN_W), {
        numeric: true,
        hint: "设计稿宽（像素）。常见值：1280（16:9 横屏）/ 750（竖屏手机）",
        onChange: (v) => {
          const n = Math.max(160, Math.min(4096, Number(v) || (scene.designW ?? UI_DESIGN_W)));
          scene.designW = n;
          scene.widthTiles = Math.max(1, Math.round(n / (store.project!.tileSize || 32)));
          store.markDirty();
          window.dispatchEvent(new CustomEvent("bwe:repaint"));
          window.dispatchEvent(new CustomEvent("bwe:refresh"));
        }
      });
      wrap.appendChild(fieldRow("设计宽 Design W（px）", dwI));

      const dhI = input(String(scene.designH ?? UI_DESIGN_H), {
        numeric: true,
        hint: "设计稿高（像素）。常见值：720（16:9 横屏）/ 1334（竖屏手机）",
        onChange: (v) => {
          const n = Math.max(160, Math.min(4096, Number(v) || (scene.designH ?? UI_DESIGN_H)));
          scene.designH = n;
          scene.heightTiles = Math.max(1, Math.round(n / (store.project!.tileSize || 32)));
          store.markDirty();
          window.dispatchEvent(new CustomEvent("bwe:repaint"));
          window.dispatchEvent(new CustomEvent("bwe:refresh"));
        }
      });
      wrap.appendChild(fieldRow("设计高 Design H（px）", dhI));

      // 常用预设：手输两个数字很容易写错比例，点一下最省事
      const presetRow = el("div", { class: "row tight" });
      const preset = (label: string, w: number, h: number) =>
        button(label, () => {
          scene.designW = w;
          scene.designH = h;
          const ts = store.project?.tileSize || 32;
          scene.widthTiles = Math.max(1, Math.round(w / ts));
          scene.heightTiles = Math.max(1, Math.round(h / ts));
          store.markDirty();
          ok(`设计分辨率改为 ${w} × ${h}`);
          window.dispatchEvent(new CustomEvent("bwe:repaint"));
          window.dispatchEvent(new CustomEvent("bwe:refresh"));
        }, { size: "sm" });
      presetRow.appendChild(preset("1280×720", 1280, 720));
      presetRow.appendChild(preset("1920×1080", 1920, 1080));
      presetRow.appendChild(preset("750×1334", 750, 1334));
      presetRow.appendChild(preset("1080×1920", 1080, 1920));
      wrap.appendChild(presetRow);

      wrap.appendChild(
        el(
          "div",
          { class: "hint" },
          `当前设计稿 ${scene.designW ?? UI_DESIGN_W} × ${scene.designH ?? UI_DESIGN_H} px，` +
            "超出这个框的对象运行时会被画到画面外。"
        )
      );
    } else {
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
    }

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
  const worldCount = store.project.scenes.filter((s) => !isUiScene(s)).length;
  const s = createScene(`场景 ${worldCount + 1}`, store.project.gridW, store.project.gridH);
  store.project.scenes.push(s);
  store.setScene(s);
  store.markDirty();
  ok(`已新建「${s.name}」`);
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
}

function newUiScene(): void {
  if (!store.project) return;
  const uiCount = store.project.scenes.filter((s) => isUiScene(s)).length;
  const s = createUiScene(
    uiCount === 0 ? "界面 1" : `界面 ${uiCount + 1}`,
    UI_DESIGN_W,
    UI_DESIGN_H,
    store.project.tileSize || 32
  );
  store.project.scenes.push(s);
  store.setScene(s);
  store.markDirty();
  ok(`已新建 UI 场景「${s.name}」：右键画布可以放文字 / 图片 / 面板`);
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
}

function sceneItem(s: SceneModel): HTMLElement {
  const item = el("div", { class: "item" + (store.scene === s ? " selected" : "") });
  const dot = el("span", { class: "dot" });
  dot.style.background = store.scene === s ? "var(--accent)" : "var(--line)";
  item.appendChild(dot);
  const grow = el("div", { class: "grow" });
  const title = el("div", { class: "name" }, s.name);
  if (isUiScene(s)) {
    // UI 场景给一个显眼的小标记，免得在一列地图里认错
    const badge = el("span", { class: "hint" }, "UI");
    badge.style.cssText = "margin-left:6px;padding:0 5px;border-radius:3px;background:rgba(162,116,255,.22);color:#b79bff";
    title.appendChild(badge);
  }
  grow.appendChild(title);
  const size = scenePixelSize(s, store.project?.tileSize ?? 32);
  grow.appendChild(
    el(
      "div",
      { class: "sub" },
      isUiScene(s)
        ? `${s.objects.length} 个界面元素 · ${size.w}×${size.h} 设计分辨率`
        : `${s.objects.length} 个对象 · ${s.widthTiles}×${s.heightTiles} 格`
    )
  );
  item.appendChild(grow);
  item.addEventListener("click", () => {
    if (store.scene === s) return;
    store.setScene(s);
    info(isUiScene(s) ? `已切换到 UI 场景「${s.name}」` : `已切换到「${s.name}」`);
    window.dispatchEvent(new CustomEvent("bwe:repaint"));
  });
  item.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: isUiScene(s) ? "复制这张设计稿" : "复制这张地图", onClick: () => duplicateScene(s) },
      {
        label: isUiScene(s) ? "删除这张设计稿" : "删除这张地图",
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
