/**
 * 光照面板（右侧辅助栏的一页）：总览 + 一键烘焙 + 光源清单。
 *
 * 结构照已有面板的惯例（`panels/assetPanel.ts` 的卡片/滚动结构、
 * `panels/inspector.ts` 的 cardBox 写法）：
 *   1. 总开关 —— 第一行，因为"没开 = 整个系统不存在"
 *   2. 烘焙参数（模式 / 环境光 / 压暗 / 柔化 / 采样率 / 动态帧率 / 动态上限）
 *   3. **一键烘焙**（醒目的主按钮）+ 上一次烘焙结果统计 + 警告列表
 *   4. 光源清单（每行：名字 / 位置 / 半径 / 颜色 / 类型 / 烘焙 or 动态，点一下选中并定位）
 *
 * 关键纪律：
 *   - **不额外维护一份光照数据**。所有值读写 `store.scene.lighting`（工程数据），
 *     面板只是它的编辑器；面板重建时重新读，切场景/撤销都能自然跟上。
 *   - 改一个字段就 `markDirty` + `bwe:repaint`（画布预览立即跟上）+ `bwe:refresh`
 *     （面板自身重建）。撤销栈走 `bwe:commit`，但连续拖滑块不该每次压一条快照，
 *     所以用 scheduleSnapshot 的语义：这里只发 commit 的轻量版本 —— 见 `commitSoon()`。
 */

import type { LightingModel, SceneObject } from "../core/model.ts";
import { DEFAULT_LIGHTING, normalizeLighting } from "../core/model.ts";
import { store } from "../core/store.ts";
import { el, input, button, select, switchToggle, fieldRow, sliderWithInput, numText } from "../core/dom.ts";
import { I } from "../ui/icons.ts";
import { info, warn, error as toastError } from "../ui/toast.ts";
import { collectSceneLighting } from "../app/lightMath.ts";
import { bakeSceneLighting, type BakeStats } from "../app/lightBake.ts";

/** 上一次烘焙的结果（面板内的临时状态，不进工程数据）。 */
let lastBake: BakeStats | null = null;
/** 烘焙进行中标记：按钮变灰，防止连点堆出多张贴图。 */
let baking = false;

/** 取当前场景的光照设置；缺失时返回**一份新对象**（用户点开关才落盘）。 */
function lightingOf(): LightingModel | null {
  const scene = store.scene;
  if (!scene) return null;
  return scene.lighting ?? null;
}

/**
 * 开/关光照总开关。
 *
 * 打开时若场景还没有 `lighting` 字段，就落一份完整合法的缺省值（`DEFAULT_LIGHTING`）——
 * 这是"用户主动打开"的动作，落盘是正确语义；而旧工程**没被打开**时绝不补字段（零回归）。
 */
function setEnabled(on: boolean): void {
  const scene = store.scene;
  if (!scene) return;
  if (!scene.lighting) {
    if (!on) return; // 关一个本来就没有的东西：什么都不做
    scene.lighting = { ...DEFAULT_LIGHTING, enabled: true };
  } else {
    scene.lighting.enabled = on;
  }
  commitSoon();
}

/** 改任意一个光照字段。 */
function setField<K extends keyof LightingModel>(key: K, value: LightingModel[K]): void {
  const scene = store.scene;
  if (!scene) return;
  if (!scene.lighting) scene.lighting = { ...DEFAULT_LIGHTING };
  scene.lighting[key] = value;
  commitSoon();
}

/**
 * 数据已落定：标脏 + 重画 + 重刷面板。
 *
 * 为什么这里只发 `bwe:repaint` / `bwe:refresh` 而不直接发 `bwe:commit`：
 * commit 会压一条撤销快照，滑块拖动时每次 input 都发 = 撤销栈被灌满（80 步只够拖一次滑块）。
 * 面板里连续改动用 editor 的 `scheduleSnapshot` 语义（延时 320ms 合并）——
 * 它的入口是画布回调而不是 window 事件，所以这里用「停止输入后才发 commit」的落点：
 * 见 `commitSoon` 的定时器。
 */
const COMMIT_DELAY_MS = 320;
let commitTimer = 0;

