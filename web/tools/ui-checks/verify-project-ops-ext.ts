/**
 * verify-project-ops-ext —— 「AI 能改工程里任意东西」扩展的验收。
 *
 * 与 verify-project-ops.ts 分开的理由：
 *   1. 老文件 467 行、覆盖「事务性 / 参数越界 / 离线规划器」等基础契约，一行都不该动 ——
 *      扩建时最怕的就是顺手改坏了既有断言，而「改坏了但还绿」是最坏结局。
 *   2. 这份验收的判据完全不同：它问的是「**每一个**属性都改得了吗」，
 *      所以大量断言是「字段 X 在 digest 里可见」+「字段 X 能通过 op 写入」成对出现。
 *
 * 契约：docs/_fragments/project-ops-extension-spec.md
 *
 * 跑法：
 *   npx esbuild web/tools/ui-checks/verify-project-ops-ext.ts --bundle --platform=node \
 *     --format=esm --outfile=.tmp_ui/project-ops-ext.mjs --log-level=warning \
 *     && node .tmp_ui/project-ops-ext.mjs
 */

import { createProject, createScene, createUiScene } from "../../src/core/model.ts";
import { applyProjectOps, digestProject, PROJECT_OP_NAMES, runProjectTool, describeDigest } from "../../src/core/projectOps.ts";
import { MODULES } from "../../src/data/modules.ts";

let failures = 0;
let checks = 0;

function ok(cond: boolean, label: string): void {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error(`  FAIL  ${label}`);
  }
}

