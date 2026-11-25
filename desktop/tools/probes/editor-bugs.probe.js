/**
 * 探针：编辑器 4 个用户可感知 bug 的真机回归（在渲染进程里跑，只收集数据不判定）。
 *
 * 单独成文件（而不是内嵌进模板字符串）是仓库里已经吃过亏的结论，见
 * `verify-js-editor-ui.mjs` 文件头：内嵌时注释里的反引号会截断脚本、正则转义会被
 * 模板吃掉、`\n` 会变成真实换行 —— 三类都是"不报错但结果错"。独立文件零转义，
 * 也能先 `node --check` 拦住语法错。
 *
 * 由 `desktop/tools/verify-editor-bugs.mjs` 调用：
 *   electron desktop/main.mjs --e2e-script=<本文件> --e2e-out=<json> --e2e-shot=<png>
 *
 * ## 纪律（这几条是这份探针能长期用的前提）
 *
 * 1. **不猜时序**：等异步落地一律用 `waitFor`（轮询到条件成立）/ `waitStable`
 *    （轮询到数值不再变化）。超时会记进 `out.timeouts` 并被验收脚本判为失败 ——
 *    静默等待等于把偶发漏测变成"看起来绿"。
 * 2. **不靠易碎选择器**：拖放宿主按 `.asset-grid` → 祖辈定位（监听挂在 Tabbed 的
 *    常驻 host 上）；对象/相机/缩放一律读 `store` 与 `editor.canvas` 的数值。
 * 3. **颜色判据只有一份**：`COLOR_SPEC` 由验收脚本注入，同一份规则既用于画布像素
 *    取样（本文件）也用于 PNG 截图取样（验收脚本）。写两遍必然漂移。
 * 4. **不落盘**：全程只动内存里的 store —— 不按 Ctrl+S、不触发保存，
 *    不会把 `web/examples/*.bwproj` 写脏。
 *
 * 返回的 JSON 交给验收脚本断言，本文件不自己判 pass/fail。
 */