function commitSoon(): void {
  store.markDirty();
  window.dispatchEvent(new CustomEvent("bwe:repaint"));
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
  window.clearTimeout(commitTimer);
  commitTimer = window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent("bwe:commit", { detail: { label: "改光照设置" } }));
  }, COMMIT_DELAY_MS);
}

export function renderLightingPanel(host: HTMLElement): void {
  host.replaceChildren();
  const wrap = el("div", { class: "col" });
  wrap.style.padding = "10px";
  wrap.style.height = "100%";

  const scene = store.scene;
  const project = store.project;
  if (!scene || !project) {
    wrap.appendChild(el("div", { class: "hint" }, "还没有打开场景"));
    host.appendChild(wrap);
    return;
  }

  // ---------- 0) 顶部：这张场景的名字 ----------
  wrap.appendChild(el("div", { class: "hint" }, `当前场景：${scene.name || "未命名"}　（光照设置存在这张场景上）`));

  // ---------- 1) 总开关 ----------
  const on = scene.lighting?.enabled === true;
  const headCard = el("div", { class: "card" });
  const head = el("header");
  head.appendChild(el("span", null, "2D 光照 Lighting 2D"));
  headCard.appendChild(head);
  const headBody = el("div", { class: "body" });
  headBody.appendChild(
    fieldRow(
      "启用 2D 光照",
      switchToggle(on, (v) => {
        setEnabled(v);
        // 开关会改变整块面板的可见状态（关掉时下面全部灰掉），必须立刻重建
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      }, "打开后：画布显示夜色预览，「一键烘焙」才会生效。关掉 = 白天，不产生任何光照开销"),
      "总开关。关掉时运行时不初始化光照层、编辑器也不画预览 —— 这是「老工程画面不变」的保证"
    )
  );
  if (!on) {
    headBody.appendChild(
      el(
        "div",
        { class: "hint" },
        "光照现在是关的。打开它就能看到夜色预览；画布上右键「在这里放一个光源」可以放灯。"
      )
    );
  }
  headCard.appendChild(headBody);
  wrap.appendChild(headCard);

  // 关掉时后面的设置全都不可编辑？不 —— 允许先摆参数再打开（用户常见的顺序），
  // 只是给一句提示：参数存着，开关一开就生效。
  if (on) {
    wrap.appendChild(settingsCard());
    wrap.appendChild(bakeCard());
    wrap.appendChild(lightsCard());
  } else {
    // 关着的时候也给「一键烘焙」按钮，点了会给出明确原因（而不是按钮消失）
    wrap.appendChild(bakeCard());
  }

  host.appendChild(wrap);
}

// ============================================================================

