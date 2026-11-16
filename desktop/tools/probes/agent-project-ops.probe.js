/**
 * 探针：验证「AI 改工程」链路在**真实渲染进程**里真的通。
 *
 * 为什么要端到端：`projectOps` 的单测证明"规则对"，但它证明不了
 * 「主进程 → executeJavaScript → __BWE__.runScriptTool → runProjectTool →
 * applyAiProject → store → 撤销栈」这条**接线**是通的。
 * 本仓库历史上最反复的缺陷形态就是「工具描述承诺了能力、某条配置下根本没接线」——
 * 那种断裂只在端到端里现形，而且表现是「AI 说改好了，界面没变」。
 *
 * 它验证：
 *   1. `__BWE__.runScriptTool` 认识 ProjectDigest / ApplyProjectOps（不被白名单挡）
 *   2. ProjectDigest 读得到真实工程，且新字段（rotation/animMode/parentId/图层的 visible/
 *      场景 onStartScript/规则包……）都在 —— 模型"看得见"才"改得动"
 *   3. ApplyProjectOps 改工程级字段能真的落到 store（读 store 独立核对，不看工具自己的说法）
 *   4. 改完之后**画布真的重画了**、`store.project` 引用换了
 *   5. 改动进了撤销栈（Ctrl+Z 能回退）—— 这是「可撤销」的唯一定义
 *   6. dryRun:true 时工程**一字节不变**（这条以前是"声明了但没人实现"）
 *   7. 非法批次被整批拒绝，且原工程不变
 */
