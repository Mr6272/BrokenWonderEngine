/**
 * 左栏「预制体 Prefab」面板。
 *
 * 预制体 = 可以反复往场景里摆的「对象模板」。和 Unity 的 Prefab 概念一致：
 * 做一个敌人 / 一个宝箱 / 一个触发区，之后拖几次就有几个实例。
 *
 * 布局沿用现有面板的纪律（和「场景 Scenes」「剧本 Script」一致）：
 *   上：列表（搜索 + 新建 / 从场景对象抓 / 复制 / 删除 / 重命名）
 *   下：选中模板的属性表单（素材、类型、碰撞体、标签、脚本、随机散布）
 *
 * **v1 明确不做自动同步**：
 * 改了模板不会回头改已经摆下去的对象，改了对象也不会污染模板。
 * 这是刻意的取舍 —— Unity 的 Prefab override 语义（哪些字段被覆盖过、增删模块怎么合并）
 * 远比现在这套编辑器需要的复杂，做一半只会让人误以为「改了模板就会同步」而踩坑。
 * 需要「回到模板样子」时，用 Inspector 里的「还原为预制体默认值」手动做一次。
 *
 * 两个入口都做成「一眼知道下一步点什么」：
 *   1. 「从场景对象创建」：先在画布上选一个对象，再点这里，坐标自动归零。
 *   2. 「放置到场景」：选中模板直接点，或者把模板条目拖进画布。
 */

import type { PrefabDef } from "../core/model.ts";
import {
  createPrefab,
  prefabFromObject,
  objectFromPrefab,
  uniquePrefabName,
  cloneModules,
  scriptLang,
  scriptNamesOfLang
} from "../core/model.ts";
import { store } from "../core/store.ts";
import {
  el,
  input,
  button,
  fieldRow,
  numText,
  emptyState,
  makeDraggable
} from "../core/dom.ts";
import { I, iconForKind } from "../ui/icons.ts";
import { KINDS } from "../ui/terms.ts";
import { ok, info, warn, confirmDialog, contextMenu, modal } from "../ui/toast.ts";
import { moduleDef, moduleSummary } from "../data/modules.ts";
import { DND_PREFAB } from "../app/canvas.ts";

// 面板级 UI 状态：切换左栏 tab 回来时要还在（素材面板也是这么做的）
let searchText = "";
let selectedPrefabId = "";