/** 光照参数卡：模式 / 环境光 / 压暗 / 柔化 / 采样率 / 动态帧率 / 动态光源上限。 */
function settingsCard(): HTMLElement {
  const box = el("div", { class: "col" });
  box.style.marginTop = "10px";
  const scene = store.scene;
  const L = normalizeLighting(scene?.lighting) ?? DEFAULT_LIGHTING;

  box.appendChild(
    fieldRow(
      "模式 Mode",
      select(
        [
          { value: "both", label: "烘焙 + 动态 both" },
          { value: "baked", label: "只用烘焙贴图 baked" },
          { value: "dynamic", label: "只用运行时动态 dynamic" }
        ],
        L.mode,
        {
          hint: "baked = 只画预烘焙的贴图（最省）；dynamic = 每帧按光源重算（可移动的光）；both = 两者叠加",
          onChange: (v) => setField("mode", v === "baked" || v === "dynamic" ? v : "both")
        }
      ),
      "烘焙模式：贴图是静态底图，会移动的光必须选 dynamic / both"
    )
  );

  box.appendChild(
    fieldRow(
      "环境光色 Ambient",
      input(L.ambientColor, {
        hint: "十六进制颜色，例如 #3A4A6B（夜色蓝）",
        onChange: (v) => setField("ambientColor", v.trim() || DEFAULT_LIGHTING.ambientColor)
      })
    )
  );
  box.appendChild(
    fieldRow(
      "环境光强度",
      sliderWithInput({
        value: L.ambientIntensity,
        min: 0,
        max: 1,
        step: 0.01,
        hint: "没有灯的地方不完全是黑的 —— 这个值就是那些地方的亮度",
        onChange: (v) => setField("ambientIntensity", v)
      })
    )
  );
  box.appendChild(
    fieldRow(
      "压暗 Darkness",
      sliderWithInput({
        value: L.darkness,
        min: 0,
        max: 1,
        step: 0.01,
        hint: "整体压暗程度：0 = 白天（不压暗），0.35 是常见夜色",
        onChange: (v) => setField("darkness", v)
      })
    )
  );
  box.appendChild(
    fieldRow(
      "柔化 Softness",
      sliderWithInput({
        value: L.softness,
        min: 0,
        max: 128,
        step: 1,
        hint: "光照边缘的柔和程度（世界像素）。0 = 硬边，16 比较自然",
        onChange: (v) => setField("softness", v)
      })
    )
  );
  box.appendChild(
    fieldRow(
      "采样率 Texels/px",
      select(
        [
          { value: "0.125", label: "0.125（极省，大图用）" },
          { value: "0.25", label: "0.25（推荐）" },
          { value: "0.5", label: "0.5（清晰）" },
          { value: "1", label: "1（最清晰，很占内存）" }
        ],
        String(L.texelsPerPixel),
        {
          hint: "1 世界像素对应几个贴图像素。越大越清晰、烘焙越慢；贴图长边超过 2048 会自动等比缩小",
          onChange: (v) => {
            const n = Number(v);
            setField("texelsPerPixel", Number.isFinite(n) && n > 0 ? n : DEFAULT_LIGHTING.texelsPerPixel);
          }
        }
      )
    )
  );
  box.appendChild(
    fieldRow(
      "动态帧率",
      input(numText(L.dynamicFps), {
        numeric: true,
        hint: "运行时每秒钟最多重算几次动态光照。15 够用，手机上可以更低",
        onChange: (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) setField("dynamicFps", Math.max(1, Math.min(60, Math.round(n))));
        }
      })
    )
  );
  box.appendChild(
    fieldRow(
      "动态光源上限",
      input(numText(L.maxDynamicLights), {
        numeric: true,
        hint: "运行时最多同时算几盏动态光（性能上限，超出按亮度裁掉）",
        onChange: (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) setField("maxDynamicLights", Math.max(0, Math.min(64, Math.round(n))));
        }
      })
    )
  );

  return cardBox("光照参数 Settings", box, I.light);
}

// ============================================================================