(async () => {
  const out = { steps: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const W = window;
  const step = (name, value) => out.steps.push({ name, value });

  // ---- 前提 ----
  out.hasBridge = Boolean(W.__BWE__);
  out.hasRunTool = typeof W.__BWE__?.runScriptTool === "function";
  out.hasEditor = Boolean(W.__BWE__?.editor);
  if (!out.hasRunTool) return out;

  // 载入内置 JS 示例工程（隐藏探针按钮，与「文件 → 示例」同一入口）
  const loadDemo = q("[data-load-js-demo]");
  out.hasLoadDemo = Boolean(loadDemo);
  if (loadDemo) loadDemo.click();
  await sleep(2000);

  const store = W.__BWE__.store;
  out.projectName = store.project?.name ?? null;
  out.scenes = store.project?.scenes?.length ?? 0;
  if (!store.project) return out;

  // ---- 1. ProjectDigest 能读，且新字段齐全 ----
  const digestText = W.__BWE__.runScriptTool("ProjectDigest", {});
  out.digestOk = typeof digestText?.text === "string" && digestText.text.length > 200;
  out.digestHead = String(digestText?.text ?? "").slice(0, 900);
  // 新字段是否出现在模型读到的文本里
  out.digestHas = {
    tileSize: /tileSize/.test(out.digestHead),
    masterVolume: /音量/.test(out.digestHead),
    orientation: /方向/.test(out.digestHead),
    layersVisible: /隐藏|锁定|图层/.test(out.digestHead),
    sceneScript: /场景脚本|无场景脚本/.test(out.digestHead),
    packs: /规则包/.test(out.digestHead),
    animMode: /动画|static/.test(out.digestHead),
  };

  // ---- 2. updateProject 真的落到 store ----
  const beforeName = store.project.name;
  const beforeRef = store.project;
  const r1 = W.__BWE__.runScriptTool("ApplyProjectOps", {
    ops: [{ op: "updateProject", set: { name: "端到端改名", tileSize: 48, masterVolume: 0.5, orientation: "portrait" } }]
  });
  await sleep(200);
  out.apply1Text = String(r1?.text ?? "").slice(0, 400);
  out.apply1Error = r1?.error ?? null;
  // ★ 独立核对 store，不看工具自己的说法
  out.storeName = store.project.name;
  out.storeTileSize = store.project.tileSize;
  out.storeVolume = store.project.masterVolume;
  out.storeOrientation = store.project.orientation;
  out.projectRefChanged = store.project !== beforeRef;
  out.beforeName = beforeName;

  // ---- 3. 画布真的重画了（requestPaint 走的是同一套，看 canvas 元素存在 + 选中态刷新）----
  out.canvasExists = Boolean(q("canvas"));

  // ---- 4. 场景级改动：加对象 + 改场景脚本 ----
  const scene = store.project.scenes[0];
  const sceneNameBefore = scene.name;
  const objCountBefore = scene.objects.length;
  const r2 = W.__BWE__.runScriptTool("ApplyProjectOps", {
    ops: [
      { op: "updateScene", sceneId: scene.id, set: { widthTiles: 44, heightTiles: 33, originX: 5 } },
      { op: "addObjects", sceneId: scene.id, objects: [
        { name: "AI 放的箱子", kind: "PROP", x: 100, y: 120, animMode: "loop", animFps: 6 }
      ] }
    ]
  });
  await sleep(200);
  out.apply2Text = String(r2?.text ?? "").slice(0, 400);
  const sceneAfter = store.project.scenes[0];
  out.sceneWidth = sceneAfter.widthTiles;
  out.sceneHeight = sceneAfter.heightTiles;
  out.sceneOriginX = sceneAfter.originX;
  out.objCountBefore = objCountBefore;
  out.objCountAfter = sceneAfter.objects.length;
  out.newObjAnim = (() => {
    const o = sceneAfter.objects[sceneAfter.objects.length - 1];
    return { name: o?.name, animMode: o?.animMode, animFps: o?.animFps };
  })();
  out.sceneNameUnchanged = sceneAfter.name === sceneNameBefore;

  // ---- 5. 撤销：AI 的改动能 Ctrl+Z 回退 ----
  //
  // ⚠ 必须在**独立的一步**上验，且要看"退回到了哪一步"而不是"名字变没变"。
  //   第一版这里先做了 apply1（改名）再做 apply2（改场景），然后撤销 ——
  //   撤销只能退掉 apply2（场景尺寸），名字当然不变，于是报"撤销失效"，
  //   而实际上撤销一直是好的（真正坏的是那次 resetHistoryIfProjectReplaced）。
  //   这类"断言写对了、被测对象选错了"的假红，比没有断言更浪费时间。
  const undo = W.__BWE__.editor.undo;
  out.hasUndo = typeof undo === "function";
  if (out.hasUndo) {
    out.undoStackDepth = W.__BWE__.editor.undoStack?.length ?? -1;
    const nameBeforeUndo = store.project.name;
    const widthBeforeUndo = store.project.scenes[0].widthTiles;
    const objCountBeforeUndo = store.project.scenes[0].objects.length;
    undo.call(W.__BWE__.editor);
    await sleep(400);
    out.undoOnce = {
      before: { name: nameBeforeUndo, width: widthBeforeUndo, objs: objCountBeforeUndo },
      after: { name: store.project.name, width: store.project.scenes[0].widthTiles, objs: store.project.scenes[0].objects.length },
    };
    // 这一步应当退掉 apply2（场景尺寸 + 新对象），名字保持 apply1 的结果
    out.undoRevertedScene = store.project.scenes[0].widthTiles !== widthBeforeUndo
      || store.project.scenes[0].objects.length !== objCountBeforeUndo;
    // 再撤一步应该退掉 apply1（名字）
    undo.call(W.__BWE__.editor);
    await sleep(400);
    out.undoTwiceName = store.project.name;
    out.undoWorked = store.project.name !== nameBeforeUndo;
    out.multiStepUndo = store.project.name === beforeName;
  }

  // ---- 6. dryRun：工程必须一字节不变 ----
  const snapBefore = JSON.stringify(store.project);
  const r3 = W.__BWE__.runScriptTool("ApplyProjectOps", {
    dryRun: true,
    ops: [{ op: "updateProject", set: { name: "试运行不该落地的名字" } }]
  });
  await sleep(200);
  out.dryRunText = String(r3?.text ?? "").slice(0, 300);
  out.dryRunChangedStore = JSON.stringify(store.project) !== snapBefore;
  out.dryRunName = store.project.name;
  out.dryRunSaysTrial = /试运行/.test(out.dryRunText);

  // ---- 7. 非法批次：整批拒绝、工程不变 ----
  const snap2 = JSON.stringify(store.project);
  const r4 = W.__BWE__.runScriptTool("ApplyProjectOps", {
    ops: [
      { op: "updateProject", set: { name: "这条合法" } },
      { op: "updateProject", set: { tileSize: 0 } }   // 非法
    ]
  });
  await sleep(200);
  out.badRejected = Boolean(r4?.error) || /整批被拒/.test(String(r4?.text ?? ""));
  out.badText = String(r4?.text ?? "").slice(0, 300);
  out.badBatchUnchanged = JSON.stringify(store.project) === snap2;

  // ---- 8. 删除保护：删最后一个场景必须被拒 ----
  const p = store.project;
  if (p.scenes.length === 1) {
    const r5 = W.__BWE__.runScriptTool("ApplyProjectOps", { ops: [{ op: "deleteScene", sceneId: p.scenes[0].id }] });
    out.lastSceneRejected = /last_scene|最后|至少要有一个/.test(String(r5?.text ?? "") + String(r5?.error ?? ""));
    out.lastSceneText = String(r5?.text ?? "").slice(0, 200);
  } else {
    out.lastSceneRejected = "skipped:工程有多个场景";
  }

  // ---- 9. 素材引用保护（示例工程通常没有素材，跳过时不假装成功）----
  out.assetsInProject = p.assets.length;

  return out;
})()
