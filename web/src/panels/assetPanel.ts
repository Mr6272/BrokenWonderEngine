/**
 * 素材库面板 + 序列帧编辑器。
 *
 * 导入三种入口，覆盖真实使用场景：
 *   「导入精灵」  一次多选，一张一条
 *   「导入序列帧」一次多选一组图，自动按名字前缀分组（待机1/待機2/…）
 *   「导入图集」  一张大图按行列切
 * 另外支持把文件从资源管理器直接拖进面板，不强迫用户先点按钮。
 *
 * 序列帧编辑器（用户明确要求）：
 *   逐帧预览、播放/暂停、帧率调整、单帧显隐、帧序调换、首帧标记、图集切法微调。
 *   所有改动即时写入工程数据，不需要"保存"按钮。
 */

import type { AssetEntry } from "../core/model.ts";
import { totalFrames, visibleFrames } from "../core/model.ts";
import { store } from "../core/store.ts";
import {
  importAtlas,
  importFiles,
  importSequenceSet,
  deleteAsset,
  assetKindShort,
  invalidateAsset,
  loadFrame,
  checkAssetHealth
} from "../data/assets.ts";
import { drawThumb, forgetPicture } from "../app/painter.ts";
import { emptyState, el, input, button, iconButton, numText } from "../core/dom.ts";
import { I } from "../ui/icons.ts";
import { error, info, modal, ok, confirmDialog, contextMenu } from "../ui/toast.ts";

let filterKind: "all" | "IMAGE" | "SEQUENCE" | "ATLAS" | "AUDIO" = "all";
let searchText = "";
let selectedAssetId = "";

export function renderAssetPanel(host: HTMLElement): void {
  host.replaceChildren();

  const wrap = el("div", { class: "col" });
  wrap.style.padding = "10px";
  wrap.style.height = "100%";

  // ---- 导入按钮 ----
  const actions = el("div", { class: "row tight wrap" });

  const filePicker = el("input", { type: "file", multiple: true, accept: "image/*,audio/*" });
  filePicker.style.display = "none";
  filePicker.addEventListener("change", async () => {
    const files = Array.from(filePicker.files ?? []);
    filePicker.value = "";
    if (!files.length || !store.project) return;
    const res = await importFiles(store.project, files);
    afterImport(res.added, res.skipped, res.message);
  });

  const seqPicker = el("input", { type: "file", multiple: true, accept: "image/*" });
  seqPicker.style.display = "none";
  seqPicker.addEventListener("change", async () => {
    const files = Array.from(seqPicker.files ?? []);
    seqPicker.value = "";
    if (!files.length || !store.project) return;
    const res = await importSequenceSet(store.project, files);
    afterImport(res.added, res.skipped, res.message);
  });

  actions.appendChild(
    button("导入精灵", () => filePicker.click(), {
      variant: "primary",
      size: "sm",
      iconPath: I.sprite,
      title: "一次可选多张，每张算一条素材（Ctrl / Shift 多选）"
    })
  );
  actions.appendChild(
    button("导入序列帧", () => seqPicker.click(), {
      size: "sm",
      iconPath: I.sheet,
      title: "选中一组图，例如 待机1.png 待机2.png，会自动合成一条动画"
    })
  );
  actions.appendChild(
    button("导入图集", () => openAtlasImport(), {
      size: "sm",
      iconPath: I.atlas,
      title: "一张大图按行列切成多帧"
    })
  );
  actions.appendChild(
    button("检查完整性", () => checkIntegrity(), {
      size: "sm",
      iconPath: I.health,
      title: "检测素材文件是否缺失或无法加载"
    })
  );
  wrap.appendChild(actions);

  // ---- 搜索与筛选 ----
  const s = input(searchText, {
    placeholder: "搜索素材名 / 类型",
    onChange: (v) => {
      searchText = v;
      renderGrid(grid);
      void grid;
    }
  });
  s.style.marginTop = "8px";
  s.style.height = "26px";
  wrap.appendChild(s);

  const kinds: { v: typeof filterKind; label: string }[] = [
    { v: "all", label: "全部" },
    { v: "IMAGE", label: "精灵" },
    { v: "SEQUENCE", label: "序列帧" },
    { v: "ATLAS", label: "图集" },
    { v: "AUDIO", label: "音频" }
  ];
  const seg = el("div", { class: "segmented" });
  seg.style.marginTop = "6px";
  for (const k of kinds) {
    const b = el("button", { type: "button", class: filterKind === k.v ? "active" : "" }, k.label);
    b.addEventListener("click", () => {
      filterKind = k.v;
      Array.from(seg.children).forEach((c) => c.classList.remove("active"));
      b.classList.add("active");
      renderGrid(grid);
    });
    seg.appendChild(b);
  }
  wrap.appendChild(seg);

  const grid = el("div", { class: "asset-grid" });
  grid.style.marginTop = "10px";
  wrap.appendChild(grid);

  host.appendChild(wrap);
  host.appendChild(filePicker);
  host.appendChild(seqPicker);

  // 从资源管理器拖文件进面板
  host.addEventListener("dragover", (e) => {
    e.preventDefault();
    host.style.outline = "2px dashed var(--accent)";
  });
  host.addEventListener("dragleave", () => {
    host.style.outline = "";
  });
  host.addEventListener("drop", async (e) => {
    e.preventDefault();
    host.style.outline = "";
    const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
    if (!files.length || !store.project) return;
    // 一次拖多张时按"序列帧"处理更符合直觉（用户通常一次拖一整组图）
    const res = files.length > 1 ? await importSequenceSet(store.project, files) : await importFiles(store.project, files);
    afterImport(res.added, res.skipped, res.message);
  });

  renderGrid(grid);
}