export function renderPrefabPanel(host: HTMLElement): void {
  host.replaceChildren();
  const wrap = el("div", { class: "col" });
  wrap.style.padding = "10px";

  if (!store.project) {
    wrap.appendChild(el("div", { class: "hint" }, "还没有打开工程"));
    host.appendChild(wrap);
    return;
  }

  const prefabs = store.project.prefabs;

  // ---- 顶部动作 ----
  const actions = el("div", { class: "row tight wrap" });
  actions.appendChild(
    button("新建", () => newPrefab(), {
      size: "sm",
      variant: "primary",
      iconPath: I.plus,
      title: "从空白模板开始"
    })
  );
  actions.appendChild(
    button("从场景对象创建", () => captureFromSelection(), {
      size: "sm",
      iconPath: I.puzzle,
      title: "先在画布上选中一个对象，再点这里把它抓成可复用模板（坐标归零）"
    })
  );
  wrap.appendChild(actions);

  // 没有预制体时不留白屏：直接把「怎么开始」写成一句话 + 一个能点的动作
  if (!prefabs.length) {
    const startBtn = button("从当前场景对象抓一个", () => captureFromSelection(), {
      size: "sm",
      variant: "primary",
      iconPath: I.puzzle
    });
    wrap.appendChild(
      emptyState(
        I.puzzle,
        "还没有预制体",
        "预制体是可以反复摆放的对象模板：做好一个敌人，拖几次就有几个。"
          + "先在画布上挑一个调好的对象，点下面的按钮把它抓成模板。",
        startBtn
      )
    );
    host.appendChild(wrap);
    return;
  }

  // ---- 搜索 ----
  const s = input(searchText, {
    placeholder: "搜索预制体名 / 说明",
    onChange: (v) => {
      searchText = v;
      rebuild();
    }
  });
  s.style.marginTop = "8px";
  s.style.height = "26px";
  wrap.appendChild(s);

  // ---- 列表 ----
  const list = el("div", { class: "item-list" });
  list.style.marginTop = "8px";
  wrap.appendChild(list);

  // ---- 属性表单容器 ----
  const detail = el("div", { class: "col" });
  detail.style.marginTop = "12px";
  wrap.appendChild(detail);

  host.appendChild(wrap);

  // 默认选中：上次选中的，否则第一个（保证右半边永远有内容，不留空白）
  const visibleList = () => {
    const k = searchText.trim().toLowerCase();
    if (!k) return prefabs;
    return prefabs.filter(
      (p) =>
        p.name.toLowerCase().includes(k) ||
        (p.blurb ?? "").toLowerCase().includes(k) ||
        p.tags.some((t) => t.toLowerCase().includes(k))
    );
  };

  function rebuild(): void {
    const shown = visibleList();
    if (selectedPrefabId && !prefabs.some((p) => p.id === selectedPrefabId)) selectedPrefabId = "";
    if (!selectedPrefabId) selectedPrefabId = shown[0]?.id ?? prefabs[0]?.id ?? "";

    list.replaceChildren();
    if (!shown.length) {
      list.appendChild(el("div", { class: "hint" }, `没有匹配「${searchText.trim()}」的预制体`));
    }
    for (const p of shown) list.appendChild(prefabItem(p));

    detail.replaceChildren();
    const cur = prefabs.find((p) => p.id === selectedPrefabId);
    if (cur) detail.appendChild(prefabForm(cur));
    else detail.appendChild(el("div", { class: "hint" }, "左边选一个预制体，这里显示它的属性"));
  }

  // 首次渲染就走一遍：面板一打开列表与表单必须是有内容的，
  // 不能等用户先点一下才「醒过来」。
  rebuild();

  function prefabItem(p: PrefabDef): HTMLElement {
    const item = el("div", { class: "item" + (p.id === selectedPrefabId ? " selected" : "") });

    // 类型图标（和画布/大纲用同一套，一眼对应「这是什么」）
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("width", "15");
    icon.setAttribute("height", "15");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.7");
    const ip = document.createElementNS("http://www.w3.org/2000/svg", "path");
    ip.setAttribute("d", iconForKind(p.kind));
    icon.appendChild(ip);
    icon.style.color = "var(--text-2)";
    item.appendChild(icon);

    const grow = el("div", { class: "grow" });
    grow.appendChild(el("div", { class: "name" }, p.name));
    const bits = [`${KINDS[p.kind]?.cn ?? p.kind}`];
    bits.push(`模块 ${p.modules.length}`);
    if (p.tags.length) bits.push(p.tags.slice(0, 2).join(" / "));
    grow.appendChild(el("div", { class: "sub" }, bits.join(" · ")));
    item.appendChild(grow);

    // 放进场景的数量：让用户知道「这个模板已经被用过几次」
    const used = store.scene?.objects.filter((o) => o.prefabId === p.id).length ?? 0;
    if (used > 0) item.appendChild(el("span", { class: "hint" }, `${used} 个`));

    item.addEventListener("click", () => {
      selectedPrefabId = p.id;
      rebuild();
    });
    item.addEventListener("dblclick", () => placePrefab(p));
    // 拖到画布上放置（画布 onDrop 认的是 canvas.ts 导出的 DND_PREFAB）
    makeDraggable(item, DND_PREFAB, () => p.id);
    item.title = "点一下在这里改属性；双击或拖进画布，放置到场景里";
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: "放置到场景", onClick: () => placePrefab(p) },
        { label: "重命名…", onClick: () => renamePrefab(p) },
        { label: "复制一份", onClick: () => duplicatePrefab(p) },
        { divider: true },
        { label: "删除", onClick: () => void removePrefab(p) }
      ]);
    });
    return item;
  }

  function prefabForm(p: PrefabDef): HTMLElement {
    const box = el("div", { class: "col" });

    // 放置主按钮放最上面：这是这个面板最高频的操作
    const placeRow = el("div", { class: "row tight" });
    placeRow.appendChild(
      button("放置到场景", () => placePrefab(p), {
        size: "sm",
        variant: "primary",
        iconPath: I.play,
        title: "在当前视图正中放一个；也可以把左边这条直接拖进画布，落在鼠标位置"
      })
    );
    placeRow.appendChild(
      button("复制", () => duplicatePrefab(p), { size: "sm", iconPath: I.copy, title: "复制出另一个同款模板" })
    );
    placeRow.appendChild(
      button("删除", () => void removePrefab(p), { size: "sm", variant: "danger", iconPath: I.trash })
    );
    box.appendChild(placeRow);

    // ---- 名字与说明 ----
    box.appendChild(card("模板 Prefab", identityFields(p), I.puzzle));

    // ---- 外观 ----
    box.appendChild(card("外观 Appearance", lookFields(p), iconForKind(p.kind)));

    // ---- 模块 ----
    box.appendChild(modulesSection(p));

    // ---- 随机散布 ----
    box.appendChild(jitterFields(p));

    box.appendChild(
      el(
        "div",
        { class: "hint", style: { marginTop: "8px" } },
        "改了这里不会自动改已经摆进场景的对象（v1 不做自动同步）。"
          + "要让已经放下的对象也更新，用对象 Inspector 里的「还原为预制体默认值」。"
      )
    );
    return box;
  }

  function identityFields(p: PrefabDef): HTMLElement {
    const box = el("div", { class: "col" });

    const nameI = input(p.name, {
      hint: "运行期脚本用这个名字生成物体：bwe.prefab.spawn(\"名字\")。不能和别的预制体重名",
      onChange: (v) => {
        const t = v.trim();
        if (!t) return;
        const clash = store.project?.prefabs.some((x) => x !== p && x.name === t);
        if (clash) {
          warn(`已经有一个叫「${t}」的预制体了，换一个名字`);
          nameI.value = p.name;
          return;
        }
        p.name = t;
        store.markDirty();
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      }
    });
    box.appendChild(fieldRow("名称 Name", nameI));

    const blurbI = input(p.blurb ?? "", {
      placeholder: "一句话说明它是干什么的，可留空",
      hint: "给同事看的备注，不参与导出",
      onChange: (v) => {
        p.blurb = v;
        store.markDirty();
      }
    });
    box.appendChild(fieldRow("说明 Blurb", blurbI));

    const kindSel = (() => {
      const sel = el("select", { class: "select" }) as HTMLSelectElement;
      for (const k of Object.keys(KINDS) as (keyof typeof KINDS)[]) {
        const opt = el("option", { value: k }, `${KINDS[k].cn} ${KINDS[k].en}`);
        if (k === p.kind) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener("change", () => {
        p.kind = sel.value as PrefabDef["kind"];
        store.markDirty();
        info(KINDS[p.kind].hint);
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      });
      return sel;
    })();
    box.appendChild(fieldRow("类型 Type", kindSel, KINDS[p.kind]?.hint));

    const tagI = input(p.tags.join(","), {
      placeholder: "标签，逗号分开",
      hint: "生成出来的对象会带上这些标签；「按标签找敌人」这类逻辑就能一次管到",
      onChange: (v) => {
        p.tags = Array.from(
          new Set(
            v
              .split(/[,，、|]/)
              .map((x) => x.trim())
              .filter(Boolean)
          )
        );
        store.markDirty();
      }
    });
    box.appendChild(fieldRow("标签 Tag", tagI));

    return box;
  }

  function lookFields(p: PrefabDef): HTMLElement {
    const box = el("div", { class: "col" });

    // 素材：和模块编辑器同一个交互（输入 + 选择），因为都是「从素材库里挑一个」
    const assetWrap = el("div", { class: "row tight" });
    const assetBtn = button("选择", () => {
      const options = store.assets.filter((a) => a.kind !== "AUDIO");
      if (!options.length) {
        info("素材库还是空的，先去左栏「素材」导入图片");
        return;
      }
      const r = assetBtn.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 2, [
        ...options.slice(0, 40).map((a) => ({
          label: `${a.name}（${a.kind}）`,
          onClick: () => {
            p.assetId = a.id;
            store.markDirty();
            window.dispatchEvent(new CustomEvent("bwe:refresh"));
            window.dispatchEvent(new CustomEvent("bwe:repaint"));
          }
        })),
        { divider: true },
        {
          label: "（留空 = 不显示图）",
          onClick: () => {
            p.assetId = "";
            store.markDirty();
            window.dispatchEvent(new CustomEvent("bwe:refresh"));
          }
        }
      ]);
    }, { size: "sm", variant: "outline" });
    const curAsset = store.findAsset(p.assetId);
    const assetLabel = el("div", { class: "hint", style: { flex: "1", lineHeight: "26px" } },
      curAsset ? `${curAsset.name}（${curAsset.kind}）` : "还没有绑定素材");
    assetWrap.appendChild(assetLabel);
    assetWrap.appendChild(assetBtn);
    box.appendChild(fieldRow("精灵 Sprite", assetWrap, "生成的对象长什么样"));

    // 数值字段：统一走 input(numeric)，和 Inspector 的手感一致
    const numField = (label: string, value: number, hint: string, set: (v: number) => void, unit?: string) => {
      const i = input(numText(value), {
        numeric: true,
        hint,
        onChange: (v) => {
          const n = Number(v);
          if (!Number.isFinite(n)) return;
          set(n);
          store.markDirty();
        }
      });
      i.style.width = "84px";
      const w = el("div", { class: "with-unit" });
      w.appendChild(i);
      if (unit) w.appendChild(el("span", { class: "unit" }, unit));
      box.appendChild(fieldRow(label, w, hint));
    };

    numField("排序层级 Sort Order", p.z, "数值大的盖住小的", (v) => (p.z = Math.round(v)));
    numField("旋转 Rotation", p.rotation, "角度，顺时针", (v) => (p.rotation = v), "°");
    numField("缩放 X Scale", p.scaleX, "1 表示原始大小", (v) => (p.scaleX = Math.max(0.05, v)), "×");
    numField("缩放 Y Scale", p.scaleY, "", (v) => (p.scaleY = Math.max(0.05, v)), "×");

    const colliderHead = el("div", { class: "group-label" }, "碰撞体 Collider 2D");
    box.appendChild(colliderHead);
    numField("半宽 Half W", p.halfW, "0 表示不参与碰撞，尺寸按素材算", (v) => (p.halfW = Math.max(0, v)), "px");
    numField("半高 Half H", p.halfH, "", (v) => (p.halfH = Math.max(0, v)), "px");

    const quick = el("div", { class: "row tight" });
    quick.appendChild(
      button("按素材尺寸", () => {
        const a = store.findAsset(p.assetId);
        if (!a) {
          warn("这个预制体还没绑定素材");
          return;
        }
        const t = store.project?.tileSize ?? 32;
        p.halfW = Math.round((a.width || t) / 2);
        p.halfH = Math.round((a.height || t) / 2);
        store.markDirty();
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      }, { size: "sm" })
    );
    quick.appendChild(
      button("清空碰撞体", () => {
        p.halfW = 0;
        p.halfH = 0;
        store.markDirty();
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      }, { size: "sm" })
    );
    box.appendChild(quick);

    // 动画（只有序列帧 / 图集才有意义，和 Inspector 的规则一致）
    const sprite = store.findAsset(p.assetId);
    if (sprite && sprite.kind !== "AUDIO" && sprite.kind !== "IMAGE") {
      const animHead = el("div", { class: "group-label" }, "精灵与动画 Sprite / Animation");
      box.appendChild(animHead);
      const modeSel = el("select", { class: "select" }) as HTMLSelectElement;
      for (const mode of ["默认", "只显示首帧", "单次播放"]) {
        const opt = el("option", { value: mode }, mode === "默认" ? "默认（循环播放）" : mode);
        if (mode === p.animMode) opt.selected = true;
        modeSel.appendChild(opt);
      }
      modeSel.addEventListener("change", () => {
        p.animMode = modeSel.value;
        store.markDirty();
      });
      box.appendChild(fieldRow("播放模式 Mode", modeSel));

      const fpsI = input(numText(p.animFps), {
        numeric: true,
        onChange: (v) => {
          p.animFps = Math.max(1, Math.min(60, Number(v) || 8));
          store.markDirty();
        }
      });
      fpsI.style.width = "84px";
      box.appendChild(fieldRow("帧率 Frame Rate", fpsI, "每秒播放几帧"));
    }

    return box;
  }

  function modulesSection(p: PrefabDef): HTMLElement {
    const box = el("div", { class: "col" });

    const head = el("div", { class: "row tight" });
    head.appendChild(el("div", { class: "group-label" }, `模块 Modules（${p.modules.length}）`));
    head.appendChild(el("div", { class: "spacer" }));
    head.appendChild(
      button("放置后再编辑", () => {
        placePrefab(p);
        info("已放进场景：选中它，用工具栏「模块」调参数（模板本身保持不动）");
      }, {
        size: "sm",
        variant: "outline",
        iconPath: I.module,
        title: "模块参数在独立编辑器里调，需要一个真实的场景对象；这里放一个出来再改"
      })
    );
    box.appendChild(head);

    if (!p.modules.length) {
      box.appendChild(
        el("div", { class: "hint" },
          "这个模板还没挂模块，生成出来的对象不会做任何事。"
            + "先「放置到场景」，再选中它按 M 打开模块编辑器，调好之后重新抓成预制体。")
      );
      // 脚本仍要给入口：没有模块的模板也能靠脚本跑起来（script.js 自己就是一块模块，
      // 选中脚本时 syncScriptModule 会把它补进去）。
      box.appendChild(scriptField(p));
      return card("模块 Modules", box, I.module);
    }

    // 模块只做只读概览：改参数的交互（滑块 + 素材选择）在独立编辑器里，
    // 挤进左栏会互相抢位置（这是项目既有纪律，见 inspector.ts 顶部说明）。
    const list = el("div", { class: "mod-overview" });
    for (const m of p.modules) {
      const row = el("div", { class: "mod-overview-row" + (m.enabled ? "" : " off") });
      row.appendChild(el("span", { class: "mod-overview-dot" }));
      const text = el("div", { class: "mod-overview-text" });
      text.appendChild(el("div", { class: "t" }, moduleTitle(m.defId)));
      text.appendChild(el("div", { class: "s" }, m.enabled ? moduleBrief(m) : "已停用 · 放置后仍保留"));
      row.appendChild(text);
      list.appendChild(row);
    }
    box.appendChild(list);

    const tools = el("div", { class: "row tight" });
    tools.appendChild(
      button("复制模块到剪贴板", () => {
        clipboardModules = cloneModules(p.modules);
        ok(`已复制 ${p.modules.length} 块模块，可以粘到别的预制体上`);
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      }, { size: "sm" })
    );
    tools.appendChild(
      button("从剪贴板粘贴", () => {
        if (!clipboardModules) return;
        p.modules = cloneModules(clipboardModules);
        store.markDirty();
        ok(`已粘贴 ${p.modules.length} 块模块`);
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      }, { size: "sm", disabled: !clipboardModules })
    );
    box.appendChild(tools);

    const scriptRow = el("div", { class: "col" });
    scriptRow.appendChild(scriptField(p));
    box.appendChild(scriptRow);

    return card("模块 Modules", box, I.module);
  }

  /**
   * 对象脚本。
   *
   * 和 Inspector 的「脚本」卡片同一套语义：script.js 模块的 params.script 存**剧本 key**，
   * 导出时由 package-bwe.mjs 换算成运行期脚本名。预制体上单独存一份 script，
   * 是因为模板没有「真正的对象」可挂模块，放置时再写回 script.js 模块。
   */
  function scriptField(p: PrefabDef): HTMLElement {
    const box = el("div", { class: "col" });
    const jsNames = scriptNamesOfLang(store.project, "js");

    const row = el("div", { class: "row tight" });
    const cur = p.script;
    const pick = button(cur || "选择脚本…", () => {
      if (!jsNames.length) {
        info("还没有 JS 脚本，先去左栏「剧本」切到 JS 新建一段");
        return;
      }
      const r = pick.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 2, [
        ...jsNames.map((n) => ({
          label: n,
          hint: store.project?.scripts[n]?.file ?? "",
          onClick: () => {
            p.script = n;
            syncScriptModule(p);
            store.markDirty();
            window.dispatchEvent(new CustomEvent("bwe:refresh"));
          }
        })),
        { divider: true },
        {
          label: "（不挂脚本）",
          onClick: () => {
            p.script = "";
            syncScriptModule(p);
            store.markDirty();
            window.dispatchEvent(new CustomEvent("bwe:refresh"));
          }
        }
      ]);
    }, { size: "sm", variant: cur ? "outline" : "primary", iconPath: I.script });
    row.appendChild(pick);
    if (cur) {
      row.appendChild(
        el("span", { class: "hint", style: { lineHeight: "26px" } },
          scriptLang(store.project?.scripts[cur]) === "js" ? "JS 脚本" : "（不是 JS，运行期不执行）")
      );
    }
    box.appendChild(fieldRow("对象脚本 Object Script", row,
      "生成出来的对象在启动 / 每帧 / 点击时会调用这段脚本里的函数"));

    if (!cur) {
      box.appendChild(el("div", { class: "hint" },
        jsNames.length
          ? "没有脚本也能用：模块负责默认行为，脚本负责额外逻辑。"
          : "还没有 JS 脚本。去「剧本」页切到 JS 新建一段，回来就能挂。"));
    }
    return box;
  }

  function jitterFields(p: PrefabDef): HTMLElement {
    const box = el("div", { class: "col" });
    const j = p.spawnJitter ?? { x: 0, y: 0 };

    box.appendChild(el("div", { class: "group-label" }, "随机散布 Spawn Jitter"));
    const numField = (label: string, value: number, hint: string, set: (v: number) => void, unit?: string) => {
      const i = input(numText(value), {
        numeric: true,
        hint,
        onChange: (v) => {
          const n = Number(v);
          if (!Number.isFinite(n)) return;
          set(Math.max(0, n));
          store.markDirty();
        }
      });
      i.style.width = "84px";
      const w = el("div", { class: "with-unit" });
      w.appendChild(i);
      if (unit) w.appendChild(el("span", { class: "unit" }, unit));
      box.appendChild(fieldRow(label, w, hint));
    };
    numField("左右散布 Jitter X", j.x, "生成时在 ±这个像素内随机偏移；刷怪一大片时用", (v) => {
      p.spawnJitter = { x: v, y: p.spawnJitter?.y ?? 0 };
    }, "px");
    numField("上下散布 Jitter Y", j.y, "", (v) => {
      p.spawnJitter = { x: p.spawnJitter?.x ?? 0, y: v };
    }, "px");

    box.appendChild(
      el("div", { class: "hint" },
        j.x || j.y
          ? `浏览器里「放置到场景」是手放的，不会真的随机偏；运行期用 bwe.prefab.spawn 生成时才会按这两个值散布。`
          : "全 0 表示每次都在同一个落点。")
    );
    return card("随机散布 Spawn Jitter", box);
  }
}

