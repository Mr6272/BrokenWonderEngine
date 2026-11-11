/**
 * verify-project-ops —— projectOps 验收脚本
 *
 * 跑法（与仓库既有 verify:script-ops 同构）：
 *   npx esbuild web/tools/ui-checks/verify-project-ops.ts --bundle --platform=node \
 *     --format=esm --outfile=.tmp_ui/project-ops.mjs --log-level=warning \
 *     && node .tmp_ui/project-ops.mjs
 *
 * 覆盖验收标准 1~4 与离线降级：
 *   1. 事务性：含非法操作的批次，工程逐字节不变
 *   2. attachModules 拒绝不存在的 defId
 *   3. 参数越界 / 拼错参数名 被拒，不写入非法值
 *   4. 离线规划器产出真实可应用的 ops
 */

import { createProject, createScene, normalizeProject } from "../../src/core/model.ts";
import { applyProjectOps, digestProject } from "../../src/core/projectOps.ts";
import { planOffline } from "../../src/core/ops/offlinePlanner.ts";
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

/** 造一个干净的基线工程：材质目录、一层、零对象。 */
function baseProject() {
  const p = createProject("验收工程");
  const scene = createScene("战场", 32, 24);
  p.scenes = [scene];
  return p;
}

// ------------------------------------------------------------------ 1
section("1. addObjects 基础新增与默认值补全");
{
  const p = baseProject();
  const sceneId = p.scenes[0].id;
  const r = applyProjectOps(p, [
    {
      op: "addObjects",
      sceneId,
      objects: [
        { name: "守卫甲", kind: "ACTOR", x: 64, y: 96 },
        { name: "守卫乙", kind: "ACTOR", x: 96, y: 96 },
      ],
    },
  ]);
  ok(r.ok, "批次应成功");
  eq(r.summary.length, 1, "应有一条摘要");
  eq(r.project!.scenes[0].objects.length, 2, "场景应有 2 个对象");
  eq(r.touchedIds.length, 2, "应 2 个受影响 id");
  const o = r.project!.scenes[0].objects[0];
  eq(o.visible, true, "visible 默认为 true");
  eq(o.rotation, 0, "rotation 默认为 0");
  eq(o.scaleX, 1, "scaleX 默认为 1");
  eq(o.layerId, p.scenes[0].layers[0].id, "layerId 默认为首层");
  eq(o.assetId, "", "未给素材时 assetId 为空串而不是 undefined");
}

// ------------------------------------------------------------------ 2
section("2. 事务性：一个非法操作 → 整批拒绝，原工程逐字节不变");
{
  const p = baseProject();
  const sceneId = p.scenes[0].id;
  const before = JSON.stringify(p);

  const r = applyProjectOps(p, [
    { op: "addObjects", sceneId, objects: [{ name: "合法对象", kind: "ACTOR", x: 10, y: 10 }] },
    {
      op: "addObjects",
      sceneId,
      objects: [{ name: "非法对象", kind: "ACTOR", x: 20, y: 20, modules: [{ defId: "move.不存在的模块" }] }],
    },
  ]);

  ok(!r.ok, "含非法操作的批次必须失败");
  eq(r.project, null, "失败时不返回任何工程");
  eq(JSON.stringify(p), before, "原工程必须逐字节不变");
  eq(r.rejections.length, 1, "应恰好 1 条拒绝");
  eq(r.rejections[0].index, 1, "拒绝项应指向第 1 个操作（下标定位）");
  eq(r.rejections[0].code, "unknown_module", "原因码应为 unknown_module");
  ok(r.rejections[0].hint.length > 10, "拒绝项必须带可读的修复建议 hint");
  eq(r.summary.length, 0, "失败时不应返回任何摘要（不允许假装成功）");
}

// ------------------------------------------------------------------ 3
section("3. attachModules：拒绝不存在的 defId");
{
  const p = baseProject();
  const sceneId = p.scenes[0].id;
  const add = applyProjectOps(p, [
    { op: "addObjects", sceneId, objects: [{ name: "守卫", kind: "ACTOR", x: 32, y: 32 }] },
  ]);
  const objId = add.project!.scenes[0].objects[0].id;

  const bad = applyProjectOps(add.project!, [
    { op: "attachModules", sceneId, targetId: objId, modules: [{ defId: "combat.编的模块" }] },
  ]);
  ok(!bad.ok, "编造的 defId 必须被拒");
  eq(bad.rejections[0].code, "unknown_module", "原因码 unknown_module");
  ok(bad.rejections[0].hint.includes("Project_Describe"), "hint 应指引模型去读目录");

  const realId = MODULES[0].id;
  const good = applyProjectOps(add.project!, [
    { op: "attachModules", sceneId, targetId: objId, modules: [{ defId: realId }] },
  ]);
  ok(good.ok, `真实模块 ${realId} 应装配成功`);
  eq(good.project!.scenes[0].objects[0].modules[0].defId, realId, "模块应挂上");
}