function afterImport(added: number, skipped: number, message?: string): void {
  if (added > 0) {
    store.markDirty();
    ok(`导入 ${added} 个素材${skipped > 0 ? `（跳过重复 ${skipped} 个）` : ""}`);
  } else if (skipped > 0) {
    info(message ?? "这些素材已经在素材库里了");
  } else {
    error(message ?? "没有可导入的素材");
  }
  refreshAllPanels();
}

function refreshAllPanels(): void {
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
}

function renderGrid(grid: HTMLElement): void {
  grid.replaceChildren();
  const list = visibleAssets();
  if (!list.length) {
    const hasAny = (store.project?.assets.length ?? 0) > 0;
    grid.appendChild(
      emptyState(
        I.sprite,
        hasAny ? "没有匹配的素材" : "素材库是空的",
        hasAny
          ? "换一个关键词，或点上面的「全部」分类查看。"
          : "点上面的「导入精灵」选几张图，或直接把文件拖到这里。",
        hasAny ? undefined : button("导入精灵", () => (document.querySelector('input[type="file"]') as HTMLInputElement)?.click(), { variant: "primary", size: "sm" })
      )
    );
    // 空状态在网格里要横跨整行
    (grid.firstElementChild as HTMLElement).style.gridColumn = "1 / -1";
    return;
  }
  for (const a of list) {
    grid.appendChild(assetCell(a));
  }
}

function visibleAssets(): AssetEntry[] {
  const all = store.assets;
  const q = searchText.trim().toLowerCase();
  return all.filter((a) => {
    if (filterKind !== "all" && a.kind !== filterKind) return false;
    if (q && !a.name.toLowerCase().includes(q) && !a.group.toLowerCase().includes(q)) return false;
    return true;
  });
}