// ---------------- 动作 ----------------

/** 「复制模块到剪贴板」的面板级暂存（不写系统剪贴板：那玩意儿是异步的，还要权限）。 */
let clipboardModules: import("../core/model.ts").ModuleInstance[] | null = null;

function newPrefab(): void {
  const p = store.project;
  if (!p) return;
  const pf = createPrefab(uniquePrefabName(p, "新预制体"));
  p.prefabs.push(pf);
  selectedPrefabId = pf.id;
  store.markDirty();
  ok(`已新建预制体「${pf.name}」，在右边改属性`);
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
}

/** 从当前选中的场景对象抓一个预制体（坐标归零；只取模板需要的字段）。 */
function captureFromSelection(): void {
  const p = store.project;
  const obj = store.single;
  if (!p) return;
  if (!obj) {
    warn(store.selection.length > 1 ? "一次只能抓一个对象，请先单选" : "先在画布上选中一个对象，再点这里");
    return;
  }
  const name = uniquePrefabName(p, obj.name || KINDS[obj.kind]?.cn || "新预制体");
  const pf = prefabFromObject(obj, name);
  p.prefabs.push(pf);
  // 抓完之后把源对象也标上，这样它也能用「还原为默认值 / 断开链接」
  obj.prefabId = pf.id;
  selectedPrefabId = pf.id;
  store.markDirty();
  ok(`已从「${obj.name || "对象"}」创建预制体「${pf.name}」（${pf.modules.length} 块模块）`);
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
}