// ------------------------------------------------------------------ 4
section("4. 参数越界 / 拼错参数名 必须被拒");
{
  const withNum = MODULES.find(
    (m) => m.params.some((x) => x.type === "num" && x.min !== undefined && x.max !== undefined),
  );
  ok(!!withNum, "应存在带数值范围的模块可用于测试");
  if (withNum) {
    const numParam = withNum.params.find((x) => x.type === "num" && x.min !== undefined && x.max !== undefined)!;
    const p = baseProject();
    const sceneId = p.scenes[0].id;

    const over = applyProjectOps(p, [
      {
        op: "addObjects",
        sceneId,
        objects: [
          {
            name: "越界对象",
            kind: "ACTOR",
            x: 10,
            y: 10,
            modules: [{ defId: withNum.id, values: { [numParam.key]: String((numParam.max ?? 100) + 9999) } }],
          },
        ],
      },
    ]);
    ok(!over.ok, "参数越界必须被拒");
    eq(over.rejections[0].code, "bad_param", "原因码 bad_param");

    const typo = applyProjectOps(p, [
      {
        op: "addObjects",
        sceneId,
        objects: [
          { name: "拼错对象", kind: "ACTOR", x: 10, y: 10, modules: [{ defId: withNum.id, values: { 不存在的参数: "1" } }] },
        ],
      },
    ]);
    ok(!typo.ok, "拼错参数名必须被拒");
    eq(typo.rejections[0].code, "bad_param", "原因码 bad_param");

    const inRange = numParam.min ?? 0;
    const good = applyProjectOps(p, [
      {
        op: "addObjects",
        sceneId,
        objects: [
          { name: "合法对象", kind: "ACTOR", x: 10, y: 10, modules: [{ defId: withNum.id, values: { [numParam.key]: String(inRange) } }] },
        ],
      },
    ]);
    ok(good.ok, "合法参数应通过");
    eq(good.project!.scenes[0].objects[0].modules[0].values[numParam.key], String(inRange), "参数应写入并归一化为字符串");
  }
}

// ------------------------------------------------------------------ 5
section("5. 同一批次内 createScene + addObjects(sceneName)");
{
  const p = baseProject();
  const r = applyProjectOps(p, [
    { op: "createScene", scene: { name: "第二关", widthTiles: 20, heightTiles: 16 } },
    { op: "addObjects", sceneName: "第二关", objects: [{ name: "出生点", kind: "SPAWN", x: 32, y: 32 }] },
  ]);
  ok(r.ok, "同批次建场景后按名字放对象应成功");
  const sc = r.project!.scenes.find((s) => s.name === "第二关");
  ok(!!sc, "新场景应存在");
  eq(sc!.objects.length, 1, "新场景应有 1 个对象");
  eq(sc!.widthTiles, 20, "宽度应为 20 格（字段名必须是引擎的 widthTiles）");
  eq(sc!.heightTiles, 16, "高度应为 16 格");
  ok(sc!.layers.length > 0, "新场景必须带图层，否则对象无处安放");
  eq(typeof sc!.originX, "number", "originX 必须存在（引擎画布依赖它）");
  eq(sc!.onStartScript, "", "onStartScript 必须初始化");
}