function assetCell(a: AssetEntry): HTMLElement {
  const cell = el("div", { class: "asset-cell" + (a.id === selectedAssetId ? " selected" : "") });
  const thumb = el("div", { class: "thumb" });
  const c = el("canvas");
  thumb.appendChild(c);
  void drawThumb(c, a, 0, 68);

  const nm = el("div", { class: "name" }, a.name);
  nm.title = a.name;
  const meta = el("div", { class: "meta" }, `${assetKindShort(a.kind)}${a.kind === "SEQUENCE" ? ` ${a.frameCount ?? 1}帧` : ""}`);

  // 使用统计
  const usedObjs = (store.scene?.objects ?? []).filter((o) => o.assetId === a.id);
  const usedLine = el("div", { class: "meta", style: { marginTop: "2px" } });
  if (usedObjs.length) {
    usedLine.textContent = `已被 ${usedObjs.length} 个对象使用`;
    usedLine.style.color = "var(--ok)";
    usedLine.style.cursor = "pointer";
    usedLine.title = "点击选中画布上所有使用这个素材的对象";
    usedLine.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!store.scene) return;
      store.selectMany(usedObjs);
      window.dispatchEvent(new CustomEvent("bwe:open-modules"));
      // 切到左栏场景页并提示
      info(`已选中 ${usedObjs.length} 个使用「${a.name}」的对象`);
    });
    usedLine.addEventListener("mouseenter", () => { usedLine.style.textDecoration = "underline"; });
    usedLine.addEventListener("mouseleave", () => { usedLine.style.textDecoration = "none"; });
  } else {
    usedLine.textContent = "未被任何对象使用";
    usedLine.style.color = "var(--text-3)";
  }

  cell.appendChild(thumb);
  cell.appendChild(nm);
  cell.appendChild(meta);
  cell.appendChild(usedLine);

  cell.draggable = true;
  cell.addEventListener("dragstart", (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (!dt) return;
    dt.setData("application/x-bwe-asset", a.id);
    dt.setData("text/plain", a.id);
    dt.effectAllowed = "copy";
  });
  const choose = () => {
    selectedAssetId = a.id;
    store.paintAssetId = a.id;
    renderGrid(cell.parentElement as HTMLElement);
  };
  cell.addEventListener("click", choose);
  cell.addEventListener("dblclick", () => openSpriteEditor(a));
  cell.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    choose();
    const items = [
      { label: "打开序列帧编辑器", onClick: () => openSpriteEditor(a), disabled: a.kind === "AUDIO" },
      { label: "放大预览", onClick: () => openAssetPreview(a) },
      { label: "用地块画笔连续铺", onClick: () => { store.setTool("brush"); store.paintAssetId = a.id; info("已切到画笔，在画布上拖动即可连续铺地块"); }, disabled: a.kind === "AUDIO" },
      { divider: true },
      {
        label: "删除素材",
        onClick: async () => {
          const used = usedObjs.length > 0;
          if (used) {
            const yes = await confirmDialog("这个素材正在被地图使用", `「${a.name}」被当前场景的 ${usedObjs.length} 个对象引用了，删掉后这些对象会显示成占位方块。`, "仍然删除", true);
            if (!yes) return;
          }
          if (!store.project) return;
          await deleteAsset(store.project, a.id);
          forgetPicture(a.id);
          invalidateAsset(a.id);
          store.markDirty();
          ok(`已删除「${a.name}」`);
          refreshAllPanels();
        }
      }
    ];
    contextMenu(e.clientX, e.clientY, items);
  });
  return cell;
}