function eq<T>(actual: T, expected: T, label: string): void {
  checks += 1;
  if (actual !== expected) {
    failures += 1;
    console.error(`  FAIL  ${label}\n          期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function section(name: string): void {
  console.log(`\n== ${name}`);
}

/** 一条 op 应当被拒，且原因码符合预期。 */
function rejects(op: unknown, code: string, label: string): void {
  const r = applyProjectOps(richProject(), [op as never]);
  checks += 1;
  if (r.ok) {
    failures += 1;
    console.error(`  FAIL  ${label}\n          期望被拒（${code}），实际通过了`);
    return;
  }
  const codes = r.rejections.map((x) => x.code);
  checks += 1;
  if (!codes.includes(code as never)) {
    failures += 1;
    console.error(`  FAIL  ${label}\n          期望原因码 ${code}，实际 ${codes.join(",")}`);
  }
}

/**
 * 造一个「什么都有」的工程。
 *
 * 必须每类都至少有一条：2 场景（含 3 图层）、2 对象、1 预制体、3 素材（图/序列帧/音频）、
 * 3 脚本（js×2 + yarn×1）、2 变量、1 规则包。
 * 少一类就等于那条能力没被测到 —— 而"没被测到"和"没实现"在报告里长得一模一样。
 */
function richProject() {
  const p = createProject("富工程");
  p.author = "原作者";
  p.tileSize = 32;
  p.gridW = 60;
  p.gridH = 40;
  p.masterVolume = 0.8;
  p.orientation = "landscape";
  p.variables = { gold: "0", hp: "100" };

  const a = createScene("战场", 32, 24);
  a.onStartScript = "";
  a.bgmAssetId = "";
  a.objects = [
    {
      id: "o_guard", name: "守卫", kind: "ACTOR", x: 64, y: 96, z: 0, rotation: 0,
      scaleX: 1, scaleY: 1, halfW: 12, halfH: 16, layerId: a.layers[0].id,
      visible: true, locked: false, assetId: "", animMode: "static", animFps: 0,
      modules: [], props: {}, tags: ["敌"]
    },
    {
      id: "o_tree", name: "树", kind: "PROP", x: 128, y: 128, z: 1, rotation: 0,
      scaleX: 1, scaleY: 1, halfW: 16, halfH: 16, layerId: a.layers[1].id,
      visible: true, locked: false, assetId: "", animMode: "static", animFps: 0,
      modules: [], props: {}, tags: []
    }
  ];
  const b = createScene("第二关", 20, 16);
  p.scenes = [a, b];

  p.prefabs = [{
    id: "pf_slime", name: "史莱姆", blurb: "小怪", kind: "ACTOR", assetId: "", z: 0,
    rotation: 0, scaleX: 1, scaleY: 1, halfW: 12, halfH: 12, animMode: "static",
    animFps: 0, tags: ["敌"], modules: [], props: {}, script: "",
    spawnJitter: { x: 0, y: 0 }
  }];

  p.assets = [
    {
      id: "as_hero", name: "勇者", kind: "IMAGE", src: "url", url: "https://example.com/hero.png",
      path: "hero.png", width: 32, height: 32, group: "角色", note: ""
    },
    {
      id: "as_seq", name: "行走", kind: "SEQUENCE", src: "blob", path: "walk",
      headName: "walk_0", frameCount: 4, width: 32, height: 32, group: "角色",
      hiddenFrames: [], frameDurations: [100, 100, 100, 100], note: ""
    },
    {
      id: "as_bgm", name: "BGM", kind: "AUDIO", src: "url", url: "https://example.com/bgm.mp3",
      path: "bgm.mp3", width: 0, height: 0, group: "音频", note: ""
    }
  ];

  p.scripts = {
    玩家: { name: "玩家", file: "Scripts/玩家.js", source: "function onStart(){}", lang: "js" },
    剧情: { name: "剧情", file: "Scripts/剧情.yarn", source: "title: a\n---\n===", lang: "yarn" },
    备用: { name: "备用", file: "Scripts/备用.js", source: "var x = 1;", lang: "js" }
  };

  p.packs = [{ id: "pk_guard", name: "守卫包", blurb: "", modules: [], exposed: {}, exposedLabel: {} }];
  return p;
}

/** 找第一个带 ≥2 个数值参数的模块（用来验证「只改一个参数」）。 */
function twoNumModule() {
  return MODULES.find((m) => m.params.filter((x) => x.type === "num" && x.min !== undefined && x.max !== undefined).length >= 2);
}

// ==========================================================================
section("1. updateProject：工程级字段全可改");
{
  const r = applyProjectOps(richProject(), [
    { op: "updateProject", set: { name: "改名后", author: "AI", tileSize: 48, gridW: 80, gridH: 50, masterVolume: 0.35, orientation: "portrait" } },
  ]);
  ok(r.ok, "updateProject 应成功");
  const q = r.project!;
  eq(q.name, "改名后", "name 应改");
  eq(q.author, "AI", "author 应改");
  eq(q.tileSize, 48, "tileSize 应改");
  eq(q.gridW, 80, "gridW 应改");
  eq(q.gridH, 50, "gridH 应改");
  eq(q.masterVolume, 0.35, "masterVolume 应改");
  eq(q.orientation, "portrait", "orientation 应改");
  eq(q.variables.gold, "0", "没给的字段必须保持原值");
}
rejects({ op: "updateProject", set: { name: "" } }, "empty_name", "空工程名应被拒");
rejects({ op: "updateProject", set: { tileSize: 0 } }, "bad_param", "tileSize=0 应被拒");
rejects({ op: "updateProject", set: { masterVolume: 2 } }, "bad_param", "masterVolume 超 1 应被拒");
rejects({ op: "updateProject", set: { orientation: "斜着" } }, "bad_param", "非法 orientation 应被拒");
{
  const r = applyProjectOps(richProject(), [{ op: "updateProject", set: { orientation: "" } }]);
  ok(r.ok, "orientation 传空串应成功");
  eq(r.project!.orientation, undefined, "空串应清除该字段（不是写空字符串）");
}

// ==========================================================================
section("2. updateScene / deleteScene / reorderScenes");
{
  const r = applyProjectOps(richProject(), [
    {
      op: "updateScene", sceneName: "战场",
      set: { name: "主战场", widthTiles: 40, heightTiles: 30, originX: 10, originY: 20, onStartScript: "玩家", bgmAssetId: "as_bgm" }
    }
  ]);
  ok(r.ok, "updateScene 应成功");
  const sc = r.project!.scenes[0];
  eq(sc.name, "主战场", "场景名应改");
  eq(sc.widthTiles, 40, "widthTiles 应改（原实现只能在建场景时设）");
  eq(sc.heightTiles, 30, "heightTiles 应改");
  eq(sc.originX, 10, "originX 应改");
  eq(sc.originY, 20, "originY 应改");
  eq(sc.onStartScript, "玩家", "onStartScript 应改");
  eq(sc.bgmAssetId, "as_bgm", "bgmAssetId 应改");
}
rejects({ op: "updateScene", sceneName: "战场", set: { onStartScript: "没这个脚本" } }, "unknown_script", "引用不存在的脚本应被拒");
rejects({ op: "updateScene", sceneName: "战场", set: { bgmAssetId: "as_不存在" } }, "unknown_asset", "引用不存在的素材应被拒");
rejects({ op: "updateScene", sceneName: "战场", set: { name: "第二关" } }, "duplicate_name", "与其它场景重名应被拒");
{
  const r = applyProjectOps(richProject(), [{ op: "deleteScene", sceneName: "第二关" }]);
  ok(r.ok, "deleteScene 应成功");
  eq(r.project!.scenes.length, 1, "应剩 1 个场景");

  const only = richProject();
  only.scenes = [only.scenes[0]];
  const del = applyProjectOps(only, [{ op: "deleteScene", sceneName: "战场" }]);
  ok(!del.ok, "删到 0 个场景必须被拒");
  eq(del.rejections[0].code, "last_scene", "原因码 last_scene");
}
{
  const p = richProject();
  const a = p.scenes[0].id;
  const b = p.scenes[1].id;
  const r = applyProjectOps(p, [{ op: "reorderScenes", order: [b, a] }]);
  ok(r.ok, "reorderScenes 应成功");
  eq(r.project!.scenes[0].id, b, "顺序应被反转");
}
rejects({ op: "reorderScenes", order: ["只有一个"] }, "bad_order", "不完整的 order 应被拒");
rejects({ op: "reorderScenes", order: [] }, "bad_order", "空 order 应被拒");

// ==========================================================================
section("3. 图层：addLayer / updateLayers / deleteLayers");
{
  const p = richProject();
  const sceneId = p.scenes[0].id;
  const emptyLayer = p.scenes[0].layers[2].id; // 「角色」层没有对象
  const r = applyProjectOps(p, [
    { op: "addLayer", sceneId, name: "装饰层" },
    { op: "updateLayers", sceneId, updates: [{ id: emptyLayer, patch: { name: "演员层", visible: false, locked: true } }] }
  ]);
  ok(r.ok, "addLayer + updateLayers 应成功");
  const sc = r.project!.scenes[0];
  eq(sc.layers.length, 4, "应新增一层");
  eq(sc.layers[2].name, "演员层", "图层名应改（原实现只能加不能改）");
  eq(sc.layers[2].visible, false, "图层 visible 应可改");
  eq(sc.layers[2].locked, true, "图层 locked 应可改");

  const del = applyProjectOps(r.project!, [{ op: "deleteLayers", sceneId, ids: [sc.layers[3].id] }]);
  ok(del.ok, "删除空图层应成功");
  eq(del.project!.scenes[0].layers.length, 3, "应剩 3 层");
}
{
  const p = richProject();
  const busy = p.scenes[0].layers[0].id; // 「地形」层上有「守卫」
  const r = applyProjectOps(p, [{ op: "deleteLayers", sceneId: p.scenes[0].id, ids: [busy] }]);
  ok(!r.ok, "还有对象的图层必须拒绝删除");
  eq(r.rejections[0].code, "layer_not_empty", "原因码 layer_not_empty");
  ok(r.rejections[0].hint.length > 10, "必须给 hint 告诉模型怎么处理");
}
{
  const p = richProject();
  const all = p.scenes[1].layers.map((l) => l.id); // 第二关是空的
  const r = applyProjectOps(p, [{ op: "deleteLayers", sceneName: "第二关", ids: all }]);
  ok(!r.ok, "把图层删到一个不剩必须被拒");
  eq(r.rejections[0].code, "last_layer", "原因码 last_layer");
}

// ==========================================================================
section("4. 对象：新字段 + reorderObjects + parentId 成环");
{
  const r = applyProjectOps(richProject(), [
    {
      op: "updateObjects", sceneName: "战场",
      updates: [{ id: "o_tree", patch: { parentId: "o_guard", animMode: "loop", animFps: 12, prefabId: "pf_slime", rotation: 45, scaleX: 2 } }]
    }
  ]);
  ok(r.ok, "updateObjects 应接受新字段");
  const tree = r.project!.scenes[0].objects.find((o) => o.id === "o_tree")!;
  eq(tree.parentId, "o_guard", "parentId 应可改（原实现完全不能改）");
  eq(tree.animMode, "loop", "animMode 应可改");
  eq(tree.animFps, 12, "animFps 应可改");
  eq(tree.prefabId, "pf_slime", "prefabId 应可改");
  eq(tree.rotation, 45, "rotation 应可改");
  eq(tree.scaleX, 2, "scaleX 应可改");
}
rejects(
  { op: "updateObjects", sceneName: "战场", updates: [{ id: "o_guard", patch: { parentId: "o_guard" } }] },
  "cycle", "parentId 指向自己应被拒"
);
rejects(
  { op: "updateObjects", sceneName: "战场", updates: [{ id: "o_guard", patch: { parentId: "不存在" } }] },
  "unknown_object", "parentId 指向不存在的对象应被拒"
);
{
  // 两对象互相认父 → 环
  const r = applyProjectOps(richProject(), [
    { op: "updateObjects", sceneName: "战场", updates: [{ id: "o_guard", patch: { parentId: "o_tree" } }] },
    { op: "updateObjects", sceneName: "战场", updates: [{ id: "o_tree", patch: { parentId: "o_guard" } }] }
  ]);
  ok(!r.ok, "parentId 成环必须被拒");
  eq(r.rejections[0].code, "cycle", "原因码 cycle");
}
{
  const r = applyProjectOps(richProject(), [{ op: "reorderObjects", sceneName: "战场", order: ["o_tree", "o_guard"] }]);
  ok(r.ok, "reorderObjects 应成功");
  const objs = r.project!.scenes[0].objects;
  eq(objs[0].id, "o_tree", "顺序应按 order");
  eq(objs[0].z, 0, "应写回 z=0");
  eq(objs[1].z, 1, "应写回 z=1");
}
rejects({ op: "reorderObjects", sceneName: "战场", order: ["o_guard"] }, "bad_order", "不完整的 order 应被拒");
{
  // addObjects 也要能一次给全 animMode / animFps / parentId
  const r = applyProjectOps(richProject(), [
    { op: "addObjects", sceneName: "战场", objects: [{ name: "影子", kind: "PROP", x: 8, y: 8, animMode: "loop", animFps: 6, parentId: "o_guard" }] }
  ]);
  ok(r.ok, "addObjects 应接受 animMode/animFps/parentId");
  const made = r.project!.scenes[0].objects[r.project!.scenes[0].objects.length - 1];
  eq(made.animMode, "loop", "新增对象 animMode 应生效");
  eq(made.animFps, 6, "新增对象 animFps 应生效");
  eq(made.parentId, "o_guard", "新增对象 parentId 应生效");
}

// ==========================================================================
section("5. updatePrefabs：预制体全字段可改");
{
  const r = applyProjectOps(richProject(), [
    {
      op: "updatePrefabs",
      updates: [{
        id: "pf_slime",
        patch: {
          name: "绿史莱姆", blurb: "更弱", z: 5, layer: 1, rotation: 90,
          scaleX: 2, scaleY: 2, animMode: "loop", animFps: 8, script: "玩家",
          spawnJitter: { x: 32, y: 16 }, tags: ["敌", "弱"]
        }
      }]
    }
  ]);
  ok(r.ok, "updatePrefabs 应成功");
  const pf = r.project!.prefabs[0];
  eq(pf.name, "绿史莱姆", "预制体名应改（原实现只能新建不能改）");
  eq(pf.blurb, "更弱", "blurb 应可改");
  eq(pf.z, 5, "z 应可改");
  eq(pf.layer, 1, "layer 应可改");
  eq(pf.rotation, 90, "rotation 应可改");
  eq(pf.scaleX, 2, "scaleX 应可改");
  eq(pf.animMode, "loop", "animMode 应可改");
  eq(pf.animFps, 8, "animFps 应可改");
  eq(pf.script, "玩家", "script 应可改");
  eq(pf.spawnJitter!.x, 32, "spawnJitter.x 应可改");
  eq(pf.tags.length, 2, "tags 应可改");
}
rejects({ op: "updatePrefabs", updates: [{ id: "pf_不存在", patch: { blurb: "x" } }] }, "unknown_prefab", "未知预制体 id 应被拒");
rejects({ op: "updatePrefabs", updates: [{ id: "pf_slime", patch: { script: "没这个脚本" } }] }, "unknown_script", "引用不存在的脚本应被拒");
{
  const p = richProject();
  p.prefabs.push({
    id: "pf_other", name: "别的", blurb: "", kind: "PROP", assetId: "", z: 0, rotation: 0,
    scaleX: 1, scaleY: 1, halfW: 16, halfH: 16, animMode: "static", animFps: 0,
    tags: [], modules: [], props: {}, script: ""
  });
  const r = applyProjectOps(p, [{ op: "updatePrefabs", updates: [{ id: "pf_slime", patch: { name: "别的" } }] }]);
  ok(!r.ok, "预制体重名应被拒（运行期按名字 spawn）");
  eq(r.rejections[0].code, "duplicate_name", "原因码 duplicate_name");
}

// ==========================================================================
section("6. patchModules：只改一个参数，不清其它值");
{
  const mod = twoNumModule();
  ok(!!mod, "应存在带 ≥2 个数值参数的模块");
  if (mod) {
    const nums = mod.params.filter((x) => x.type === "num" && x.min !== undefined && x.max !== undefined);
    const k1 = nums[0].key;
    const k2 = nums[1].key;
    const p = richProject();

    const attached = applyProjectOps(p, [
      {
        op: "attachModules", sceneName: "战场", targetId: "o_guard",
        modules: [{ defId: mod.id, values: { [k1]: String(nums[0].min), [k2]: String(nums[1].min) } }]
      }
    ]);
    ok(attached.ok, "attachModules 应成功");

    const patched = applyProjectOps(attached.project!, [
      { op: "patchModules", sceneName: "战场", targetId: "o_guard", patches: [{ defId: mod.id, values: { [k1]: String(nums[0].max) } }] }
    ]);
    ok(patched.ok, "patchModules 应成功");
    const got = patched.project!.scenes[0].objects.find((o) => o.id === "o_guard")!.modules[0];
    eq(got.values[k1], String(nums[0].max), "k1 应被改");
    eq(got.values[k2], String(nums[1].min), "k2 必须保持原值（这正是 patchModules 存在的理由）");
  }
}
rejects(
  { op: "patchModules", sceneName: "战场", targetId: "o_guard", patches: [{ defId: MODULES[0].id }] },
  "unknown_module_instance", "未挂载的 defId 应被拒"
);
rejects(
  { op: "patchModules", sceneName: "战场", targetId: "o_不存在", patches: [{ defId: MODULES[0].id }] },
  "unknown_object", "不存在的对象应被拒"
);
{
  const mod = twoNumModule();
  if (mod) {
    const nums = mod.params.filter((x) => x.type === "num" && x.min !== undefined && x.max !== undefined);
    const p = richProject();
    p.prefabs[0].modules = [{
      defId: mod.id, values: { [nums[0].key]: String(nums[0].min) }, trigger: null, enabled: true, collapsed: true
    }];
    const r = applyProjectOps(p, [
      { op: "patchModules", targetId: "pf_slime", isPrefab: true, patches: [{ defId: mod.id, values: { [nums[0].key]: String(nums[0].max) } }] }
    ]);
    ok(r.ok, "预制体上的模块应可 patch");
    eq(r.project!.prefabs[0].modules[0].values[nums[0].key], String(nums[0].max), "预制体模块参数应改");
  }
}
rejects(
  { op: "patchModules", sceneName: "战场", targetId: "o_guard", patches: [{ defId: MODULES[0].id, enabled: false }] },
  "unknown_module_instance", "改 enabled 也必须先挂上"
);

// ==========================================================================
section("7. 素材：updateAssets / deleteAssets（含引用保护）");
{
  const r = applyProjectOps(richProject(), [
    { op: "updateAssets", updates: [{ id: "as_hero", patch: { name: "勇者改", group: "主角", note: "备注", url: "https://example.com/h2.png" } }] }
  ]);
  ok(r.ok, "updateAssets 应成功");
  const a = r.project!.assets.find((x) => x.id === "as_hero")!;
  eq(a.name, "勇者改", "素材名应可改（原实现完全不能改）");
  eq(a.group, "主角", "group 应可改");
  eq(a.note, "备注", "note 应可改");
  eq(a.url, "https://example.com/h2.png", "url 应可改");
}
{
  const bad = applyProjectOps(richProject(), [
    { op: "updateAssets", updates: [{ id: "as_seq", patch: { frameDurations: [100, 100] } }] }
  ]);
  ok(!bad.ok, "frameDurations 长度与 frameCount 不一致必须被拒");
  eq(bad.rejections[0].code, "bad_param", "原因码 bad_param");

  const good = applyProjectOps(richProject(), [
    { op: "updateAssets", updates: [{ id: "as_seq", patch: { frameDurations: [50, 60, 70, 80], hiddenFrames: [3] } }] }
  ]);
  ok(good.ok, "合法的 frameDurations / hiddenFrames 应通过");

  const overFrame = applyProjectOps(richProject(), [
    { op: "updateAssets", updates: [{ id: "as_seq", patch: { hiddenFrames: [9] } }] }
  ]);
  ok(!overFrame.ok, "hiddenFrames 下标超出 frameCount 应被拒");
}
rejects({ op: "updateAssets", updates: [{ id: "as_不存在", patch: { name: "x" } }] }, "unknown_asset", "未知素材 id 应被拒");
{
  const p = richProject();
  p.scenes[0].bgmAssetId = "as_bgm";
  const r = applyProjectOps(p, [{ op: "deleteAssets", ids: ["as_bgm"] }]);
  ok(!r.ok, "被场景 bgm 引用的素材必须拒绝删除");
  eq(r.rejections[0].code, "asset_in_use", "原因码 asset_in_use");
  ok(/场景|战场/.test(r.rejections[0].hint), `hint 应指出引用方，实际：${r.rejections[0].hint}`);
}
{
  const p = richProject();
  p.scenes[0].objects[0].assetId = "as_hero";
  const r = applyProjectOps(p, [{ op: "deleteAssets", ids: ["as_hero"] }]);
  ok(!r.ok, "被对象引用的素材必须拒绝删除");
  eq(r.rejections[0].code, "asset_in_use", "原因码 asset_in_use");
}
{
  const p = richProject();
  p.prefabs[0].assetId = "as_hero";
  const r = applyProjectOps(p, [{ op: "deleteAssets", ids: ["as_hero"] }]);
  ok(!r.ok, "被预制体引用的素材必须拒绝删除");
  eq(r.rejections[0].code, "asset_in_use", "原因码 asset_in_use");
}
{
  const r = applyProjectOps(richProject(), [{ op: "deleteAssets", ids: ["as_bgm"] }]);
  ok(r.ok, "未被引用的素材应可删");
  eq(r.project!.assets.length, 2, "应剩 2 个素材");
}

// ==========================================================================
section("8. 规则包：definePacks / updatePacks / deletePacks / applyPacks");
{
  const defId = MODULES[0].id;
  const r = applyProjectOps(richProject(), [
    { op: "definePacks", packs: [{ name: "巡逻包", blurb: "来回走", modules: [{ defId }] }] }
  ]);
  ok(r.ok, "definePacks 应成功");
  eq(r.project!.packs.length, 2, "应新增 1 个包");

  const upd = applyProjectOps(r.project!, [
    { op: "updatePacks", updates: [{ id: "pk_guard", patch: { name: "守卫包改", blurb: "新说明" } }] }
  ]);
  ok(upd.ok, "updatePacks 应成功");
  eq(upd.project!.packs[0].name, "守卫包改", "包名应可改（原实现完全不能改）");
  eq(upd.project!.packs[0].blurb, "新说明", "blurb 应可改");

  const del = applyProjectOps(upd.project!, [{ op: "deletePacks", ids: ["pk_guard"] }]);
  ok(del.ok, "deletePacks 应成功");
  eq(del.project!.packs.length, 1, "应剩 1 个包");
}
rejects({ op: "updatePacks", updates: [{ id: "pk_不存在", patch: { name: "x" } }] }, "unknown_pack", "未知包 id 应被拒");
{
  // applyPacks：套包到对象
  const defId = MODULES[0].id;
  const p = richProject();
  p.packs = [{ id: "pk_a", name: "包A", blurb: "", modules: [{ defId, values: {}, trigger: null, enabled: true, collapsed: true }], exposed: {}, exposedLabel: {} }];
  const r = applyProjectOps(p, [{ op: "applyPacks", sceneName: "战场", targets: ["o_guard"], packIds: ["pk_a"] }]);
  ok(r.ok, "applyPacks 应成功");
  const guard = r.project!.scenes[0].objects.find((o) => o.id === "o_guard")!;
  eq(guard.modules.length, 1, "套包后守卫应有 1 个模块");
  eq(guard.modules[0].defId, defId, "模块 defId 应来自包");
}
{
  // 重复套同一个包 → 覆盖而不是追加（与 data/packs.ts 的 applyPack 语义一致）
  const defId = MODULES[0].id;
  const p = richProject();
  p.packs = [{ id: "pk_a", name: "包A", blurb: "", modules: [{ defId, values: {}, trigger: null, enabled: true, collapsed: true }], exposed: {}, exposedLabel: {} }];
  const once = applyProjectOps(p, [{ op: "applyPacks", sceneName: "战场", targets: ["o_guard"], packIds: ["pk_a"] }]);
  const twice = applyProjectOps(once.project!, [{ op: "applyPacks", sceneName: "战场", targets: ["o_guard"], packIds: ["pk_a"] }]);
  ok(twice.ok, "重复套包应成功");
  const guard = twice.project!.scenes[0].objects.find((o) => o.id === "o_guard")!;
  eq(guard.modules.length, 1, "重复套同一个包不应产生重复模块（覆盖语义）");
}
rejects({ op: "applyPacks", sceneName: "战场", targets: ["o_guard"], packIds: ["pk_不存在"] }, "unknown_pack", "套不存在的包应被拒");
rejects({ op: "applyPacks", sceneName: "战场", targets: ["o_不存在"], packIds: ["pk_guard"] }, "unknown_object", "套到不存在的对象应被拒");

// ==========================================================================
section("9. 脚本：writeScripts 带 lang + deleteScripts（含引用保护）");
{
  const r = applyProjectOps(richProject(), [
    { op: "writeScripts", scripts: [{ path: "Scripts/新脚本.js", source: "var a = 1;", lang: "js" }] }
  ]);
  ok(r.ok, "writeScripts 带 lang 应成功");
  const s = r.project!.scripts["新脚本"];
  ok(!!s, "应按文件名推出脚本名");
  eq(s.lang, "js", "lang 必须真的写进去（原实现根本不写 lang 字段）");
}
{
  const yarn = applyProjectOps(richProject(), [
    { op: "writeScripts", scripts: [{ path: "Scripts/新剧情.yarn", source: "title: a\n---\n===" }] }
  ]);
  ok(yarn.ok, "写 yarn 应成功");
  eq(yarn.project!.scripts["新剧情"].lang, "yarn", ".yarn 后缀应推断成 yarn");
}
{
  const p = richProject();
  p.scenes[0].onStartScript = "玩家";
  const r = applyProjectOps(p, [{ op: "deleteScripts", names: ["玩家"] }]);
  ok(!r.ok, "被场景 onStartScript 引用的脚本必须拒绝删除");
  eq(r.rejections[0].code, "script_in_use", "原因码 script_in_use");
  ok(/场景|战场/.test(r.rejections[0].hint), `hint 应指出引用方，实际：${r.rejections[0].hint}`);
}
{
  const p = richProject();
  const def = MODULES.find((m) => m.id === "script.js");
  ok(!!def, "应有 script.js 模块");
  if (def) {
    p.scenes[0].objects[0].modules = [{
      defId: "script.js",
      values: Object.fromEntries(def.params.map((x) => [x.key, x.def])) as Record<string, string>,
      trigger: null, enabled: true, collapsed: true
    }];
    p.scenes[0].objects[0].modules[0].values.script = "玩家";
    const r = applyProjectOps(p, [{ op: "deleteScripts", names: ["玩家"] }]);
    ok(!r.ok, "被对象 script.js 模块引用的脚本必须拒绝删除");
    eq(r.rejections[0].code, "script_in_use", "原因码 script_in_use");
  }
}
{
  const r = applyProjectOps(richProject(), [{ op: "deleteScripts", names: ["备用"] }]);
  ok(r.ok, "未被引用的脚本应可删");
  eq(r.project!.scripts["备用"], undefined, "脚本应被删掉");
}
rejects({ op: "deleteScripts", names: ["没这个脚本"] }, "unknown_script", "删不存在的脚本应被拒");

// ==========================================================================
section("10. ProjectDigest 必须让模型「看得见」才「改得动」");
{
  const d = digestProject(richProject());
  const txt = JSON.stringify(d);

  for (const k of ["tileSize", "gridW", "gridH", "masterVolume", "orientation", "author"]) {
    ok(txt.includes(k), `digest 必须含工程级字段 ${k}`);
  }
  const sc = d.scenes[0] as unknown as Record<string, unknown>;
  for (const k of ["originX", "originY", "onStartScript", "bgmAssetId"]) {
    ok(k in sc, `digest 场景必须含 ${k}（否则该字段 AI 永远改不动）`);
  }
  const layer = (sc.layers as Array<Record<string, unknown>>)[0];
  for (const k of ["visible", "locked", "order"]) {
    ok(k in layer, `digest 图层必须含 ${k}`);
  }
  const obj = (sc.sampleObjects as Array<Record<string, unknown>>)[0];
  for (const k of ["rotation", "scaleX", "scaleY", "visible", "locked", "assetId", "layerId", "tags", "props", "animMode", "animFps", "z", "halfW", "halfH", "parentId"]) {
    ok(k in obj, `digest 对象必须含 ${k}`);
  }
  const pf = d.prefabs[0] as unknown as Record<string, unknown>;
  for (const k of ["blurb", "assetId", "z", "rotation", "scaleX", "animMode", "script", "spawnJitter", "props", "halfW"]) {
    ok(k in pf, `digest 预制体必须含 ${k}`);
  }
  const as = d.assets[0] as unknown as Record<string, unknown>;
  for (const k of ["src", "url", "path", "group", "note", "frameCount"]) {
    ok(k in as, `digest 素材必须含 ${k}`);
  }
  ok(Array.isArray((d as unknown as Record<string, unknown>).packs), "digest 必须列出规则包（原实现完全没有）");
}
{
  // 对象仍要限流，不能把上下文撑爆
  const p = richProject();
  const scene = p.scenes[0];
  for (let i = 0; i < 100; i++) {
    scene.objects.push({ ...scene.objects[0], id: `bulk_${i}`, name: `批量${i}` });
  }
  const d = digestProject(p, { maxObjects: 10 });
  eq(d.scenes[0].sampleObjects.length, 10, "maxObjects 应生效");
  eq(d.scenes[0].objectCount, 102, "总数必须如实给出");
}
{
  // describeDigest 是模型真正读到的文本：关键 id 一个都不能省
  const txt = describeDigest(digestProject(richProject()));
  ok(txt.includes("o_guard"), "描述文本必须带对象 id（那是唯一认的坐标）");
  ok(txt.includes("pf_slime"), "描述文本必须带预制体 id");
  ok(txt.includes("as_hero"), "描述文本必须带素材 id");
  ok(txt.includes("pk_guard"), "描述文本必须带规则包 id");
  ok(/tileSize|tile/.test(txt), "描述文本必须让模型看见 tileSize");
}

// ==========================================================================
section("11. PROJECT_OP_NAMES 与实现一致（防 schema/实现断裂）");
{
  ok(PROJECT_OP_NAMES.length >= 27, `应导出全部 op 名，实际 ${PROJECT_OP_NAMES.length} 个`);
  const must = [
    "updateProject", "updateScene", "deleteScene", "reorderScenes",
    "updateLayers", "deleteLayers", "updatePrefabs", "patchModules",
    "updateAssets", "deleteAssets", "definePacks", "updatePacks", "deletePacks", "applyPacks",
    "deleteScripts", "reorderObjects"
  ];
  for (const name of must) {
    ok(PROJECT_OP_NAMES.includes(name), `PROJECT_OP_NAMES 必须含 ${name}`);
  }
  /**
   * 每个名字都必须**真的能跑**（不能是"列了但没实现"）。
   *
   * 判据：给空参数跑一次，只要不是「未知操作」就说明 switch 里有这个分支
   * （缺参数会被当成 bad_param 拒掉，那是正确的拒绝，不是"没实现"）。
   * 这条断言的价值在于：schema 与实现是两份数据，靠人肉同步必然漂移。
   */
  for (const name of PROJECT_OP_NAMES) {
    const r = applyProjectOps(richProject(), [{ op: name } as never]);
    const unknown = r.rejections.some((x) => x.code === "bad_param" && /未知操作/.test(x.message));
    ok(!unknown, `op「${name}」必须已实现（不能只列在 PROJECT_OP_NAMES 里）`);
  }
}
{
  // runProjectTool 是 editor 侧的纯逻辑入口，必须能透传新 op
  const out = runProjectTool("ApplyProjectOps", { ops: [{ op: "updateProject", set: { name: "经工具改名" } }] }, richProject());
  eq(out.kind, "applied", "runProjectTool 应把新 op 视为已应用");
  ok(out.kind === "applied" && out.project!.name === "经工具改名", "改动应真的落到工程上");
  ok(out.text.includes("已应用"), "回给模型的文本必须是可读摘要");
}
{
  // 被拒时 runProjectTool 必须给原因，不能假装成功
  const out = runProjectTool("ApplyProjectOps", { ops: [{ op: "deleteScene", sceneName: "没这个" }] }, richProject());
  eq(out.kind, "rejected", "非法操作必须是 rejected");
  ok(out.kind === "rejected" && out.text.includes("整批被拒"), "文本必须说清工程没变");
}

console.log(`\n${"-".repeat(52)}`);
if (failures === 0) {
  console.log(`PASS   ${checks} 项断言全部通过`);
  process.exit(0);
} else {
  console.error(`FAIL   ${failures}/${checks} 项断言失败`);
  process.exit(1);
}
