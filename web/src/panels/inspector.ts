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
import { isUiScene, scriptLang, scriptNamesOfLang, findPrefabOf, resetObjectToPrefab, scenePixelSize } from "../core/model.ts";
import { moduleDef, categoryOf, moduleSummary, makeInstance } from "../data/modules.ts";
import { store } from "../core/store.ts";
import { el, input, button, select, switchToggle, fieldRow, numText, textarea } from "../core/dom.ts";
import { I, iconForKind } from "../ui/icons.ts";
import { KINDS } from "../ui/terms.ts";
import { ok, info, warn, confirmDialog, contextMenu } from "../ui/toast.ts";
import { openModuleEditor } from "./moduleEditor.ts";
import { requestOpenScriptPanel } from "./scriptPanel.ts";

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
  // 只有「来自预制体」的对象才加这张卡片，普通对象不占位置
  const linkCard = prefabLinkCard(obj);
  if (linkCard) wrap.appendChild(linkCard);
  wrap.appendChild(placeCard(obj));
  // ★ 光源对象：专属卡片放在「位置」之后、「自定义属性」之前。
  //   为什么这个位置：用户点中一盏灯，紧接着要改的就是半径/颜色/强度（不是坐标），
  //   压到 Props 表下面等于让他先滚一屏。而 Props 表是"底层键值"，仍在最后。
  if (obj.kind === "LIGHT") {
    wrap.appendChild(lightCard(obj));
  }
  // ★ UI 场景：先给「文字 / 底色」这类界面专用控件，再给 Props 表。
  //   顺序有意义 —— 用户摆一个文字，第一件想改的就是字与颜色，
  //   把它压在 Props 表下面等于让人先滚一屏才看到。
  if (isUiScene(store.scene)) {
    wrap.appendChild(uiElementCard(obj));
  }
  wrap.appendChild(customPropsCard(obj));
  // UI 元素不该挂世界行为模块（走路 / 巡逻 / 碰撞 / 相机跟随），
  // 这些模块挂在界面元素上要么无效、要么把界面当成角色推着跑。
  // UI 场景里干脆不显示模块卡片，只保留脚本卡片（脚本可以操作界面）。
  if (!isUiScene(store.scene)) {
    wrap.appendChild(modulesCard(obj));
  }
  wrap.appendChild(scriptCard(obj));
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
  // 没选中对象时正好放「场景级」设置：这里比工程设置页更顺手（改场景脚本时通常正在看画布）
  box.appendChild(sceneScriptCard());
  return box;
}

/**
 * 场景脚本入口。
 * 契约见 docs/scripting-api.md §1.2：场景载入完、对象 spawn 完之后调用 onSceneStart。
 * 放在 Inspector 的空状态里（而不是工程设置页），因为这是「这张地图」的属性，
 * 和场景列表、画布在同一个视线里；选中对象时也不会被它占位置。
 */
function sceneScriptCard(): HTMLElement {
  const box = el("div", { class: "col" });
  const scene = store.scene;
  if (!scene) {
    box.appendChild(el("div", { class: "hint" }, "没有打开场景"));
    return cardBox("场景脚本 Scene Script", box, I.script);
  }

  const all = Object.keys(store.project?.scripts ?? {});
  const options = [
    { value: "", label: "（不运行场景脚本）" },
    ...all.map((n) => ({
      value: n,
      label: `${n}（${scriptLang(store.project?.scripts[n]) === "js" ? "JS" : "Yarn"}）`
    }))
  ];
  const sel = select(options, scene.onStartScript ?? "", {
    hint: "场景载入完成后执行脚本里的 onSceneStart(ctx)",
    onChange: (v) => {
      scene.onStartScript = v;
      store.markDirty();
      window.dispatchEvent(new CustomEvent("bwe:refresh"));
    }
  });
  box.appendChild(fieldRow("场景脚本 On Start", sel, "JS 脚本里写 function onSceneStart(ctx) 就会被调用；适合刷怪、计分、天气这类系统级逻辑"));

  if (!scene.onStartScript) {
    box.appendChild(
      el(
        "div",
        { class: "hint" },
        all.length
          ? "当前场景没有系统级逻辑。想刷怪 / 计分 / 做全局状态，选一个 JS 脚本挂在这里。"
          : "还没有脚本。先去「剧本」页切到 JS 语言新建一个，再回来选。"
      )
    );
  }

  const row = el("div", { class: "row tight" });
  row.appendChild(
    button("打开剧本面板", () => requestOpenScriptPanel("js", scene.onStartScript || undefined), {
      size: "sm",
      variant: "ghost",
      title: "在左栏「剧本」页写 / 改 JS 脚本"
    })
  );
  box.appendChild(row);
  return cardBox("场景脚本 Scene Script", box, I.script);
}