/** 放大预览素材：在模态框里显示原图/首帧，支持缩放。 */
function openAssetPreview(a: AssetEntry): void {
  modal({
    title: `预览 — ${a.name}`,
    wide: true,
    body: () => {
      const box = el("div", { class: "col" });
      const infoLine = el("div", { class: "hint" }, `${a.width}×${a.height} px　·　${assetKindShort(a.kind)}${a.kind === "SEQUENCE" ? ` · ${a.frameCount ?? 1} 帧` : ""}`);
      box.appendChild(infoLine);

      const wrap = el("div", { class: "preview-box" });
      wrap.style.minHeight = "400px";
      const canvas = el("canvas");
      canvas.style.maxWidth = "100%";
      canvas.style.maxHeight = "60vh";
      canvas.style.imageRendering = "pixelated";
      wrap.appendChild(canvas);
      box.appendChild(wrap);

      // 简单缩放控制
      const ctrl = el("div", { class: "row tight" });
      ctrl.style.marginTop = "8px";
      let scale = 1;
      const redraw = () => {
        const g = canvas.getContext("2d");
        if (!g) return;
        const dpr = window.devicePixelRatio || 1;
        const drawW = Math.round(a.width * scale);
        const drawH = Math.round(a.height * scale);
        canvas.width = drawW * dpr;
        canvas.height = drawH * dpr;
        canvas.style.width = drawW + "px";
        canvas.style.height = drawH + "px";
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.imageSmoothingEnabled = false;
        g.fillStyle = "#15171d";
        g.fillRect(0, 0, a.width, a.height);
        void loadFrame(a, 0).then((img) => {
          if (img) g.drawImage(img.bitmap, 0, 0);
        });
      };
      ctrl.appendChild(button("缩小 −", () => { scale = Math.max(0.25, scale - 0.25); redraw(); }, { size: "sm" }));
      ctrl.appendChild(button("放大 ＋", () => { scale = Math.min(4, scale + 0.25); redraw(); }, { size: "sm" }));
      ctrl.appendChild(el("span", { class: "muted" }, `缩放：${Math.round(scale * 100)}%`));
      ctrl.appendChild(el("div", { class: "spacer" }));
      box.appendChild(ctrl);

      window.setTimeout(redraw, 10);
      return box;
    },
    actions: [{ label: "关闭", variant: "primary", onClick: (c) => c() }]
  });
}

// ---------------- 图集导入 ----------------