(async () => {
  const W = window;
  const B = W.__BWE__ || {};
  const store = B.store;
  const editor = B.editor;
  const out = {
    ok: false,
    errors: [],
    timeouts: [],
    steps: [],
    boot: {},
    drops: { panelRounds: [], sameGroupRepeats: [], singleImageRepeats: [], canvasRounds: [] },
    collider: {},
    viewport: {},
    focus: {},
    scriptParams: {}
  };

  // ---------------- 颜色判据（规则由验收脚本注入） ----------------
  //
  // 为什么不是"某个 rgb 三元组 ± 距离"：两条虚线都是**半透明描边**，
  // 落屏颜色 = 前景 × alpha + 底色 × (1-alpha)，会随主题整体偏移
  // （奶油底 / 深夜底 / 高对比）。按"通道之间的关系"判据才对主题稳定：
  //   青色  恒有 b、g 远高于 r，且 g 接近 b；
  //   黄色  恒有 r 远高于 b，且 g 明显高于 b。
  // 写死三元组会在换主题那天变成假红/假绿。
  const SPEC = typeof COLOR_SPEC !== "undefined" && COLOR_SPEC
    ? COLOR_SPEC
    : {
        cyan: { b: [">=", 150], "g-r": [">=", 55], "g-b": [">=", -70] },
        yellow: { r: [">=", 170], "r-b": [">=", 90], "g-b": [">=", 40] }
      };
  out.colorSpec = SPEC;
  const OPS = {
    ">=": (a, b) => a >= b,
    "<=": (a, b) => a <= b,
    ">": (a, b) => a > b,
    "<": (a, b) => a < b
  };
  const channels = (r, g, b) => ({ r: r, g: g, b: b, "g-r": g - r, "b-r": b - r, "g-b": g - b, "r-b": r - b });
  function matcher(name) {
    const rule = SPEC[name] || {};
    const keys = Object.keys(rule);
    return (r, g, b) => {
      const d = channels(r, g, b);
      for (const k of keys) {
        const pair = rule[k];
        if (!OPS[pair[0]](d[k], pair[1])) return false;
      }
      return true;
    };
  }
  const isCyan = matcher("cyan");
  const isYellow = matcher("yellow");

  // ---------------- 错误收集（任何一条都算失败项） ----------------
  W.addEventListener("error", (e) => out.errors.push("error: " + String((e && e.message) || e)));
  W.addEventListener("unhandledrejection", (e) => {
    const r = e && e.reason;
    out.errors.push("unhandledrejection: " + String((r && r.message) || r).slice(0, 300));
  });
  const origConsoleError = console.error;
  console.error = function () {
    const parts = Array.prototype.map.call(arguments, String).join(" ");
    out.errors.push("console.error: " + parts.slice(0, 300));
    return origConsoleError.apply(console, arguments);
  };

  // ---------------- 轮询原语 ----------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const frames = async (n) => {
    for (let i = 0; i < (n || 2); i++) await raf();
  };
  async function waitFor(fn, label, timeoutMs) {
    const t0 = performance.now();
    const limit = timeoutMs || 10000;
    while (performance.now() - t0 < limit) {
      let v = null;
      try {
        v = fn();
      } catch {
        v = null;
      }
      if (v) return v;
      await sleep(40);
    }
    out.timeouts.push(label);
    return null;
  }
  async function waitStable(get, quietMs, timeoutMs) {
    const t0 = performance.now();
    const limit = timeoutMs || 12000;
    const quiet = quietMs || 200;
    let last = get();
    let lastChange = performance.now();
    while (performance.now() - t0 < limit) {
      await sleep(40);
      const v = get();
      if (v !== last) {
        last = v;
        lastChange = performance.now();
      } else if (performance.now() - lastChange >= quiet) {
        return v;
      }
    }
    return get();
  }

  if (!store || !editor || !editor.canvas) {
    out.errors.push("window.__BWE__ 不完整（store / editor / editor.canvas 缺失），无法执行探针");
    return out;
  }
  const view = editor.canvas;
  const canvasEl = view.root.querySelector("canvas");

  // ---------------- 0. 换成确定性的空工程 ----------------
  await waitFor(() => store.project && store.scene, "project-ready", 20000);
  if (!store.project || !store.scene) {
    out.errors.push("编辑器没进入可用状态（store.project / store.scene 为空）");
    return out;
  }
  // 首次开屏的引导条会盖在画布右下角，先关掉（它是 DOM 浮层，会影响截图的像素判据）
  const qsClose = document.querySelector("[data-quickstart-close]");
  if (qsClose) qsClose.click();

  if (!document.querySelector(".sidebar-body .asset-grid")) {
    const act = document.querySelector('[data-activity="explorer"]');
    if (act) act.click();
    await waitFor(() => document.querySelector(".sidebar-body .asset-grid"), "asset-panel-visible", 8000);
  }

  /**
   * 基底工程是**当前工程的深拷贝**（已经过 normalizeProject），
   * 只把素材/预制体/脚本/对象清空 —— 这样不用猜字段，又保证每次运行
   * 都在同一张 60×40 格空地图上，上一次运行的残留不会污染计数。
   */
  const base = JSON.parse(JSON.stringify(store.project));
  base.name = "编辑器 bug 验收";
  base.assets = [];
  base.prefabs = [];
  base.scripts = {};
  const firstScene = JSON.parse(JSON.stringify(base.scenes[0]));
  firstScene.objects = [];
  firstScene.name = "验收场景";
  base.scenes = [firstScene];
  editor.setProject(base);
  await waitFor(() => store.project && store.project.name === "编辑器 bug 验收", "set-project", 10000);
  await waitStable(() => store.assets.length, 120);
  await frames(2);

  const mapW = store.scene.widthTiles * (store.project.tileSize || 32);
  const mapH = store.scene.heightTiles * (store.project.tileSize || 32);
  const canvasBox0 = canvasEl.getBoundingClientRect();
  out.boot = {
    theme: document.documentElement.className || "",
    dpr: W.devicePixelRatio || 1,
    canvas: {
      left: Math.round(canvasBox0.left),
      top: Math.round(canvasBox0.top),
      w: Math.round(canvasBox0.width),
      h: Math.round(canvasBox0.height),
      backW: canvasEl.width,
      backH: canvasEl.height
    },
    map: { w: mapW, h: mapH, tiles: store.scene.widthTiles + "x" + store.scene.heightTiles },
    showViewportDefault: store.showViewport === true
  };
  if (!canvasEl || canvasBox0.width < 200 || canvasBox0.height < 150) {
    out.errors.push("画布尺寸异常（" + Math.round(canvasBox0.width) + "×" + Math.round(canvasBox0.height) + "），后续取样不可信");
    return out;
  }

  // ---------------- 1. 拖放：一次 drop 只能被处理一次 ----------------
  //
  // 用户报：「拖入一组素材会变成三组；物体拖入会指数级被复制」。
  // 根因：`renderAssetPanel` 每次重画都往**常驻**的 Tabbed host 上再挂一份
  // drop/dragover 监听（host 不随 replaceChildren 销毁），监听器只增不减 →
  // 一次 drop 被 N 个处理器各处理一次；而每次导入又触发一次刷新 → N 再变大，
  // 这就是"越拖越多、指数级"的来源（现场实测 3 → 7 → 16）。
  //
  // 量化手法：每轮用**不同的文件名前缀**。`importSequenceSet` 的判重键是
  // 「名字前缀 + 目录」，不同前缀就不会被判重挡住，于是这一轮的增量
  // **只反映"这次 drop 被处理了几次"**。若监听器仍在累积，第 r 轮增量会是 r+1。
  // （复用同一组文件名会让判重挡掉第 2..N 次处理，反而把监听器累积掩盖掉。）
  const PNG_HEAD = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const makeFile = (name) => new File([PNG_HEAD], name, { type: "image/png" });
  function makeDT(files, extra) {
    const dt = new DataTransfer();
    for (const f of (files || [])) dt.items.add(f);
    if (extra) for (const k of Object.keys(extra)) dt.setData(k, extra[k]);
    return dt;
  }
  /** 素材面板的拖放宿主：`.asset-grid` → wrap → Tabbed host（监听就挂在这一层）。 */
  function assetGrid() {
    return document.querySelector(".sidebar-body .asset-grid");
  }
  function dispatchDrop(target, dt) {
    const r = target.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
      clientX: Math.round(r.left + Math.max(4, Math.min(r.width / 2, 40))),
      clientY: Math.round(r.top + Math.max(4, Math.min(r.height / 2, 40)))
    };
    target.dispatchEvent(new DragEvent("dragover", init));
    target.dispatchEvent(new DragEvent("drop", init));
  }
  async function measureDrop(metric, dispatch, label) {
    const before = metric();
    dispatch();
    const after = await waitStable(metric, 220, 15000);
    return { before: before, after: after, added: after - before, label: label };
  }
  /** 模拟"面板被重画"：旧实现正是每次重画多挂一份监听。 */
  async function repaintPanels() {
    W.dispatchEvent(new CustomEvent("bwe:refresh"));
    await frames(2);
    await waitStable(() => store.assets.length, 80);
  }

  out.drops.hostFound = Boolean(assetGrid());
  if (!out.drops.hostFound) out.errors.push("找不到素材面板的拖放宿主（.sidebar-body .asset-grid 不存在）");

  // 1a. 第 r 轮：一次 drop（2 个文件）→ 只应新增 1 条素材（合成一组序列帧）
  for (let round = 0; round < 4; round++) {
    const row = await measureDrop(
      () => store.assets.length,
      () => {
        const t = assetGrid();
        if (t) dispatchDrop(t, makeDT([makeFile("待机R" + round + "_1.png"), makeFile("待机R" + round + "_2.png")]));
      },
      "panel-round-" + round
    );
    row.round = round;
    row.assetsAfter = store.assets.length;
    out.drops.panelRounds.push(row);
    await repaintPanels();
  }

  // 1b. 同一组素材重复拖入 → 判重跳过（用户原话「拖一次变三组」的正面场景）
  for (let round = 0; round < 3; round++) {
    const row = await measureDrop(
      () => store.assets.length,
      () => {
        const t = assetGrid();
        if (t) dispatchDrop(t, makeDT([makeFile("待机R0_1.png"), makeFile("待机R0_2.png")]));
      },
      "same-group-" + round
    );
    row.round = round;
    out.drops.sameGroupRepeats.push(row);
    await repaintPanels();
  }

  // 1c. 单张图重复拖入 → 同样跳过（走 importFiles 分支，判重键是 文件名 + kind）
  for (let round = 0; round < 2; round++) {
    const row = await measureDrop(
      () => store.assets.length,
      () => {
        const t = assetGrid();
        if (t) dispatchDrop(t, makeDT([makeFile("x1.png")]));
      },
      "single-image-" + round
    );
    row.round = round;
    out.drops.singleImageRepeats.push(row);
    await repaintPanels();
  }

  // 1d. 素材拖到画布：一次 drop 只应新建**一个**对象（"物体指数级复制"）
  const single = store.assets.filter((a) => a.path === "x1.png")[0] || store.assets[0];
  if (!single) {
    out.errors.push("素材库为空，无法验证「物体拖入」");
  } else {
    out.drops.canvasAsset = { id: single.id, name: single.name, kind: single.kind };
    for (let round = 0; round < 4; round++) {
      const row = await measureDrop(
        () => store.scene.objects.length,
        () => dispatchDrop(canvasEl, makeDT([], { "application/x-bwe-asset": single.id, "text/plain": single.id })),
        "canvas-drop-" + round
      );
      row.round = round;
      out.drops.canvasRounds.push(row);
      await repaintPanels();
    }
  }

  // ---------------- 2. 黄色虚线（碰撞体框）必须围住选中对象 ----------------
  //
  // 旧实现画的是 `toScreen(-halfW,-halfH)` → `toScreen(halfW,halfH)`：
  // 那个矩形以**世界原点**为中心，完全丢掉了对象自己的 (x, y)，
  // 于是不管选谁，黄色虚线都贴在地图左上角 —— 用户说的「虚线出现在错误的位置」。
  //
  // 判据：把对象放在远离原点的已知坐标，全图可见（zoomToFit）时取样：
  //   a) 黄色包围盒 ≈ worldToScreen(对象矩形)
  //   b) "旧 bug 会画的矩形"（以原点为中心的同尺寸方块）里黄色像素 = 0
  // b) 是**反向判据**：只断言"框在对象那儿"会让"两处都画"的实现蒙过去。
  const scene = store.scene;
  scene.objects = [];
  const layerId = scene.layers[1] ? scene.layers[1].id : scene.layers[0].id;
  const OBJ = {
    id: "verify-collider-obj",
    name: "验收物件",
    kind: "PROP",
    x: 1200,
    y: 800,
    z: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    halfW: 90,
    halfH: 60,
    layerId: layerId,
    visible: true,
    locked: false,
    assetId: "",
    animMode: "默认",
    animFps: 8,
    modules: [],
    props: {},
    tags: [],
    parentId: null
  };
  scene.objects.push(OBJ);
  store.select(null);
  store.select(OBJ);
  view.zoomToFit();
  view.requestPaint();
  await frames(3);

  /**
   * 读画布像素。用画布自己的 `getImageData` 而不是截图：同一帧、无合成延迟、
   * 不受窗口遮挡影响。本探针用的对象都没有可用位图（占位块绘制），画布未被污染；
   * 万一将来被污染，`getImageData` 会抛 SecurityError，这里把它记进 JSON，
   * 由验收脚本回落到 PNG 截图取样。
   */
  const ctx2d = canvasEl.getContext("2d");
  const dpr = canvasEl.width / Math.max(1, canvasEl.clientWidth);
  function sampleCanvas(match) {
    if (!ctx2d) return { error: "没有 2d 上下文" };
    const w = canvasEl.width;
    const h = canvasEl.height;
    let data;
    try {
      data = ctx2d.getImageData(0, 0, w, h).data;
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    const colHist = new Int32Array(w);
    const rowHist = new Int32Array(h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (!match(data[i], data[i + 1], data[i + 2])) continue;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        colHist[x]++;
        rowHist[y]++;
      }
    }
    if (!count) return { count: 0, bbox: null };
    // 边缘覆盖率：在期望线的 ±1.5 CSS px 内，命中像素 / 该边长度的比例。
    //
    // ⚠ 这个比例**不能用来判"边有没有画"**：碰撞体框是 setLineDash([3,3]) +
    //   lineWidth 1.2 + strokeRect(x+0.5)，1px 采样带里只有实线段中心的像素能达到
    //   颜色阈值，虚线本身一半是空隙，抗锯齿还会把边缘线稀释掉 —— 实测稳定在 24%
    //   左右（不是 bug，是渲染方式的必然结果）。所以它只作为参考值输出，
    //   真正的断言用下面的 edgeSegments()「数线段」。
    function coverageAt(hist, at, span) {
      let hit = 0;
      const lo = Math.max(0, Math.floor((at - 1.5) * dpr));
      const hi = Math.min(hist.length - 1, Math.ceil((at + 1.5) * dpr));
      for (let i = lo; i <= hi; i++) hit += hist[i];
      return span > 0 ? Math.min(1, hit / (span * dpr)) : 0;
    }

    /**
     * 某条边上「有几段连续的实线」—— 对虚线稳健的判据。
     *
     * 做法：沿这条边扫一遍，在 ±band CSS px 的窄带里问"这一行(列)有没有命中"，
     * 统计 true 的连续段数。虚线 n 段 ⇒ 这里数出约 n 段；真的没画 ⇒ 0 段。
     * 它对 dash 比例、抗锯齿、线宽都不敏感，只关心"这条边上有断续的笔画"。
     */
    function edgeSegments(side, r, band) {
      const bw = band || 2;
      const vertical = side === "left" || side === "right";
      let runs = 0;
      let on = false;
      let hitRows = 0;
      let rows = 0;
      if (vertical) {
        const xc = side === "left" ? r.x : r.x2;
        const x0 = Math.max(0, Math.floor((xc - bw) * dpr));
        const x1 = Math.min(w - 1, Math.ceil((xc + bw) * dpr));
        const y0 = Math.max(0, Math.floor(r.y * dpr));
        const y1 = Math.min(h - 1, Math.ceil(r.y2 * dpr));
        for (let y = y0; y <= y1; y++) {
          let hit = false;
          for (let x = x0; x <= x1 && !hit; x++) {
            const i = (y * w + x) * 4;
            if (match(data[i], data[i + 1], data[i + 2])) hit = true;
          }
          rows++;
          if (hit) {
            hitRows++;
            if (!on) {
              runs++;
              on = true;
            }
          } else {
            on = false;
          }
        }
      } else {
        const yc = side === "top" ? r.y : r.y2;
        const y0 = Math.max(0, Math.floor((yc - bw) * dpr));
        const y1 = Math.min(h - 1, Math.ceil((yc + bw) * dpr));
        const x0 = Math.max(0, Math.floor(r.x * dpr));
        const x1 = Math.min(w - 1, Math.ceil(r.x2 * dpr));
        for (let x = x0; x <= x1; x++) {
          let hit = false;
          for (let y = y0; y <= y1 && !hit; y++) {
            const i = (y * w + x) * 4;
            if (match(data[i], data[i + 1], data[i + 2])) hit = true;
          }
          rows++;
          if (hit) {
            hitRows++;
            if (!on) {
              runs++;
              on = true;
            }
          } else {
            on = false;
          }
        }
      }
      return { runs: runs, coverage: rows ? hitRows / rows : 0 };
    }
    return {
      count: count,
      bbox: { x: minX / dpr, y: minY / dpr, x2: maxX / dpr, y2: maxY / dpr, w: (maxX - minX) / dpr, h: (maxY - minY) / dpr },
      colHist: colHist,
      rowHist: rowHist,
      coverageAt: coverageAt,
      edgeSegments: edgeSegments,
      /** 某个矩形（画布 CSS px）里的命中像素数 —— 反向判据用 */
      countIn: function (r) {
        let n = 0;
        const x0 = Math.max(0, Math.floor(r.x * dpr));
        const x1 = Math.min(w - 1, Math.ceil((r.x + r.w) * dpr));
        const y0 = Math.max(0, Math.floor(r.y * dpr));
        const y1 = Math.min(h - 1, Math.ceil((r.y + r.h) * dpr));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) if (match(data[(y * w + x) * 4], data[(y * w + x) * 4 + 1], data[(y * w + x) * 4 + 2])) n++;
        }
        return n;
      }
    };
  }
  /** 世界矩形 → 画布局部 CSS 矩形（与 `worldToScreen` 同一公式）。 */
  function screenRect(x, y, w, h) {
    const a = view.worldToScreen(x, y);
    const b = view.worldToScreen(x + w, y + h);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, x2: b.x, y2: b.y };
  }

  const objWorld = { x: OBJ.x - OBJ.halfW, y: OBJ.y - OBJ.halfH, w: OBJ.halfW * 2, h: OBJ.halfH * 2 };
  const objScreen = screenRect(objWorld.x, objWorld.y, objWorld.w, objWorld.h);
  const originBugScreen = screenRect(-OBJ.halfW, -OBJ.halfH, OBJ.halfW * 2, OBJ.halfH * 2);

  const ySample = sampleCanvas(isYellow);
  out.collider = {
    object: { x: OBJ.x, y: OBJ.y, halfW: OBJ.halfW, halfH: OBJ.halfH },
    zoom: view.getZoom(),
    cam: { x: view.camX, y: view.camY },
    expected: objScreen,
    originBugRect: originBugScreen
  };
  if (ySample.error) {
    out.collider.sampleError = ySample.error;
  } else if (!ySample.count) {
    out.collider.sample = { count: 0 };
  } else {
    const bb = ySample.bbox;
    out.collider.sample = { count: ySample.count, bbox: bb };
    // 覆盖率只作参考（虚线 + 抗锯齿让它天生 ~24%），断言用下面的段数。
    out.collider.coverage = {
      left: ySample.coverageAt(ySample.colHist, objScreen.x, objScreen.h),
      right: ySample.coverageAt(ySample.colHist, objScreen.x2, objScreen.h),
      top: ySample.coverageAt(ySample.rowHist, objScreen.y, objScreen.w),
      bottom: ySample.coverageAt(ySample.rowHist, objScreen.y2, objScreen.w)
    };
    // 每条边上有几段连续实线：虚线 [3,3] ⇒ 每边约 8~10 段；没画 ⇒ 0 段。
    // 这是"边真的画了"的判据，对 dash 空隙比例与抗锯齿都稳健。
    out.collider.edges = {
      left: ySample.edgeSegments("left", objScreen),
      right: ySample.edgeSegments("right", objScreen),
      top: ySample.edgeSegments("top", objScreen),
      bottom: ySample.edgeSegments("bottom", objScreen)
    };
    out.collider.bboxDelta = {
      left: bb.x - objScreen.x,
      right: bb.x2 - objScreen.x2,
      top: bb.y - objScreen.y,
      bottom: bb.y2 - objScreen.y2
    };
    out.collider.center = {
      sampled: { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 },
      object: { x: objScreen.x + objScreen.w / 2, y: objScreen.y + objScreen.h / 2 },
      originBug: { x: originBugScreen.x + originBugScreen.w / 2, y: originBugScreen.y + originBugScreen.h / 2 }
    };
    // 反向判据：旧 bug 的矩形区域里不该有黄色像素
    out.collider.yellowInOriginBugRect = ySample.countIn(originBugScreen);
    out.collider.yellowInObjectRect = ySample.countIn(objScreen);
  }

  // ---------------- 3. 运行时视口取景框（1280×720） ----------------
  //
  // 用户报：「视口（运行时窗口 1280×720 那块范围）没有显示在编辑器画布里」。
  // 修好后画布上有一块青色虚线取景框 + 四角短脚 + 一行标签，由 `store.showViewport`
  // 控制（默认 true）；几何见 `runtimeViewRect()`（1:1 世界单位，选中一个对象时框住它）。
  //
  // 这里的机位是**显式指定**的（zoom=0.4 且相机对准对象），不是 zoomToFit：
  // 全图机位下 1280 宽的取景框会超出画布左右边界，取样必然被裁，断言就不可信。
  const RVW = 1280;
  const RVH = 720;
  view.setZoom(0.4);
  view.centerOn(OBJ.x, OBJ.y);
  store.select(OBJ);
  view.requestPaint();
  await frames(3);

  const vpWorld = { x: OBJ.x - RVW / 2, y: OBJ.y - RVH / 2, w: RVW, h: RVH };
  const vpScreen = screenRect(vpWorld.x, vpWorld.y, vpWorld.w, vpWorld.h);
  const cSampleOn = sampleCanvas(isCyan);
  out.viewport = {
    showViewport: store.showViewport === true,
    zoom: view.getZoom(),
    cam: { x: view.camX, y: view.camY },
    expected: vpScreen,
    canvas: { w: canvasEl.clientWidth, h: canvasEl.clientHeight }
  };
  if (cSampleOn.error) {
    out.viewport.sampleError = cSampleOn.error;
  } else if (!cSampleOn.count) {
    out.viewport.on = { count: 0 };
  } else {
    const bb = cSampleOn.bbox;
    out.viewport.on = { count: cSampleOn.count, bbox: bb };
    out.viewport.coverage = {
      left: cSampleOn.coverageAt(cSampleOn.colHist, vpScreen.x, vpScreen.h),
      right: cSampleOn.coverageAt(cSampleOn.colHist, vpScreen.x2, vpScreen.h),
      top: cSampleOn.coverageAt(cSampleOn.rowHist, vpScreen.y, vpScreen.w),
      bottom: cSampleOn.coverageAt(cSampleOn.rowHist, vpScreen.y2, vpScreen.w)
    };
    out.viewport.edges = {
      left: cSampleOn.edgeSegments("left", vpScreen),
      right: cSampleOn.edgeSegments("right", vpScreen),
      top: cSampleOn.edgeSegments("top", vpScreen),
      bottom: cSampleOn.edgeSegments("bottom", vpScreen)
    };
    out.viewport.bboxDelta = {
      left: bb.x - vpScreen.x,
      right: bb.x2 - vpScreen.x2,
      bottom: bb.y2 - vpScreen.y2,
      // 标签画在框线上方（a.y - 6），所以 bbox 顶边会**高于**期望线，属预期
      top: bb.y - vpScreen.y
    };
    // 标签真的画了吗：框线**上方**那一条带里必须有青色像素（画布上的字读不了 DOM）
    let labelPixels = 0;
    const topPx = Math.max(0, Math.floor((vpScreen.y - 2) * dpr));
    for (let y = 0; y < Math.min(cSampleOn.rowHist.length, topPx); y++) labelPixels += cSampleOn.rowHist[y];
    out.viewport.labelPixelsAboveTopEdge = labelPixels;
  }
  // 关掉开关必须一个青色像素都不剩 —— 证明取样命中的确实是这个图层，而不是别的青色
  store.showViewport = false;
  view.requestPaint();
  await frames(3);
  const cSampleOff = sampleCanvas(isCyan);
  out.viewport.off = cSampleOff.error ? { error: cSampleOff.error } : { count: cSampleOff.count, bbox: cSampleOff.bbox };
  store.showViewport = true;
  view.requestPaint();
  await frames(3);

  // ---------------- 4. 聚焦：F / 双击把选中对象放进视野中心 ----------------
  //
  // 旧行为：F 永远 `zoomToFit()` —— 选中的小物件反而"越按越看不见"，
  // 用户原话「点击物体不能切换到聚焦，太难受了」。修好后：
  //   有选中 → `focusSelection()`（框住选中对象）；无选中 → `zoomToFit()`；
  //   画布上双击对象 → 同一套 `focusSelection()`（两条路径必须一致）。
  const cw = canvasEl.clientWidth;
  const chh = canvasEl.clientHeight;
  view.zoomToFit();
  store.select(null);
  await frames(3);
  const fitNoSel = { zoom: view.getZoom(), camX: view.camX, camY: view.camY };

  // 4a. 没选中时按 F = 缩放到整张地图（保留旧肌肉记忆）
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", bubbles: true, cancelable: true }));
  await frames(3);
  const fNoSel = { zoom: view.getZoom(), camX: view.camX, camY: view.camY };

  // 4b. 选中后按 F = 聚焦选中对象
  store.select(OBJ);
  await frames(2);
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", bubbles: true, cancelable: true }));
  await frames(3);
  const fSel = { zoom: view.getZoom(), camX: view.camX, camY: view.camY };
  // focusRect 的公式：zoom = clamp(min(cw*0.8/w, ch*0.8/h), 0.15, 1)，相机中心 = 对象中心
  const expectFocusZoom = Math.min(1, Math.max(0.15, Math.min((cw * 0.8) / (OBJ.halfW * 2), (chh * 0.8) / (OBJ.halfH * 2))));

  // 4c. 画布上双击对象 = 同一套聚焦
  view.zoomToFit();
  store.select(null);
  await frames(3);
  const fitBeforeDbl = { zoom: view.getZoom(), camX: view.camX, camY: view.camY };
  const local = view.worldToScreen(OBJ.x, OBJ.y);
  const cr = canvasEl.getBoundingClientRect();
  canvasEl.dispatchEvent(
    new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: Math.round(cr.left + local.x),
      clientY: Math.round(cr.top + local.y)
    })
  );
  await frames(4);
  const dbl = {
    zoom: view.getZoom(),
    camX: view.camX,
    camY: view.camY,
    selectedSingle: store.selection.length === 1 && store.selection[0] === OBJ
  };

  out.focus = {
    object: { x: OBJ.x, y: OBJ.y, halfW: OBJ.halfW, halfH: OBJ.halfH },
    canvas: { w: cw, h: chh },
    fitNoSel: fitNoSel,
    fNoSel: fNoSel,
    fSel: fSel,
    fitBeforeDbl: fitBeforeDbl,
    dbl: dbl,
    expectFocusZoom: expectFocusZoom,
    expectCam: { x: OBJ.x, y: OBJ.y },
    zoomToFitCenter: { x: mapW / 2, y: mapH / 2 }
  };

  // ---------------- 5. 公开字段（骨架，只记录不判定） ----------------
  //
  // 这一条由另一条实现线负责。本脚本**不做断言**，只记录"面板上有没有那块 UI"，
  // 方便那边落地后直接把 `skipped` 改成断言。
  out.scriptParams = {
    skipped: true,
    note: "公开字段由另一条实现线负责；本脚本只留骨架，不参与 pass/fail",
    inspectorHasParamsAnchor: Boolean(
      document.querySelector("[data-script-params], [data-params-card], .script-params-card, [data-script-param]")
    ),
    bweParamsInEditor: typeof (W.bwe && W.bwe.params) === "function"
  };

  // ---------------- 6. 收尾：留下可判读的截图状态 ----------------
  // `--e2e-shot` 在脚本返回后 400ms 拍。所以最后一步必须稳定：
  //   zoom=0.4 + 相机对准对象 → 青色视口框与黄色碰撞体框**同时**完整可见且居中。
  document.querySelectorAll(".toast-host .toast").forEach((t) => t.remove());
  store.showViewport = true;
  view.setZoom(0.4);
  view.centerOn(OBJ.x, OBJ.y);
  store.select(OBJ);
  view.requestPaint();
  await frames(5);

  const crFinal = canvasEl.getBoundingClientRect();
  /**
   * 画布上那两个 DOM 浮层（.canvas-hud.tl 坐标 / .canvas-hud.tr 缩放）的矩形。
   *
   * 为什么要把它们报出去：它们**不是画布像素**，但会出现在截图上，而且是
   * 暖色文字 + 半透明底 —— 刚好能命中"黄色"判据（实测 223,166,64）。
   * 不把它们从取样区里挖掉，截图里黄色包围盒的中心就会被拉偏两百多像素，
   * 断言会以"位置不对"的形式假红（产品其实是对的）。
   */
  function hudRects() {
    const list = [];
    document.querySelectorAll(".canvas-hud").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      list.push({
        cls: el.className,
        x: Math.round(r.left - crFinal.left),
        y: Math.round(r.top - crFinal.top),
        w: Math.round(r.width),
        h: Math.round(r.height)
      });
    });
    return list;
  }
  out.shot = {
    canvas: {
      left: Math.round(crFinal.left),
      top: Math.round(crFinal.top),
      w: Math.round(crFinal.width),
      h: Math.round(crFinal.height)
    },
    zoom: view.getZoom(),
    cam: { x: view.camX, y: view.camY },
    // 期望矩形一律给**画布局部**坐标；验收脚本加上 canvas.left/top 得到 PNG 坐标
    expectedViewport: screenRect(vpWorld.x, vpWorld.y, vpWorld.w, vpWorld.h),
    expectedCollider: screenRect(objWorld.x, objWorld.y, objWorld.w, objWorld.h),
    // 反向判据的参照矩形：旧 bug 会画出的"以世界原点为中心"的碰撞体框
    originBugRect: screenRect(-OBJ.halfW, -OBJ.halfH, OBJ.halfW * 2, OBJ.halfH * 2),
    objectWorldRect: objWorld,
    objectCenter: view.worldToScreen(OBJ.x, OBJ.y),
    // 截图取样要排除的 DOM 浮层（画布局部坐标）
    hudRects: hudRects(),
    showViewport: store.showViewport === true,
    objects: store.scene.objects.length,
    assets: store.assets.length,
    selection: store.selection.length
  };

  /**
   * 把 dirty 抹掉再退出。
   *
   * 探针必然会 markDirty（导入素材、拖放落物都是真实的编辑动作），而
   * `startAutoSave()` 每 30 秒会把 dirty 的工程写进 IndexedDB。正常情况下
   * 我们用的是 `--user-data` 的隔离目录，自动保存落在隔离库里、不碰仓库；
   * 但这条线是**双保险**：万一将来有人用真实 userData 跑这个探针
   * （比如想看自己工程的效果），至少不会把"验收跑到一半的半成品"推进本地库，
   * 更不会污染 `web/examples/*.bwproj`（那份文件有 5000 行 churn 史）。
   */
  try {
    store.dirty = false;
  } catch (e) {
    out.errors.push("清 dirty 失败：" + String((e && e.message) || e));
  }

  out.steps.push({
    name: "summary",
    assets: store.assets.length,
    objects: store.scene.objects.length,
    // 每一轮的增量单独看：任何一个 >1 都说明"一次拖放被处理了多次"
    panelAdded: out.drops.panelRounds.map((r) => r.added),
    canvasAdded: out.drops.canvasRounds.map((r) => r.added)
  });
  out.ok = out.errors.length === 0 && out.timeouts.length === 0;
  return out;
})()