// ------------------------------------------------------------------ 6
section("6. definePrefabs / updateObjects / deleteObjects");
{
  const p = baseProject();
  const sceneId = p.scenes[0].id;
  const r1 = applyProjectOps(p, [
    { op: "definePrefabs", prefabs: [{ name: "箭塔", kind: "PROP", blurb: "远程防御", tags: ["防御"] }] },
  ]);
  ok(r1.ok, "定义预制体应成功");
  eq(r1.project!.prefabs.length, 1, "应有 1 个预制体");
  ok(r1.project!.prefabs[0].id.startsWith("pf_"), "预制体 id 应带 pf_ 前缀");

  const r2 = applyProjectOps(r1.project!, [
    { op: "addObjects", sceneId, objects: [{ name: "塔", kind: "PROP", x: 40, y: 40 }] },
  ]);
  const objId = r2.project!.scenes[0].objects[0].id;

  const r3 = applyProjectOps(r2.project!, [
    { op: "updateObjects", sceneId, updates: [{ id: objId, patch: { name: "改名的塔", x: 88 } }] },
  ]);
  ok(r3.ok, "更新应成功");
  eq(r3.project!.scenes[0].objects[0].name, "改名的塔", "名字应更新");
  eq(r3.project!.scenes[0].objects[0].x, 88, "x 应更新");

  const r4 = applyProjectOps(r3.project!, [{ op: "deleteObjects", sceneId, ids: [objId] }]);
  ok(r4.ok, "删除应成功");
  eq(r4.project!.scenes[0].objects.length, 0, "对象应被删光");

  const r5 = applyProjectOps(r4.project!, [{ op: "deleteObjects", sceneId, ids: ["不存在"] }]);
  ok(!r5.ok, "删除不存在的对象必须失败");
  eq(r5.rejections[0].code, "unknown_object", "原因码 unknown_object");
}

// ------------------------------------------------------------------ 7
section("7. 离线规划器：无 key 也能产出真实可应用的 ops");
{
  const cases: Array<[string, string]> = [
    ["做一个塔防关卡，20x16，4个守卫", "tower_defense"],
    ["生成一个巡逻关卡，三个守卫", "patrol_level"],
    ["来一个开始界面", "hud"],
    ["给我一个空地", "empty_level"],
  ];
  for (const [prompt, expectIntent] of cases) {
    const plan = planOffline(prompt);
    eq(plan.mode, "offline", `${prompt} → mode 必须是 offline（诚实标注）`);
    eq(plan.intent, expectIntent as never, `${prompt} → 意图应为 ${expectIntent}`);
    ok(plan.ops.length > 0, `${prompt} → 应产出 ops`);
    ok(plan.rationale.length > 5, `${prompt} → 应有可读的 rationale`);

    const p = baseProject();
    const r = applyProjectOps(p, plan.ops);
    ok(r.ok, `${prompt} → 离线 ops 必须能真实应用（若失败说明降级是假的）`);
    if (r.ok) {
      ok(r.project!.scenes.length >= 2, `${prompt} → 应新增场景`);
      const total = r.project!.scenes.reduce((n, s) => n + s.objects.length, 0);
      ok(total > 0, `${prompt} → 应真的摆出对象`);
    }
  }

  const unknown = planOffline("帮我写一个寻路算法");
  eq(unknown.intent, "unknown", "无法识别时应返回 unknown");
  eq(unknown.ops.length, 0, "无法识别时不应产出任何 ops（不能瞎编）");
}

// ------------------------------------------------------------------ 8
section("8. digestProject：给模型的可操作摘要");
{
  const p = baseProject();
  const r = applyProjectOps(p, [
    { op: "addObjects", sceneId: p.scenes[0].id, objects: [{ name: "样本", kind: "ACTOR", x: 8, y: 8 }] },
  ]);
  const d = digestProject(r.project!);
  eq(d.scenes.length, 1, "摘要应列出 1 个场景");
  eq(d.scenes[0].sampleObjects.length, 1, "摘要应列出样本对象");
  eq(d.modules.length, MODULES.length, "摘要应包含完整模块目录");
  ok(Array.isArray(d.modules[0].params), "模块目录应带参数");
}

// ------------------------------------------------------------------ 9
/**
 * 往返测试：AI 生成的东西，必须活得过编辑器真实的「保存 → 打开」。
 *
 * normalizeProject 是编辑器加载 .bwproj 的唯一入口，它按白名单逐字段重建对象，
 * 任何不在白名单里的字段都会被静默丢掉 —— 不报错、不警告，下次打开就没了。
 * 所以「AI 写进工程」和「用户下次打开还在」是两件事，这条专门验第二件。
 *
 * 注意里面用的是 mustEq 而不是 eq：往返测试最危险的失败形态是两边**同时**是
 * undefined 然后判等通过。那条断言看起来绿的，其实什么也没验。
 */