function openAtlasImport(): void {
  if (!store.project) {
    error("先新建或打开一个工程");
    return;
  }
  const state = { file: null as File | null, cols: 4, rows: 4, cellW: 0, cellH: 0, imgW: 0, imgH: 0 };

  modal({
    title: "导入图集 Sprite Atlas",
    body: (close) => {
      const box = el("div", { class: "col" });
      const fileRow = el("div", { class: "row" });
      const fileBtn = button("选择图片…", () => picker.click(), { size: "sm", iconPath: I.import });
      const picker = el("input", { type: "file", accept: "image/*" });
      picker.style.display = "none";
      const fileName = el("span", { class: "hint" }, "未选择文件");
      fileRow.appendChild(fileBtn);
      fileRow.appendChild(fileName);
      box.appendChild(fileRow);

      const grid2 = el("div", { class: "row-2" });
      const colW = el("div", { class: "field" });
      const rowW = el("div", { class: "field" });
      const cw = el("div", { class: "field" });
      const ch = el("div", { class: "field" });
      colW.appendChild(el("label", null, "列数 Columns"));
      const colsI = input("4", { numeric: true, onChange: (v) => { state.cols = Math.max(1, Number(v) || 1); draw(); } });
      colW.appendChild(colsI);
      rowW.appendChild(el("label", null, "行数 Rows"));
      const rowsI = input("4", { numeric: true, onChange: (v) => { state.rows = Math.max(1, Number(v) || 1); draw(); } });
      rowW.appendChild(rowsI);
      cw.appendChild(el("label", null, "单帧宽 Cell W（0 = 自动）"));
      const cwi = input("0", { numeric: true, onChange: (v) => { state.cellW = Math.max(0, Number(v) || 0); draw(); } });
      cw.appendChild(cwi);
      ch.appendChild(el("label", null, "单帧高 Cell H（0 = 自动）"));
      const chi = input("0", { numeric: true, onChange: (v) => { state.cellH = Math.max(0, Number(v) || 0); draw(); } });
      ch.appendChild(chi);
      grid2.appendChild(colW);
      grid2.appendChild(rowW);
      grid2.appendChild(cw);
      grid2.appendChild(ch);
      box.appendChild(grid2);

      const preview = el("div", { class: "atlas-grid" });
      box.appendChild(preview);

      const infoLine = el("div", { class: "hint" }, "选一张图后这里会显示切分预览");
      box.appendChild(infoLine);

      const draw = () => {
        preview.replaceChildren();
        if (!state.file) return;
        void (async () => {
          const bmp = await createImageBitmap(state.file as File);
          state.imgW = bmp.width;
          state.imgH = bmp.height;
          const cols = state.cols;
          const rows = state.rows;
          const cwp = state.cellW || Math.floor(bmp.width / cols);
          const chp = state.cellH || Math.floor(bmp.height / rows);
          const maxW = 520;
          const scale = Math.min(1, maxW / bmp.width);
          const c = el("canvas");
          c.width = Math.round(bmp.width * scale);
          c.height = Math.round(bmp.height * scale);
          c.style.width = c.width + "px";
          c.style.height = c.height + "px";
          const g = c.getContext("2d");
          if (g) {
            g.imageSmoothingEnabled = false;
            g.drawImage(bmp, 0, 0, c.width, c.height);
            g.strokeStyle = "rgba(76,141,255,0.85)";
            g.lineWidth = 1;
            for (let i = 1; i < cols; i++) {
              const x = Math.round((i * cwp * scale)) + 0.5;
              g.beginPath();
              g.moveTo(x, 0);
              g.lineTo(x, c.height);
              g.stroke();
            }
            for (let j = 1; j < rows; j++) {
              const y = Math.round((j * chp * scale)) + 0.5;
              g.beginPath();
              g.moveTo(0, y);
              g.lineTo(c.width, y);
              g.stroke();
            }
          }
          preview.replaceChildren(c);
          infoLine.textContent = `原图 ${bmp.width}×${bmp.height}　→　切成 ${cols}×${rows}，每帧 ${cwp}×${chp}px，共 ${cols * rows} 帧`;
        })();
      };

      picker.addEventListener("change", () => {
        const f = picker.files?.[0];
        picker.value = "";
        if (!f) return;
        state.file = f;
        fileName.textContent = f.name;
        draw();
      });
      window.setTimeout(draw, 10);

      // 把提交逻辑挂在闭包上，供 footer 按钮调用
      (close as unknown as { __submit?: () => Promise<void> }).__submit = async () => {
        if (!state.file || !store.project) {
          error("先选一张图片");
          return;
        }
        const res = await importAtlas(store.project, state.file, state.cols, state.rows, state.cellW, state.cellH);
        if (res.added) {
          store.markDirty();
          ok("图集已导入");
          close();
          refreshAllPanels();
        } else {
          error("图集导入失败");
        }
      };
      return box;
    },
    actions: [
      {
        label: "导入",
        variant: "primary",
        onClick: (close) => {
          const submit = (close as unknown as { __submit?: () => Promise<void> }).__submit;
          void submit?.();
        }
      },
      { label: "取消", variant: "ghost", onClick: (close) => close() }
    ],
    wide: false
  });
}

// ---------------- 序列帧编辑器 ----------------