/** 把预制体放进当前场景的视图正中。 */
function placePrefab(pf: PrefabDef): void {
  const scene = store.scene;
  if (!scene) {
    warn("没有当前场景");
    return;
  }
  // 视图中心由编辑器提供（App 级事件），拿不到就退回地图中心，总比 (0,0) 好找。
  const center = viewCenter();
  const t = store.project?.tileSize ?? 32;
  const layer = scene.layers[Math.max(0, scene.layers.length - 1)];
  const x = store.snapToGrid ? Math.floor(center.x / t) * t + t / 2 : center.x;
  const y = store.snapToGrid ? Math.floor(center.y / t) * t + t / 2 : center.y;
  const obj = objectFromPrefab(pf, x, y, layer?.id ?? "");
  scene.objects.push(obj);
  store.select(obj);
  store.markDirty();
  window.dispatchEvent(new CustomEvent("bwe:commit"));
  window.dispatchEvent(new CustomEvent("bwe:repaint"));
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
  ok(`已在场景里放置「${pf.name}」，可以直接拖动它`);
}

/**
 * 当前场景视图的中心点。
 *
 * 不直接持有 CanvasView：面板不该反向依赖画布实例。
 * 编辑器监听 `bwe:prefab-view-center` 并把结果写回 detail，没有监听者时走地图中心兜底。
 */