// ---------------- 预制体链接 ----------------

/**
 * 「来自预制体」卡片。
 *
 * 只在这一对象确实来自某个预制体时才出现，不占普通对象的位置。
 * 卡片职责非常明确：显示链接 + 两个手动操作。
 *
 * **v1 不做自动同步**：改模板不会回头改这里，改这里也不会污染模板。
 * 这一句必须写在卡片上 —— 否则用户会按 Unity 的习惯预期「改模板就全同步」，
 * 然后发现没生效却不知道该点哪个按钮。
 */
function prefabLinkCard(obj: SceneObject): HTMLElement | null {
  const prefab = findPrefabOf(store.project, obj);
  const linkedId = obj.prefabId;

  // 没链接：不显示卡片（普通对象不需要被提醒「你没有预制体」）
  if (!linkedId) return null;

  // 链接指向的模板被删了：显示成明确的失效状态，而不是静默当没链接
  if (!prefab) {
    const box = el("div", { class: "col" });
    box.appendChild(
      el("div", { class: "hint" },
        `这个对象原先来自预制体 ${linkedId.slice(0, 8)}…，但那个模板已经被删掉了。对象本身完好，可以继续用。`)
    );
    box.appendChild(
      button("断开这个失效链接", () => {
        obj.prefabId = null;
        store.markDirty();
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      }, { size: "sm", variant: "outline" })
    );
    return cardBox("预制体链接 Prefab（已失效）", box, I.puzzle);
  }

  const box = el("div", { class: "col" });
  box.appendChild(
    el("div", { class: "hint" },
      `这个对象是从预制体「${prefab.name}」放出来的。改模板不会自动改它 —— `
      + "想回到模板的样子，点下面的「还原为默认值」。")
  );

  const row = el("div", { class: "row tight" });
  row.appendChild(
    button("还原为预制体默认值", () => {
      void confirmDialog(
        `把「${obj.name || "这个对象"}」恢复成预制体「${prefab.name}」的样子？`,
        "素材、模块、标签、属性、缩放、碰撞体都会按模板重置。"
          + "对象自己的名字、位置和图层会保留。这一步不能撤销。",
        "还原",
        true
      ).then((yes) => {
        if (!yes) return;
        resetObjectToPrefab(obj, prefab);
        store.markDirty();
        ok(`已还原成预制体「${prefab.name}」的默认值`);
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
        window.dispatchEvent(new CustomEvent("bwe:repaint"));
      });
    }, {
      size: "sm",
      iconPath: I.undo,
      title: "把外观与模块恢复成模板的样子（保留位置、名字、图层）"
    })
  );
  row.appendChild(
    button("断开链接", () => {
      obj.prefabId = null;
      store.markDirty();
      info("已断开：现在它是普通对象了，改模板不会再和它有半点关系");
      window.dispatchEvent(new CustomEvent("bwe:refresh"));
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
    }, { size: "sm", variant: "ghost", title: "不再跟随这个预制体（对象本身不做任何改动）" })
  );
  box.appendChild(row);

  return cardBox("预制体链接 Prefab", box, I.puzzle);
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

/**
 * 「自定义属性 Props」卡片：把 object.props 里的 key/value 全部列出来，可改可增删。
 *
 * 为什么必须有这张卡：脚本大量依赖 props（例如扫雷的 label 文案、棋盘的
 * 行/列/雷数、出生点参数），而这些在编辑器里原本完全不可见 —— 只能改脚本。
 * 有了这张卡，美术/策划能直接改文案与数值。
 */
/**
 * UI 元素专用卡片（只在 UI 场景里出现）。
 *
 * 为什么不复用「自定义属性 Props」那张表：Props 是「脚本读取的键值」，
 * 用户在那里手打 `textColor` 时既没有颜色选择器、也不知道有哪些合法键。
 * 但文字 / 面板的这些键是**运行时硬契约**（TopDownRuntime.drawLabel 直接读
 * props.text / textSize / textColor / textAlign），所以必须给出有约束的控件：
 * 键名固定（错不了），值域受限（颜色是色板、对齐是下拉、字号是数字）。
 *
 * 仍然写回 obj.props —— 单一份数据源，导出链路一行都不用改。
 */
function uiElementCard(obj: SceneObject): HTMLElement {
  const box = el("div", { class: "col" });
  box.style.marginTop = "10px";
  const scene = store.scene;
  const label = Array.isArray(obj.tags) && obj.tags.indexOf("label") >= 0;
  box.appendChild(
    el("div", { class: "hint" }, label ? "文字 Text（运行时按 props 渲染）" : "UI 元素 Element")
  );

  const setProp = (key: string, value: string) => {
    obj.props = obj.props ?? {};
    obj.props[key] = value;
    store.markDirty();
    window.dispatchEvent(new CustomEvent("bwe:repaint"));
  };
  const getProp = (key: string, def: string) => {
    const v = obj.props?.[key];
    return v == null || String(v).trim() === "" ? def : String(v);
  };

  if (label) {
    // 文字内容：多行框，因为 HUD 文案经常换行
    const ta = textarea(getProp("text", ""), {
      hint: "显示的文字。支持换行；运行时按这个内容生成字形纹理",
      rows: 3,
      onChange: (v) => setProp("text", v)
    });
    box.appendChild(fieldRow("文字 Text", ta));

    box.appendChild(
      fieldRow(
        "字号 Size",
        input(getProp("textSize", "24"), {
          numeric: true,
          hint: "像素字号（按设计分辨率计算，1280×720 下 24 是可读的正文大小）",
          onChange: (v) => setProp("textSize", String(Math.max(6, Math.min(200, Number(v) || 24))))
        })
      )
    );

    box.appendChild(
      fieldRow(
        "颜色 Color",
        input(getProp("textColor", "#e6edf7"), {
          hint: "十六进制颜色，例如 #e6edf7 / #ffd166",
          onChange: (v) => setProp("textColor", v.trim() || "#e6edf7")
        })
      )
    );

    // 一排常用色，省得手打色值
    const swatchRow = el("div", { class: "row tight" });
    for (const c of ["#ffffff", "#e6edf7", "#ffd166", "#ff6b6b", "#4cd4a0", "#7aa2ff", "#b79bff", "#101010"]) {
      const sw = el("span");
      sw.style.cssText = `width:18px;height:18px;border-radius:4px;border:1px solid rgba(255,255,255,.2);cursor:pointer;background:${c}`;
      sw.title = c;
      sw.addEventListener("click", () => {
        setProp("textColor", c);
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      });
      swatchRow.appendChild(sw);
    }
    box.appendChild(swatchRow);

    box.appendChild(
      fieldRow(
        "对齐 Align",
        select(
          [
            { value: "left", label: "左对齐 left" },
            { value: "center", label: "居中 center" },
            { value: "right", label: "右对齐 right" }
          ],
          getProp("textAlign", "left"),
          {
            hint: "文字块以对象位置为锚点：left = 左边贴住，center = 居中，right = 右边贴住",
            onChange: (v) => setProp("textAlign", v)
          }
        )
      )
    );
  } else {
    // 面板 / 图片：给一个底色（props.color），运行时无贴图对象走 drawFallback 读它
    box.appendChild(
      fieldRow(
        "底色 Color",
        input(getProp("color", "#1b2030"), {
          hint: "无贴图时的填充色（#rrggbb）。有素材时以素材为准",
          onChange: (v) => setProp("color", v.trim() || "#1b2030")
        })
      )
    );
    const swatchRow = el("div", { class: "row tight" });
    for (const c of ["#1b2030", "#2f6dd6", "#ffffff", "#101010", "#ff6b6b", "#4cd4a0"]) {
      const sw = el("span");
      sw.style.cssText = `width:18px;height:18px;border-radius:4px;border:1px solid rgba(255,255,255,.2);cursor:pointer;background:${c}`;
      sw.title = c;
      sw.addEventListener("click", () => {
        setProp("color", c);
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      });
      swatchRow.appendChild(sw);
    }
    box.appendChild(swatchRow);
  }

  // 位置提示：UI 场景里「在设计稿中的相对位置」比「第几格」有用得多
  if (scene) {
    const size = scenePixelSize(scene, store.project?.tileSize ?? 32);
    const pct = (v: number, total: number) => ((v / Math.max(1, total)) * 100).toFixed(0);
    box.appendChild(
      el(
        "div",
        { class: "hint" },
        `设计稿位置：左 ${pct(obj.x, size.w)}% · 上 ${pct(obj.y, size.h)}%（${Math.round(obj.x)}, ${Math.round(obj.y)}）`
      )
    );
  }

  return cardBox(label ? "文字 Text" : "UI 元素 Element", box, I.module);
}

/**
 * 光源专属卡片（`kind === "LIGHT"`）。
 *
 * 为什么要有：`lightRadius` / `lightColor` 这些键如果只靠下面的「自定义属性」表来编辑，
 * 用户得先知道键名、自己敲 "#FFC978"、还得记住 `lightShadow` 要写 "0"/"1" ——
 * 那不是编辑器，是配置文件。这里把契约 §3.3 的键做成**有约束的控件**：
 * 半径是数字框、颜色是色板、类型是下拉、三态是下拉、动态/遮挡是开关。
 *
 * 全部写回 `obj.props`（**键名逐字按契约 §3.3**）：这是导出/运行时/烘焙三方共同的读取面，
 * 一旦这里另起一套字段名，脚本 `e.setProp("lightRadius", ...)` 就改不动面板上的东西。
 *
 * 模块优先的提醒：挂了 `render.light` / `look.light` 模块时，**模块参数优先于 props**
 * （契约 §3.3）。面板不隐藏这些控件（用户仍要能改基础值），但顶部给一句明确提示 ——
 * 否则"我在这改了半径却没生效"会成为反复被报的怪事。
 */
function lightCard(obj: SceneObject): HTMLElement {
  const box = el("div", { class: "col" });
  box.style.marginTop = "10px";
  box.style.gap = "6px";

  const setProp = (key: string, value: string) => {
    obj.props = obj.props ?? {};
    obj.props[key] = value;
    store.markDirty();
    window.dispatchEvent(new CustomEvent("bwe:repaint"));
    // 撤销快照：延时合并（拖滑块不该压满撤销栈）；面板自身不重建，避免刚聚焦的输入框被换掉
    window.dispatchEvent(new CustomEvent("bwe:commit", { detail: { label: "改光源参数" } }));
  };
  const getProp = (key: string, def: string) => {
    const v = obj.props?.[key];
    return v == null || String(v).trim() === "" ? def : String(v);
  };
  const numProp = (key: string, def: number) => {
    const n = Number(getProp(key, String(def)));
    return Number.isFinite(n) ? n : def;
  };
  const boolProp = (key: string, def: boolean) => getProp(key, def ? "1" : "0") !== "0";

  // ---- 模块优先级提醒 ----
  const mod = (obj.modules ?? []).find(
    (m) => m.enabled !== false && (m.defId === "render.light" || m.defId === "look.light")
  );
  if (mod) {
    box.appendChild(
      el("div", { class: "hint" },
        `这个对象挂了「点光源」模块（${mod.defId}）：模块里的 半径/颜色/强度 会**优先**于下面这些值。`
        + "想按下面的值生效，先去「模块」页把那个模块关掉或删掉。")
    );
  }

  // ---- 半径 ----
  box.appendChild(
    fieldRow(
      "半径 Radius",
      input(getProp("lightRadius", "140"), {
        numeric: true,
        hint: "照亮半径（世界像素）。0 或空 = 这盏不发光",
        onChange: (v) => {
          const n = Number(v);
          setProp("lightRadius", String(Number.isFinite(n) && n >= 0 ? Math.round(n) : 140));
        }
      })
    )
  );

  // ---- 颜色 + 常用色板 ----
  box.appendChild(
    fieldRow(
      "颜色 Color",
      input(getProp("lightColor", "#FFC978"), {
        hint: "十六进制颜色，例如 #FFC978（暖黄）/ #80CCFF（月光蓝）/ #FF8844（火把橙）",
        onChange: (v) => setProp("lightColor", v.trim() || "#FFC978")
      })
    )
  );
  const swatchRow = el("div", { class: "row tight" });
  for (const c of ["#FFC978", "#FF8844", "#FF4D4D", "#80CCFF", "#B79BFF", "#4CD4A0", "#FFFFFF"]) {
    const sw = el("span");
    sw.style.cssText = `width:18px;height:18px;border-radius:50%;border:1px solid rgba(255,255,255,.2);cursor:pointer;background:${c}`;
    sw.title = c;
    sw.addEventListener("click", () => {
      setProp("lightColor", c);
      window.dispatchEvent(new CustomEvent("bwe:refresh"));
    });
    swatchRow.appendChild(sw);
  }
  box.appendChild(swatchRow);

  // ---- 强度 ----
  box.appendChild(
    fieldRow(
      "强度 Intensity",
      input(getProp("lightIntensity", "1"), {
        numeric: true,
        hint: "0..4。1 = 标准亮度，>1 会过曝成白（适合灯心）",
        onChange: (v) => {
          const n = Number(v);
          const ok = Number.isFinite(n) ? Math.max(0, Math.min(4, n)) : 1;
          setProp("lightIntensity", String(ok));
        }
      })
    )
  );

  // ---- 类型 ----
  const type = getProp("lightType", "point").toLowerCase() === "spot" ? "spot" : "point";
  box.appendChild(
    fieldRow(
      "类型 Type",
      select(
        [
          { value: "point", label: "点光 point（四面都亮）" },
          { value: "spot", label: "聚光 spot（只照一个锥形）" }
        ],
        type,
        {
          hint: "点光适合火把/路灯；聚光适合手电筒、探照灯、车灯",
          onChange: (v) => {
            setProp("lightType", v === "spot" ? "spot" : "point");
            // 控件要显隐（角度/方向只对聚光有意义）
            window.dispatchEvent(new CustomEvent("bwe:refresh"));
          }
        }
      )
    )
  );

  // ---- 聚光专用：角度 / 方向 / 锥边软化 ----
  if (type === "spot") {
    box.appendChild(
      fieldRow(
        "聚光角度 Angle",
        input(getProp("lightAngle", "60"), {
          numeric: true,
          hint: "锥形的总张角（度）。60 = 常见手电筒；10 = 激光；120 = 很宽的泛光",
          onChange: (v) => {
            const n = Number(v);
            setProp("lightAngle", String(Number.isFinite(n) ? Math.max(1, Math.min(360, n)) : 60));
          }
        })
      )
    );
    box.appendChild(
      fieldRow(
        "聚光方向 Dir",
        input(getProp("lightDir", String(Math.round(obj.rotation || 0))), {
          numeric: true,
          hint: "0 = 朝右(+x)，90 = 朝下(+y)，顺时针。留空则跟随对象旋转",
          onChange: (v) => {
            const n = Number(v);
            setProp("lightDir", String(Number.isFinite(n) ? Math.round(((n % 360) + 360) % 360) : 0));
          }
        })
      )
    );
    box.appendChild(
      fieldRow(
        "锥边软化 Cone Soft",
        input(getProp("lightConeSoft", "10"), {
          numeric: true,
          hint: "锥形边缘的过渡角度（度）。0 = 硬边（像舞台灯），10 比较自然",
          onChange: (v) => {
            const n = Number(v);
            setProp("lightConeSoft", String(Number.isFinite(n) ? Math.max(0, Math.min(90, n)) : 10));
          }
        })
      )
    );
  }

  // ---- 衰减指数 ----
  box.appendChild(
    fieldRow(
      "衰减 Falloff",
      input(getProp("lightFalloff", "2"), {
        numeric: true,
        hint: "1..4。1 = 衰减很慢（大范围泛光），2 = 标准，4 = 只在灯心附近亮",
        onChange: (v) => {
          const n = Number(v);
          setProp("lightFalloff", String(Number.isFinite(n) ? Math.max(1, Math.min(4, n)) : 2));
        }
      })
    )
  );

  // ---- 被遮挡 / 闪烁 ----
  box.appendChild(
    fieldRow(
      "会被墙挡住 Shadow",
      switchToggle(boolProp("lightShadow", true), (v) => {
        setProp("lightShadow", v ? "1" : "0");
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      }, "开着 = 墙/遮挡体后面不会被这盏光照到（更真实，也稍慢）；关掉 = 光穿过一切"),
      "lightShadow：是否被遮挡体挡光（契约 §3.3 缺省 \"1\"）"
    )
  );

  box.appendChild(
    fieldRow(
      "闪烁 Flicker",
      input(getProp("lightFlicker", "0"), {
        numeric: true,
        hint: "0..1。0 = 常亮；0.25 = 火把那种轻微抖动。烘焙贴图里不含抖动（由运行时动态叠加）",
        onChange: (v) => {
          const n = Number(v);
          setProp("lightFlicker", String(Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0));
        }
      })
    )
  );

  // ---- 烘焙时排除（动态光）----
  box.appendChild(
    fieldRow(
      "烘焙时排除（动态光）",
      switchToggle(boolProp("lightDynamic", false), (v) => {
        setProp("lightDynamic", v ? "1" : "0");
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      }, "开着 = 这盏光不进烘焙贴图，由运行时每帧动态计算。会移动/跟随角色的光必须开"),
      "lightDynamic：1 = 不进烘焙（移动的光必须为 1，否则烘焙图里的光斑会留在原地）"
    )
  );

  // ---- 遮挡体三态 ----
  // 「不设置」这一态是必须的：不写 lightBlock 时按 tags 判定（wall/occluder/lightblock），
  // 用户把一盏灯也标成 wall 就会变成"灯自己挡自己"，而三态让"我只想让它当灯"有明确表达。
  const blockRaw = obj.props?.lightBlock;
  const blockValue = blockRaw === undefined || String(blockRaw).trim() === "" ? "" : String(blockRaw).trim() === "0" ? "0" : String(blockRaw).trim() === "1" ? "1" : "";
  const tags = Array.isArray(obj.tags) ? obj.tags : [];
  const tagBlocks = tags.indexOf("wall") >= 0 || tags.indexOf("occluder") >= 0 || tags.indexOf("lightblock") >= 0;
  box.appendChild(
    fieldRow(
      "挡住光线（遮挡体）",
      select(
        [
          { value: "", label: "不设置（按标签判定）" },
          { value: "1", label: "是 · 挡住光线" },
          { value: "0", label: "否 · 光穿过它" }
        ],
        blockValue,
        {
          hint: "lightBlock：\"1\" 一定挡光、\"0\" 一定不挡；不设置时看 tags 里有没有 wall / occluder / lightblock",
          onChange: (v) => {
            obj.props = obj.props ?? {};
            if (v === "1" || v === "0") obj.props.lightBlock = v;
            else delete obj.props.lightBlock; // 「不设置」= 删掉这个键，回到标签判定
            store.markDirty();
            window.dispatchEvent(new CustomEvent("bwe:repaint"));
            window.dispatchEvent(new CustomEvent("bwe:refresh"));
            window.dispatchEvent(new CustomEvent("bwe:commit", { detail: { label: "改遮挡体标记" } }));
          }
        }
      )
    )
  );
  box.appendChild(
    el("div", { class: "hint" },
      blockValue === "" && tagBlocks
        ? "当前按标签判定：这个对象的 tags 里有 wall / occluder / lightblock → 它会挡光。"
        : blockValue === "" ? "当前按标签判定：tags 里没有遮挡标记 → 它不挡光。" : "")
  );

  // ---- 一键定位 ----
  box.appendChild(
    button("在画布中定位这盏光", () => {
      store.select(obj);
      window.dispatchEvent(new CustomEvent("bwe:focus-object", { detail: { id: obj.id, x: obj.x, y: obj.y } }));
    }, { size: "sm", variant: "ghost", title: "选中它，并把画布视图移到它身上" })
  );

  return cardBox("光源 Light 2D", box, I.light);
}

function customPropsCard(obj: SceneObject): HTMLElement {
  const box = el("div", { class: "col" });
  box.style.marginTop = "10px";
  box.appendChild(el("div", { class: "hint" }, "自定义属性 Props（脚本读取的键值）"));

  const table = el("div", { class: "col" });
  table.style.gap = "4px";

  const refresh = () => {
    table.replaceChildren();
    const keys = Object.keys(obj.props ?? {});
    if (!keys.length) {
      table.appendChild(el("div", { class: "hint" }, "（暂无）"));
    }
    for (const key of keys) {
      const row = el("div", { class: "row" });
      row.style.gap = "4px";
      row.style.alignItems = "center";

      // key（可改名）
      const keyInput = input(key, {
        hint: "属性名",
        onChange: (v) => {
          const nk = String(v).trim();
          if (!nk || nk === key) return;
          if (nk in (obj.props ?? {})) { warn("属性名已存在: " + nk); return; }
          const val = obj.props[key];
          delete obj.props[key];
          obj.props[nk] = val;
          store.markDirty();
          refresh();
        },
      });
      keyInput.style.width = "96px";

      // value
      const valInput = input(String(obj.props[key] ?? ""), {
        hint: "属性值",
        onChange: (v) => {
          obj.props[key] = String(v);
          store.markDirty();
          window.dispatchEvent(new CustomEvent("bwe:repaint"));
        },
      });
      valInput.style.flex = "1";

      // 删除
      const del = button("×", () => {
        delete obj.props[key];
        store.markDirty();
        window.dispatchEvent(new CustomEvent("bwe:repaint"));
        refresh();
      });
      del.style.width = "24px";

      row.appendChild(keyInput);
      row.appendChild(valInput);
      row.appendChild(del);
      table.appendChild(row);
    }
  };
  refresh();
  box.appendChild(table);

  // 新增一行
  box.appendChild(button("+ 添加属性", () => {
    let i = 1;
    while (("新属性" + i) in (obj.props ?? {})) i++;
    obj.props["新属性" + i] = "";
    store.markDirty();
    refresh();
  }));
  return box;
}

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
      window.dispatchEvent(new CustomEvent("bwe:hint", { detail: v ? "已锁定，画布上点不到它了（Alt+点击可选中）" : "已解锁" }));
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
      window.dispatchEvent(new CustomEvent("bwe:refresh"));
    })
  );
  box.appendChild(toggles);

  // 锁定状态给一句明确的"怎么回来"，否则用户会以为对象卡死了
  if (obj.locked) {
    const tip = el("div", { class: "hint" });
    tip.style.marginTop = "6px";
    tip.textContent = "这个对象是锁定的：画布上普通点击点不到它。按住 Alt 在画布上点它就能重新选中；也可以在画布空白处右键「解锁全部对象」。";
    box.appendChild(tip);
  }

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