export function openSpriteEditor(asset: AssetEntry): void {
  if (asset.kind === "AUDIO") {
    info("音频素材没有帧可以编辑");
    return;
  }
  const total = totalFrames(asset);
  const state = {
    frame: 0,
    playing: true,
    fps: asset.kind === "ATLAS" ? 8 : 8,
    t0: performance.now(),
    timer: 0
  };

  let stripEl: HTMLElement | null = null;
  let previewCanvas: HTMLCanvasElement | null = null;
  let infoEl: HTMLElement | null = null;

  const close = modal({
    title: `序列帧编辑器 — ${asset.name}`,
    wide: true,
    body: (closeFn) => {
      const box = el("div", { class: "sprite-editor" });

      // 左：属性与统计
      const left = el("div", { class: "col" });
      left.appendChild(el("div", { class: "group-label" }, "帧信息"));
      const stat = el("div", { class: "hint" });
      infoEl = stat;
      left.appendChild(stat);

      left.appendChild(el("div", { class: "group-label" }, "播放"));
      const previewBox = el("div", { class: "preview-box" });
      previewCanvas = el("canvas");
      previewBox.appendChild(previewCanvas);
      left.appendChild(previewBox);

      const ctrl = el("div", { class: "row tight" });
      ctrl.appendChild(
        button("播放", () => {
          state.playing = true;
          state.t0 = performance.now();
        }, { size: "sm", iconPath: I.play })
      );
      ctrl.appendChild(
        button("暂停", () => {
          state.playing = false;
        }, { size: "sm", iconPath: I.stop })
      );
      left.appendChild(ctrl);

      left.appendChild(el("div", { class: "field" }));
      const fpsI = input(String(state.fps), {
        numeric: true,
        onChange: (v) => {
          state.fps = Math.max(1, Math.min(60, Number(v) || 8));
        }
      });
      const fpsField = el("div", { class: "field" });
      fpsField.appendChild(el("label", null, "帧率 Frame Rate (fps)"));
      fpsField.appendChild(fpsI);
      left.appendChild(fpsField);

      if (asset.kind !== "ATLAS") {
        left.appendChild(el("div", { class: "group-label" }, "序列设置"));
        const flipRow = el("div", { class: "row tight" });
        flipRow.appendChild(
          button("整体倒序", () => {
            reorderFrames(asset, visibleFrames(asset).reverse());
            ok("帧序已倒转");
            closeFn();
            openSpriteEditor(reloadAsset(asset.id));
          }, { size: "sm", iconPath: I.undo })
        );
        flipRow.appendChild(
          button("恢复全部帧", () => {
            asset.hiddenFrames = [];
            store.markDirty();
            ok("已恢复全部帧");
            closeFn();
            openSpriteEditor(reloadAsset(asset.id));
          }, { size: "sm" })
        );
        left.appendChild(flipRow);
      }

      // 右：帧条
      const right = el("div", { class: "col" });
      const head = el("div", { class: "row" });
      head.appendChild(el("div", { class: "group-label" }, "帧 Frames"));
      head.appendChild(el("div", { class: "spacer" }));
      head.appendChild(
        el("span", { class: "hint" }, "单击选中 · 右键单帧操作 · 拖拽可调帧序")
      );
      right.appendChild(head);

      stripEl = el("div", { class: "frame-strip" });
      right.appendChild(stripEl);

      if (asset.kind === "ATLAS") {
        const atlasRow = el("div", { class: "row tight" });
        atlasRow.appendChild(el("label", { class: "hint" }, "列数"));
        const ci = input(String(asset.cols ?? 1), {
          numeric: true,
          onChange: (v) => {
            asset.cols = Math.max(1, Number(v) || 1);
            store.markDirty();
            invalidateAsset(asset.id);
            forgetPicture(asset.id);
            drawStrip();
          }
        });
        ci.style.width = "56px";
        atlasRow.appendChild(ci);
        atlasRow.appendChild(el("label", { class: "hint" }, "行数"));
        const ri = input(String(asset.rows ?? 1), {
          numeric: true,
          onChange: (v) => {
            asset.rows = Math.max(1, Number(v) || 1);
            store.markDirty();
            invalidateAsset(asset.id);
            forgetPicture(asset.id);
            drawStrip();
          }
        });
        ri.style.width = "56px";
        atlasRow.appendChild(ri);
        atlasRow.appendChild(el("label", { class: "hint" }, "单帧宽"));
        const wi = input(String(asset.cellW ?? 0), {
          numeric: true,
          onChange: (v) => {
            asset.cellW = Math.max(0, Number(v) || 0);
            store.markDirty();
            invalidateAsset(asset.id);
            forgetPicture(asset.id);
            drawStrip();
          }
        });
        wi.style.width = "64px";
        atlasRow.appendChild(wi);
        atlasRow.appendChild(el("label", { class: "hint" }, "高"));
        const hi = input(String(asset.cellH ?? 0), {
          numeric: true,
          onChange: (v) => {
            asset.cellH = Math.max(0, Number(v) || 0);
            store.markDirty();
            invalidateAsset(asset.id);
            forgetPicture(asset.id);
            drawStrip();
          }
        });
        hi.style.width = "64px";
        atlasRow.appendChild(hi);
        right.appendChild(atlasRow);
      }

      box.appendChild(left);
      box.appendChild(right);

      window.setTimeout(() => {
        drawStrip();
        startPlayback();
      }, 20);
      return box;
    },
    actions: [
      {
        label: "完成",
        variant: "primary",
        onClick: (c) => {
          if (state.timer) window.clearTimeout(state.timer);
          store.markDirty();
          c();
          refreshAllPanels();
        }
      }
    ],
    onClose: () => {
      if (state.timer) window.clearTimeout(state.timer);
      store.markDirty();
    }
  });

  function reloadAsset(id: string): AssetEntry {
    return store.findAsset(id) ?? asset;
  }

  function startPlayback(): void {
    const tick = () => {
      if (state.playing) {
        const frames = asset.kind === "SEQUENCE" ? visibleFrames(asset) : Array.from({ length: totalFrames(asset) }, (_, i) => i);
        if (frames.length) {
          const dt = performance.now() - state.t0;
          const idx = Math.floor((dt / 1000) * state.fps) % frames.length;
          state.frame = frames[idx];
        }
      }
      drawPreview();
      state.timer = window.setTimeout(tick, Math.max(16, 1000 / Math.max(1, state.fps)));
    };
    tick();
  }

  function drawPreview(): void {
    if (!previewCanvas) return;
    const frames = asset.kind === "SEQUENCE" ? visibleFrames(asset) : Array.from({ length: totalFrames(asset) }, (_, i) => i);
    if (!frames.length) return;
    const f = frames.includes(state.frame) ? state.frame : frames[0];
    state.frame = f;
    void drawThumb(previewCanvas, asset, f, 130);
    if (infoEl) {
      const sz = `${asset.width || "?"}×${asset.height || "?"}px`;
      infoEl.textContent =
        `类型 ${assetKindShort(asset.kind)}　共 ${totalFrames(asset)} 帧　可用 ${frames.length} 帧\n` +
        `当前第 ${f + 1} 帧　原图 ${sz}　分组「${asset.group}」`;
    }
  }

  function drawStrip(): void {
    if (!stripEl) return;
    stripEl.replaceChildren();
    const totalN = totalFrames(asset);
    const hidden = new Set(asset.hiddenFrames ?? []);
    for (let i = 0; i < totalN; i++) {
      const cell = el("div", {
        class: "frame-cell" + (i === state.frame ? " selected" : "") + (hidden.has(i) ? " hidden" : "")
      });
      const c = el("canvas");
      cell.appendChild(c);
      cell.appendChild(el("span", { class: "idx" }, String(i + 1)));
      void drawThumb(c, asset, i, 56);
      cell.addEventListener("click", () => {
        state.frame = i;
        state.playing = false;
        drawStrip();
        drawPreview();
      });
      cell.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          {
            label: hidden.has(i) ? "显示这一帧" : "隐藏这一帧",
            onClick: () => {
              const set = new Set(asset.hiddenFrames ?? []);
              if (set.has(i)) set.delete(i);
              else set.add(i);
              asset.hiddenFrames = Array.from(set).sort((a, b) => a - b);
              store.markDirty();
              drawStrip();
            }
          },
          {
            label: "设为第一帧",
            disabled: i === 0,
            onClick: () => {
              const order = Array.from({ length: totalN }, (_, k) => k);
              const rotated = order.slice(i).concat(order.slice(0, i));
              reorderFrames(asset, rotated);
              state.frame = 0;
              store.markDirty();
              drawStrip();
              ok("已设为第一帧");
            }
          },
          { divider: true },
          {
            label: "只保留这一帧",
            onClick: () => {
              const set = new Set(Array.from({ length: totalN }, (_, k) => k));
              set.delete(i);
              asset.hiddenFrames = Array.from(set).sort((a, b) => a - b);
              store.markDirty();
              state.frame = i;
              drawStrip();
              ok(`只保留第 ${i + 1} 帧`);
            }
          }
        ]);
      });
      stripEl.appendChild(cell);
    }
    drawPreview();
  }

  void close;
}