section("9. 往返：AI 产物经 JSON 序列化 + normalizeProject 重载后仍然存活");
{
  function mustEq<T>(got: T | undefined, want: T, what: string): void {
    ok(got !== undefined, `${what} —— 读到 undefined，说明这个字段被加载闸门静默丢了`);
    ok(Object.is(got, want), `${what} —— 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
  }

  // 夹具故意造得「不好对付」：真素材、带参数的模块、预制体、UI 场景、脚本。
  // 只用空字段构造的话，就算加载器把字段全丢了，断言也会绿。
  const fixture = baseProject();
  fixture.assets.push({
    id: "asset-hero", name: "hero.png", kind: "IMAGE", src: "url", url: "https://x/hero.png",
    path: "Sprites/hero.png", width: 32, height: 32, group: "默认",
  } as (typeof fixture.assets)[number]);
  fixture.scripts["player.js"] = { name: "player.js", file: "Scripts/player.js", source: "// 玩家逻辑", lang: "js" };

  const plan = planOffline("做一个塔防关卡，20x16，4个守卫");
  const ops = [
    ...plan.ops,
    { op: "createScene", scene: { name: "HUD", ui: true, designW: 720, designH: 1280 } },
    {
      op: "addObjects",
      sceneName: "HUD",
      objects: [{ name: "分数面板", kind: "PROP", x: 1, y: 1, halfW: 2, halfH: 0.5 }],
    },
    {
      op: "addObjects",
      sceneName: "HUD",
      objects: [{
        name: "英雄", kind: "ACTOR", x: 5, y: 5, z: 7, halfW: 0.5, halfH: 0.5,
        assetId: "asset-hero",
        modules: [{ defId: "script.js", values: { script: "player.js" } }],
      }],
    },
    {
      op: "definePrefabs",
      prefabs: [{ name: "塔模板", kind: "ACTOR", assetId: "asset-hero", halfW: 0.5, halfH: 0.5 }],
    },
  ] as Parameters<typeof applyProjectOps>[1];

  const applied = applyProjectOps(fixture, ops);
  ok(applied.ok, `夹具批次应可应用：${JSON.stringify(applied.rejections)}`);
  const built = applied.project!;

  // 真实往返：字符串落盘 → 解析 → 走编辑器的加载闸门
  const json = JSON.stringify(built);
  ok(json.length > 2000, "序列化结果必须有实质内容（空工程会掩盖丢字段）");
  const reloaded = normalizeProject(JSON.parse(json));

  mustEq(reloaded.scenes.length, built.scenes.length, "重载后场景数");
  mustEq(reloaded.prefabs.length, built.prefabs.length, "重载后预制体数");
  mustEq(reloaded.assets.length, built.assets.length, "重载后素材数");
  mustEq(Object.keys(reloaded.scripts).length, Object.keys(built.scripts).length, "重载后脚本数");
  mustEq(JSON.stringify(reloaded.variables), JSON.stringify(built.variables), "重载后变量表");

  // 素材：id 与来源必须原样活着（丢了 user 的图就变成空白的方块）
  const ra = reloaded.assets.find((a) => a.id === "asset-hero");
  ok(!!ra, "素材 asset-hero 必须存活");
  if (ra) {
    mustEq(ra.path, "Sprites/hero.png", "素材路径");
    mustEq(ra.src, "url", "素材来源类型");
    mustEq(ra.width, 32, "素材宽度");
  }

  // 脚本：正文一个字都不能少
  const rs = reloaded.scripts["player.js"];
  ok(!!rs, "脚本 player.js 必须存活");
  if (rs) {
    mustEq(rs.source, "// 玩家逻辑", "脚本正文");
    mustEq(rs.lang, "js", "脚本语言（丢了会被当成 yarn 去解析 JS）");
  }

  // 预制体：模板本体必须完整
  const rp = reloaded.prefabs.find((x) => x.name === "塔模板");
  ok(!!rp, "预制体「塔模板」必须存活");
  if (rp) {
    mustEq(rp.assetId, "asset-hero", "预制体素材引用");
    mustEq(rp.halfH, 0.5, "预制体碰撞半高");
  }

  const hudBuilt = built.scenes.find((x) => x.name === "HUD")!;
  const hud = reloaded.scenes.find((x) => x.name === "HUD");
  ok(!!hud, "UI 场景「HUD」必须存活");
  if (hud) {
    // ui 标记丢了不会报错，只会变成世界场景，下次打开凭空多出一个空地
    mustEq((hud as unknown as Record<string, unknown>).ui === true, true, "UI 场景的 ui 标记");
    mustEq(hud.widthTiles, hudBuilt.widthTiles, "UI 场景宽度");
  }

  for (const a of built.scenes) {
    const b = reloaded.scenes.find((x) => x.id === a.id);
    ok(!!b, `场景「${a.name}」的 id 必须存活（面板按 id 定位）`);
    if (!b) continue;
    mustEq(b.objects.length, a.objects.length, `场景「${a.name}」对象数`);
    for (const oa of a.objects) {
      const ob = b.objects.find((x) => x.id === oa.id);
      ok(!!ob, `对象「${oa.name}」的 id 必须存活`);
      if (!ob) continue;
      mustEq(ob.name, oa.name, `对象「${oa.name}」名字`);
      mustEq(ob.kind, oa.kind, `对象「${oa.name}」类型`);
      mustEq(ob.x, oa.x, `对象「${oa.name}」x`);
      mustEq(ob.y, oa.y, `对象「${oa.name}」y`);
      mustEq(ob.halfW, oa.halfW, `对象「${oa.name}」碰撞半宽`);
      mustEq(ob.modules.length, oa.modules.length, `对象「${oa.name}」模块数`);
      for (const m of ob.modules) {
        ok(!!MODULES.find((d) => d.id === m.defId), `对象「${oa.name}」的模块 ${m.defId} 必须能解析`);
      }
    }
  }

  // 那一根「AI 真的写了有内容的东西」的钉子：英雄身上的 assetId 与脚本引用
  const hero = reloaded.scenes.find((x) => x.name === "HUD")?.objects.find((o) => o.name === "英雄");
  ok(!!hero, "对象「英雄」必须存活");
  if (hero) {
    mustEq(hero.assetId, "asset-hero", "英雄的素材引用（丢了就是白方块）");
    mustEq(hero.z, 7, "英雄的排序层级");
    const sm = hero.modules.find((m) => m.defId === "script.js");
    ok(!!sm, "英雄必须仍挂着 script.js 模块");
    if (sm) mustEq(String((sm.values as Record<string, unknown>).script ?? ""), "player.js", "英雄的脚本引用");
  }

  // 重载结果必须还能继续接受 AI 操作（不是只读残骸）
  const again = applyProjectOps(reloaded, [
    { op: "addObjects", sceneId: reloaded.scenes[0].id, objects: [{ name: "重载后追加", kind: "ACTOR", x: 4, y: 4 }] },
  ]);
  ok(again.ok, "重载后的工程必须仍可继续接受 AI 操作");
  eq(again.project!.scenes[0].objects.length, reloaded.scenes[0].objects.length + 1, "追加应生效");
}

// ------------------------------------------------------------------ 10
/**
 * 无 key 的诚实性。用户的原话是「不能假装调通」。
 * 这里验三件事：产物是真的、来源是明说的、够不着的地方明说够不着。
 */
section("10. 无 key 降级：产物是真的，来源是明的，边界是明说的");
{
  const plan = planOffline("做一个塔防关卡，20x16，4个守卫");
  eq(plan.mode, "offline", "结果必须自报 offline");
  ok(plan.rationale.length > 5, "必须给出人话理由，而不是空字符串");
  ok(plan.ops.length > 0, "能识别的意图必须真的产出 ops，而不是回一句空话");

  const keys = Object.keys(plan).sort().join(",");
  eq(keys, "intent,matched,mode,ops,rationale",
    "离线结果的字段集合必须严格固定（多出 usage/model/provider 就是伪造模型调用）");
  const blob = JSON.stringify(plan).toLowerCase();
  for (const forbidden of ["usage", "token", "provider", "status\":200"]) {
    ok(blob.indexOf(forbidden) === -1, `离线结果不得出现「${forbidden}」字样`);
  }

  // 够不着就明说，绝不瞎编 ops
  const unknown = planOffline("帮我写一个 A* 寻路算法");
  eq(unknown.intent, "unknown", "识不出的意图必须是 unknown");
  eq(unknown.ops.length, 0, "识不出就一条 ops 都不许产出");
  ok(unknown.rationale.length > 5, "识不出时也必须告诉用户下一步该干什么");

  // 空批次必须零副作用（这是上面那个 ok:false bug 的回归测试）
  const p = baseProject();
  const before = JSON.stringify(p);
  const r = applyProjectOps(p, unknown.ops);
  ok(r.ok, "空批次应当成功 —— 空操作不是错误");
  eq(r.rejections.length, 0, "空批次不该报拒绝");
  eq(JSON.stringify(r.project), before, "空批次必须零副作用");
}

// ------------------------------------------------------------------ 汇总
console.log(`\n${"-".repeat(52)}`);
if (failures === 0) {
  console.log(`PASS   ${checks} 项断言全部通过`);
  process.exit(0);
} else {
  console.error(`FAIL   ${failures}/${checks} 项断言失败`);
  process.exit(1);
}