// ---------------- 脚本 ----------------

/**
 * 对象脚本卡片。
 *
 * 「对象脚本 script.js」模块就是脚本挂到对象上的入口；这里给它一个比模块编辑器
 * 短得多的路径：选脚本 → 去剧本页写。没挂脚本时也不留白，直接给一个能点的动作。
 */
function scriptCard(obj: SceneObject): HTMLElement {
  const box = el("div", { class: "col" });
  const attached = obj.modules.filter((m) => m.defId === "script.js");
  const jsNames = scriptNamesOfLang(store.project, "js");

  if (!attached.length) {
    box.appendChild(
      el(
        "div",
        { class: "hint" },
        jsNames.length
          ? "这个对象还没挂脚本。挂上之后，移动、攻击、UI 都能在 onStart / onUpdate 里自己写 —— 和模块共存，不互相覆盖。"
          : "这个对象还没挂脚本。先去「剧本」页切到 JS 语言新建一个，回来就能挂了。"
      )
    );
    const add = button(
      jsNames.length ? "挂一个 JS 脚本…" : "去新建 JS 脚本",
      () => {
        if (!jsNames.length) {
          requestOpenScriptPanel("js");
          return;
        }
        scriptMenu(add, jsNames, (name) => attachScript(obj, name));
      },
      { size: "sm", variant: jsNames.length ? "primary" : "outline", iconPath: I.plus }
    );
    box.appendChild(add);
    return cardBox("脚本 Script", box, I.script);
  }

  for (const inst of attached) {
    const cur = inst.values["script"] ?? "";
    const lang = cur ? scriptLang(store.project?.scripts[cur]) : "js";
    const row = el("div", { class: "script-slot" });
    row.appendChild(el("span", { class: `js-lang-badge ${lang}` }, lang === "js" ? "JS" : "Yarn"));
    const infoBox = el("div", { class: "grow" });
    infoBox.appendChild(el("div", { class: "name" }, cur || "（还没选脚本）"));
    infoBox.appendChild(
      el(
        "div",
        { class: "sub" },
        cur
          ? lang === "js"
            ? "JS 脚本 · 事件函数由运行时调用"
            : "Yarn 剧本 · 不能当对象脚本运行，请换成 JS 脚本"
          : "点「选择」挑一个 JS 脚本"
      )
    );
    row.appendChild(infoBox);
    const btns = el("div", { class: "row tight" });
    btns.appendChild(
      button("选择", () => scriptMenu(btns, jsNames, (name) => {
        inst.values["script"] = name;
        store.markDirty();
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      }), { size: "sm", variant: "outline" })
    );
    if (cur && store.project?.scripts[cur]) {
      btns.appendChild(
        button("编辑", () => requestOpenScriptPanel(undefined, cur), {
          size: "sm",
          variant: "ghost",
          title: "在左栏「剧本」页打开这段脚本"
        })
      );
    }
    row.appendChild(btns);
    box.appendChild(row);
  }

  box.appendChild(
    el(
      "div",
      { class: "hint" },
      "脚本负责「额外逻辑」，模块负责「默认行为」，两者共存。脚本里 ctx.self 就是左边这个对象；可用能力见「剧本」页的 API 速查。"
    )
  );
  return cardBox("脚本 Script", box, I.script);
}

/** 选择脚本的弹出菜单（只列 JS；Yarn 需要从「对话」模块进入）。 */
function scriptMenu(anchor: HTMLElement, names: string[], onPick: (name: string) => void): void {
  const r = anchor.getBoundingClientRect();
  contextMenu(r.left, r.bottom + 2, [
    ...names.slice(0, 30).map((n) => ({
      label: n,
      hint: store.project?.scripts[n]?.file ?? "",
      onClick: () => onPick(n)
    })),
    { divider: true },
    { label: "在「剧本」页新建 / 编辑…", onClick: () => requestOpenScriptPanel("js") }
  ]);
}

/** 把 script.js 模块挂到对象上，并把脚本名写进参数。 */
function attachScript(obj: SceneObject, name: string): void {
  const def = moduleDef("script.js");
  if (!def) {
    warn("找不到「对象脚本」模块定义");
    return;
  }
  const inst = makeInstance(def);
  inst.values["script"] = name;
  inst.trigger = "ALWAYS";
  obj.modules.push(inst);
  store.markDirty();
  ok(`已给「${obj.name || "对象"}」挂上脚本「${name}」`);
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
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