/** 一键烘焙卡：主按钮 + 结果统计 + 警告 + 上一次烘焙的贴图信息。 */
function bakeCard(): HTMLElement {
  const box = el("div", { class: "col" });
  box.style.marginTop = "10px";

  const scene = store.scene;
  const lmap = scene?.lightmap;
  // mode="dynamic" 时烘焙**永远是无效操作**（运行时不读烘焙图，见 lightBake.ts 的同名判断）。
  // 所以按钮直接灰掉 + 标题写明原因，而不是让用户点了再吃一个错误 —
  // 灰按钮会让人先想"为什么不能点"，这比"点了报错"更早阻止一次无效操作。
  const dynamicOnly = scene?.lighting?.mode === "dynamic";

  const bakeBtn = button(
    baking ? "烘焙中…" : "一键烘焙 Bake Now",
    () => {
      void runBake();
    },
    {
      variant: "primary",
      iconPath: I.light,
      title: dynamicOnly
        ? "当前模式是「只用运行时动态 dynamic」：烘焙产物不会被任何一帧用到。要烘焙请把上面的模式切到「烘焙 + 动态 both」或「只用烘焙图 baked」"
        : "把这张场景的光照算成一张贴图存进工程素材。之后导出/运行直接用这张图 —— 游戏里就是你现在看到的效果",
      disabled: baking || dynamicOnly
    }
  );
  bakeBtn.style.width = "100%";
  bakeBtn.style.height = "34px";
  bakeBtn.style.fontWeight = "600";
  // 稳定锚点：验收脚本用 [data-action="light-bake"] 点它，不依赖按钮文案
  bakeBtn.dataset.action = "light-bake";
  bakeBtn.dataset.disabledReason = dynamicOnly ? "mode-dynamic" : "";
  box.appendChild(bakeBtn);

  // 灰按钮必须给一条**看得见**的原因：只靠 title(hover) 在触屏上是看不到的
  if (dynamicOnly) {
    const why = el(
      "div",
      { class: "hint" },
      "⚠ 当前模式是「只用运行时动态 dynamic」，烘焙不会生效（运行时不读烘焙图）。" +
        "要烘焙请把上面对「模式」切到「烘焙 + 动态 both」或「只用烘焙图 baked」。"
    );
    why.style.color = "var(--warn, #f0a92b)";
    box.appendChild(why);
  }

  // 上次烘焙的信息（来自工程数据，不是内存态 —— 重开工程也看得到）
  if (lmap) {
    const when = lmap.bakedAt ? new Date(lmap.bakedAt) : null;
    const whenText = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : "时间未知";
    box.appendChild(
      el(
        "div",
        { class: "hint" },
        `上次烘焙：${lmap.texW}×${lmap.texH} 贴图 · ${lmap.lights} 盏灯 · 覆盖 ${lmap.w}×${lmap.h} 世界像素 · ${whenText}`
      )
    );
  } else {
    box.appendChild(el("div", { class: "hint" }, "还没有烘焙过。点上面的按钮，或先放几盏灯。"));
  }

  // 本次（内存里）的统计：只有刚点完才显示，让人知道刚才那一下做了什么
  if (lastBake) {
    const st = el("div", { class: "col" });
    st.style.gap = "2px";
    st.appendChild(
      el(
        "div",
        { class: "hint" },
        `本次：贴图 ${lastBake.texW}×${lastBake.texH}（采样率 ${lastBake.sEff.toFixed(3)}）` +
          ` · 光源 ${lastBake.lights} 盏` +
          (lastBake.dynamicSkipped ? `（另有 ${lastBake.dynamicSkipped} 盏动态光已排除）` : "") +
          ` · 计算 ${Math.round(lastBake.ms)} ms`
      )
    );
    if (lastBake.removedOld > 0) {
      st.appendChild(el("div", { class: "hint" }, `已合并掉上一次的烘焙贴图 ${lastBake.removedOld} 张（素材库不会越烘越多）`));
    }
    if (lastBake.warnings.length) {
      const warnBox = el("div", { class: "col" });
      warnBox.style.gap = "3px";
      warnBox.style.marginTop = "4px";
      for (const w of lastBake.warnings) {
        const row = el("div", { class: "hint" }, `⚠ ${w}`);
        row.style.color = "var(--warn, #f0a92b)";
        warnBox.appendChild(row);
      }
      st.appendChild(warnBox);
    }
    box.appendChild(st);
  }

  return cardBox("烘焙 Bake", box, I.light);
}