function viewCenter(): { x: number; y: number } {
  // 用 null 当「没人respond」的哨兵：detail 上带 hasCenter 标记，
  // 否则 0,0 与「没人监听」无法区分，放置会永远落在左上角。
  const detail: { x: number; y: number; has?: boolean } = { x: 0, y: 0, has: false };
  window.dispatchEvent(new CustomEvent("bwe:prefab-view-center", { detail }));
  if (detail.has) return { x: detail.x, y: detail.y };
  const scene = store.scene;
  const t = store.project?.tileSize ?? 32;
  return {
    x: ((scene?.widthTiles ?? 20) * t) / 2,
    y: ((scene?.heightTiles ?? 15) * t) / 2
  };
}

function duplicatePrefab(pf: PrefabDef): void {
  const p = store.project;
  if (!p) return;
  const copy: PrefabDef = {
    ...pf,
    id: crypto.randomUUID(),
    name: uniquePrefabName(p, pf.name),
    tags: [...pf.tags],
    modules: cloneModules(pf.modules),
    props: { ...pf.props },
    spawnJitter: { x: pf.spawnJitter?.x ?? 0, y: pf.spawnJitter?.y ?? 0 }
  };
  p.prefabs.push(copy);
  selectedPrefabId = copy.id;
  store.markDirty();
  ok(`已复制出「${copy.name}」`);
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
}