/**
 * 重排帧序。
 * 浏览器里没有"重命名文件"的能力，所以用 frameDurations 之外的一张映射表实现自定义顺序：
 * 这里把顺序写进 props 式的数组 —— 保持与桌面版一致的语义（帧下标序列）。
 */
function reorderFrames(asset: AssetEntry, order: number[]): void {
  (asset as AssetEntry & { frameOrder?: number[] }).frameOrder = order;
  // 同步隐藏帧：不在顺序表里的帧视为隐藏，保证播放与编辑器一致
  const all = Array.from({ length: totalFrames(asset) }, (_, i) => i);
  const keep = new Set(order);
  asset.hiddenFrames = all.filter((i) => !keep.has(i));
  store.markDirty();
}

async function checkIntegrity(): Promise<void> {
  if (!store.project) {
    error("没有打开的工程");
    return;
  }
  const { ok: okAssets, missing: missingAssets } = await checkAssetHealth(store.project.assets);
  if (missingAssets.length === 0) {
    ok(`全部 ${store.project.assets.length} 个素材都正常`);
    return;
  }

  modal({
    title: `发现 ${missingAssets.length} 个缺失素材`,
    wide: true,
    body: () => {
      const box = el("div", { class: "col" });
      box.style.gap = "8px";
      box.appendChild(
        el("div", { class: "hint" }, `下面这些素材加载失败，引用它们的对象会显示成占位方块。`)
      );
      const list = el("div", { class: "item-list" });
      for (const a of missingAssets) {
        const item = el("div", { class: "item" });
        const grow = el("div", { class: "grow" });
        grow.appendChild(el("div", { class: "name" }, a.name));
        grow.appendChild(el("div", { class: "sub" }, `${assetKindShort(a.kind)} · ${a.width}×${a.height}px`));
        const used = (store.scene?.objects ?? []).filter((o) => o.assetId === a.id).length;
        if (used) {
          grow.appendChild(el("div", { class: "sub", style: { color: "var(--warn)" } }, `被 ${used} 个对象引用`));
        }
        item.appendChild(grow);
        item.appendChild(
          button("重新导入", () => {
            const picker = document.createElement("input");
            picker.type = "file";
            picker.accept = "image/*,audio/*";
            picker.addEventListener("change", async () => {
              const f = picker.files?.[0];
              if (!f) return;
              const res = await importFiles(store.project!, [f], a.group);
              if (res.added > 0) {
                ok(`已重新导入「${f.name}」，请在对象面板里把引用指向新素材`);
                refreshAllPanels();
              }
            });
            picker.click();
          }, { size: "sm", variant: "primary" })
        );
        list.appendChild(item);
      }
      box.appendChild(list);
      return box;
    },
    actions: [{ label: "关闭", variant: "primary", onClick: (c) => c() }]
  });
}

export function assetCountText(): string {
  const n = store.assets.length;
  if (!n) return "素材库为空";
  const seq = store.assets.filter((a) => a.kind === "SEQUENCE").length;
  const atlas = store.assets.filter((a) => a.kind === "ATLAS").length;
  const audio = store.assets.filter((a) => a.kind === "AUDIO").length;
  return `${n} 个素材${seq ? ` · 序列帧 ${seq}` : ""}${atlas ? ` · 图集 ${atlas}` : ""}${audio ? ` · 音频 ${audio}` : ""}`;
}

export function selectedAsset(): string {
  return selectedAssetId;
}

void iconButton;
void numText;