/** 真的跑一次烘焙。失败一律 toast + 面板提示，不抛异常。 */
async function runBake(): Promise<void> {
  if (baking) return;
  const scene = store.scene;
  if (!scene) {
    toastError("没有打开场景");
    return;
  }
  if (!scene.lighting || scene.lighting.enabled !== true) {
    // 明确提示，而不是静默什么都不做（用户会以为按钮坏了）
    warn("光照总开关关着：先打开上面的「启用 2D 光照」，再烘焙");
    info("烘焙产物只有运行时启用光照才会被用上，所以关着时不做无意义的计算");
    return;
  }
  // 命令面板等入口绕过了灰掉的按钮，所以这里再挡一次（与 lightBake.ts 的判断保持同一句话）
  if (scene.lighting.mode === "dynamic") {
    warn("当前模式是「只用运行时动态 dynamic」：烘焙产物不会被用到，请先切到 baked 或 both");
    info("想保留动态光：把它们勾上「烘焙时排除（动态光）」，模式改成 baked / both 即可");
    return;
  }

  baking = true;
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
  try {
    const out = await bakeSceneLighting(scene, store.project);
    if (!out.ok) {
      toastError(`烘焙失败：${out.error}`);
      return;
    }
    lastBake = out;
    const warnCount = out.warnings.length;
    info(
      `烘焙完成：${out.texW}×${out.texH} 贴图，${out.lights} 盏灯，${Math.round(out.ms)} ms` +
        (warnCount ? `（${warnCount} 条提醒，见面板）` : "")
    );
    for (const w of out.warnings) warn(w);
  } catch (e) {
    // bakeSceneLighting 内部已经兜了一层，这里是最后一道（例如 refresh 监听器抛出）
    toastError(`烘焙失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    baking = false;
    window.dispatchEvent(new CustomEvent("bwe:refresh"));
  }
}

// ============================================================================

/** 光源清单：每行显示关键参数，点一下选中并定位。 */
function lightsCard(): HTMLElement {
  const box = el("div", { class: "col" });
  box.style.marginTop = "10px";
  const scene = store.scene;
  const project = store.project;
  if (!scene || !project) return cardBox("光源清单 Lights", box, I.light);

  // ★ 走 lightMath 的采集函数：清单、烘焙、画布预览三处读的是**同一套** §3.3 规则。
  //   自己在这里再写一遍「模块优先于 props」，迟早出现"清单显示 200、烘焙按 140 算"。
  const lights = collectSceneLighting(scene, project);
  if (!lights.length) {
    box.appendChild(
      el("div", { class: "hint" },
        "这张场景还没有光源。在画布空白处右键 →「在这里放一个光源」，或用「模块」页给火把/路灯挂一个 render.light 模块。")
    );
    return cardBox("光源清单 Lights", box, I.light);
  }

  // 对象索引：从光源 id 找回 SceneObject（选中、定位都要它）
  const byId = new Map<string, SceneObject>();
  for (const o of scene.objects) byId.set(o.id, o);

  // 概况：几盏烘焙几盏动态
  const baked = lights.filter((l) => !l.dynamic).length;
  const dyn = lights.length - baked;
  box.appendChild(el("div", { class: "hint" }, `共 ${lights.length} 盏：烘焙 ${baked} 盏 · 动态 ${dyn} 盏（动态光不进贴图）`));

  const list = el("div", { class: "col" });
  list.style.gap = "3px";
  list.style.marginTop = "6px";

  for (const l of lights) {
    const obj = byId.get(l.id);
    const row = el("div", { class: "row tight" });
    row.style.alignItems = "center";
    row.style.cursor = "pointer";
    row.style.padding = "4px 6px";
    row.style.borderRadius = "6px";
    row.style.border = "1px solid var(--line)";
    if (obj && store.isSelected(obj)) {
      row.style.borderColor = "var(--accent)";
      row.style.background = "color-mix(in srgb, var(--accent) 12%, transparent)";
    }
    row.title = "点一下选中这盏光并把它移到画布中央";

    // 颜色块：光源颜色是最直观的标识
    const sw = el("span");
    sw.style.cssText = `width:10px;height:10px;border-radius:50%;flex:0 0 auto;border:1px solid rgba(255,255,255,.3);background:${l.color ?? "#FFC978"}`;
    row.appendChild(sw);

    const name = el("span", null, obj?.name || "光源");
    name.style.flex = "1";
    name.style.fontSize = "12px";
    name.style.overflow = "hidden";
    name.style.textOverflow = "ellipsis";
    name.style.whiteSpace = "nowrap";
    row.appendChild(name);

    const meta = el(
      "span",
      { class: "muted" },
      `${Math.round(Number(l.x) || 0)},${Math.round(Number(l.y) || 0)}　r${Math.round(Number(l.radius) || 0)}　` +
        `${l.type === "spot" ? "聚光" : "点光"}　${l.dynamic ? "动态" : "烘焙"}`
    );
    meta.style.fontSize = "11px";
    meta.style.flex = "0 0 auto";
    row.appendChild(meta);

    row.addEventListener("click", () => {
      if (obj) {
        store.select(obj);
        // 选中后定位到它：画布自己监听 selection 会重画，但不会自动居中。
        // 用 bwe:focus-object 让 editor 侧做"居中 + 重画"，面板不用持有画布引用。
        window.dispatchEvent(new CustomEvent("bwe:focus-object", { detail: { id: obj.id, x: obj.x, y: obj.y } }));
      } else {
        warn("这盏光的对象已经不在了（可能刚被删掉），刷新面板后再试");
      }
    });
    list.appendChild(row);
  }
  box.appendChild(list);

  box.appendChild(
    button("全部选中并框住", () => {
      const objs = lights.map((l) => byId.get(l.id)).filter((o): o is SceneObject => !!o);
      if (!objs.length) return;
      store.selectMany(objs);
      info(`已选中 ${objs.length} 盏光`);
    }, { size: "sm", variant: "ghost" })
  );

  return cardBox("光源清单 Lights", box, I.light);
}

/** 统一卡片外壳（与 inspector.ts 的 cardBox 同款；面板间保持一致视觉）。 */
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