/** 重命名：开一个小模态，回车即提交（比隐藏输入框可预期得多）。 */
function renamePrefab(pf: PrefabDef): void {
  const p = store.project;
  if (!p) return;
  const i = input(pf.name, {
    placeholder: "预制体名字",
    hint: "运行期按这个名字生成物体，不能和别的预制体重名"
  });
  i.style.width = "100%";
  const body = el("div", { class: "col" });
  body.appendChild(el("div", { class: "hint" }, "运行期脚本用 bwe.prefab.spawn(\"名字\") 生成它，所以名字要唯一、好记。"));
  body.appendChild(i);

  let done = false;
  const submit = (close: () => void) => {
    if (done) return;
    const t = i.value.trim();
    if (!t) {
      warn("名字不能为空");
      return;
    }
    if (p.prefabs.some((x) => x !== pf && x.name === t)) {
      warn(`已经有一个叫「${t}」的预制体了，换一个`);
      return;
    }
    done = true;
    pf.name = t;
    store.markDirty();
    ok(`已改名为「${t}」`);
    close();
    window.dispatchEvent(new CustomEvent("bwe:refresh"));
  };
  // 回车直接提交：改个名字不值得再点一次按钮
  i.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      submit(() => closeModal());
    }
  });
  let closeModal: () => void = () => {};
  closeModal = modal({
    title: "重命名预制体",
    body,
    actions: [
      { label: "改名", variant: "primary", onClick: (c) => submit(c) },
      { label: "取消", variant: "ghost", onClick: (c) => c() }
    ]
  });
  window.setTimeout(() => {
    i.focus();
    i.select();
  }, 40);
}

async function removePrefab(pf: PrefabDef): Promise<void> {
  const p = store.project;
  if (!p) return;
  // 数一下有多少对象是从这个模板放出来的：删模板不会删对象（重要！），但要说清楚
  let used = 0;
  for (const s of p.scenes) for (const o of s.objects) if (o.prefabId === pf.id) used++;
  const yes = await confirmDialog(
    `删除预制体「${pf.name}」？`,
    used > 0
      ? `场景里已经有 ${used} 个对象是从它放出来的。删掉模板不会删这些对象，它们会变成「无链接」的普通对象（还能继续用）。`
      : "这个模板还没有被放到任何场景里，删掉不影响现有内容。",
    "删除",
    true
  );
  if (!yes) return;
  p.prefabs = p.prefabs.filter((x) => x !== pf);
  for (const s of p.scenes) for (const o of s.objects) if (o.prefabId === pf.id) o.prefabId = null;
  if (selectedPrefabId === pf.id) selectedPrefabId = "";
  store.markDirty();
  ok(`已删除预制体「${pf.name}」`);
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
  window.dispatchEvent(new CustomEvent("bwe:repaint"));
}

/**
 * 把面板上单独存的 script 写回 script.js 模块。
 *
 * 预制体里脚本有两个落点：模板自己的 `script` 字段（给面板显示/导出用）
 * 和 `modules[]` 里的 script.js 实例（放置到场景后真正生效的那份）。
 * 两边必须同进同退，否则会出现「面板显示挂了脚本、放置出来却没有」。
 */
function syncScriptModule(p: PrefabDef): void {
  const idx = p.modules.findIndex((m) => m.defId === "script.js");
  if (!p.script) {
    if (idx >= 0) p.modules.splice(idx, 1);
    return;
  }
  if (idx >= 0) {
    p.modules[idx].values["script"] = p.script;
    return;
  }
  p.modules.push({
    defId: "script.js",
    trigger: "ALWAYS",
    values: { script: p.script },
    enabled: true,
    collapsed: false
  });
}

/** 统一卡片外壳（与 inspector.ts 的 cardBox 同形，保持两个面板视觉一致）。 */
function card(title: string, body: HTMLElement, iconPath?: string): HTMLElement {
  const box = el("div", { class: "card" });
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
  box.appendChild(head);
  box.appendChild(el("div", { class: "body" }, body));
  return box;
}

/**
 * 模块概览行用的显示名。
 *
 * 直接查模块目录拿中文名（「走多快」而不是「speed」）—— 这个面板是给人看的，
 * defId 只作为查不到时的兜底。data/modules.ts 是只读数据表，我们只读不改。
 */
function moduleTitle(defId: string): string {
  return moduleDef(defId)?.title ?? defId;
}

function moduleBrief(inst: import("../core/model.ts").ModuleInstance): string {
  const def = moduleDef(inst.defId);
  if (!def) {
    const vals = Object.entries(inst.values)
      .slice(0, 3)
      .map(([k, v]) => `${k}=${v}`)
      .join(" · ");
    return vals || inst.defId;
  }
  return moduleSummary(def, inst);
}
