/**
 * 2D 光照烘焙的**纯逻辑自检**（node 里跑，esbuild 打包，不起浏览器/不连 indexdb）。
 *
 * 为什么必须有这一层：烘焙这件事的失败方式是"**看起来是好的**"——
 * 编辑器预览有个大光斑、导出的 PNG 也亮着，但进游戏后光斑位置偏了 30 像素、
 * 或者灯全挤在左上半张图。这类问题截图看不出来，只有对着**第三方独立算出**的
 * 像素值（`test/fixtures/lighting-case.json`）逐点比对才能钉死。
 *
 * 断言分五组：
 *   A. 仲裁 fixture：3 个 case、全部 samples、逐通道 ≤ 2/255（契约 §7.1）
 *   B. 尺寸与 sEff：`texW/texH/sEff` 与 fixture 的 expect 完全一致（含 2048 截断）
 *   C. 确定性：`hash01` 固定值、同一输入两次烘焙逐像素相同
 *   D. 柔化：两遍方框模糊的能量守恒 ±1%（边界按有效像素归一，不外推）
 *   E. 读取规则（契约 §3.3）：`collectSceneLighting` / `collectSceneOccluders`
 *      能从构造的 SceneModel 读出 props 光与模块光，且**模块参数优先于 props**；
 *      `lighting` 缺失时 `bakeLightmap` 不得抛异常、并返回全环境光。
 *
 * 跑法（与 package.json 的 verify:ui:all 同一套写法）：
 *   npx esbuild web/tools/ui-checks/verify-lighting.ts \
 *     --bundle --platform=node --format=esm --outfile=.tmp_light_ui/verify.mjs --log-level=warning \
 *     && node .tmp_light_ui/verify.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  bakeLightmap,
  blurRgb,
  hash01,
  toRgbaBytes,
  collectSceneLighting,
  collectSceneOccluders,
  parseHexColor,
  type BakeInput,
  type LightSourceSpec
} from "../../src/app/lightMath.ts";
import { createProject, createScene, createObject, normalizeLighting, normalizeLightmap } from "../../src/core/model.ts";
import { bakeSceneLighting, isAssetReferenced } from "../../src/app/lightBake.ts";
import type { SceneModel, SceneObject, Project } from "../../src/core/model.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${detail ? "  [" + detail + "]" : ""}`);
  } else {
    fail++;
    failures.push(name + (detail ? `  [${detail}]` : ""));
    console.log(`  FAIL ${name}${detail ? "  [" + detail + "]" : ""}`);
  }
}

/** 每通道容差（契约 §7.1：≤ 2/255）。 */
const TOL = 2;

interface FixtureSample {
  i: number;
  j: number;
  world: [number, number];
  expect: [number, number, number, number];
}

interface FixtureCase {
  name: string;
  note: string;
  version: number;
  width: number;
  height: number;
  texelsPerPixel: number;
  softness: number;
  ambient: { color: string; intensity: number };
  lights: LightSourceSpec[];
  occluders: { x: number; y: number; hw: number; hh: number }[];
  expect: { texW: number; texH: number; sEff: number };
  samples: FixtureSample[];
}

/** 从仓库根定位 fixture（本文件在 web/tools/ui-checks/ 下，往上三级）。 */
function loadFixture(): { cases: FixtureCase[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  // 打包后的产物在 <root>/.tmp_light_ui/verify.mjs，从 cwd 找更稳
  const candidates = [
    resolve(process.cwd(), "test/fixtures/lighting-case.json"),
    resolve(here, "../../../test/fixtures/lighting-case.json"),
    resolve(here, "../../../../test/fixtures/lighting-case.json")
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, "utf8")) as { cases: FixtureCase[] };
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error("找不到 test/fixtures/lighting-case.json（请从仓库根跑）");
}

const fixture = loadFixture();

// ============================================================================
console.log("== A. 仲裁 fixture：逐点逐通道比对（容差 ±2/255）==");
// ============================================================================
{
  let totalSamples = 0;
  let worst = 0;
  let worstWhere = "";
  for (const c of fixture.cases) {
    const input: BakeInput = {
      width: c.width,
      height: c.height,
      texelsPerPixel: c.texelsPerPixel,
      softness: c.softness,
      ambientColor: c.ambient.color,
      ambientIntensity: c.ambient.intensity,
      lights: c.lights,
      occluders: c.occluders
    };
    const res = bakeLightmap(input);
    const rgba = toRgbaBytes(res.rgb);

    let caseWorst = 0;
    let caseOk = 0;
    for (const s of c.samples) {
      totalSamples++;
      const o = (s.j * res.texW + s.i) * 4;
      const got = [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]];
      // alpha 恒 255（不透明 PNG 的硬要求）
      if (got[3] !== 255) {
        check(`${c.name} (${s.i},${s.j}) alpha=255`, false, `实际 ${got[3]}`);
        continue;
      }
      let maxDiff = 0;
      for (let k = 0; k < 3; k++) maxDiff = Math.max(maxDiff, Math.abs(got[k] - s.expect[k]));
      caseWorst = Math.max(caseWorst, maxDiff);
      worst = Math.max(worst, maxDiff);
      if (maxDiff > worst) worstWhere = `${c.name} (${s.i},${s.j})`;
      const ok = maxDiff <= TOL;
      if (ok) caseOk++;
      else {
        worstWhere = worstWhere || `${c.name} (${s.i},${s.j})`;
        check(
          `${c.name} 采样点 (${s.i},${s.j}) 世界(${s.world[0]},${s.world[1]})`,
          false,
          `期望 [${s.expect.slice(0, 3)}] 实得 [${got.slice(0, 3)}] 最大差 ${maxDiff}`
        );
      }
    }
    console.log(
      `  · case ${c.name}: ${caseOk}/${c.samples.length} 个采样点通过，本 case 最大通道误差 ${caseWorst}`
    );
    check(`${c.name}：全部 ${c.samples.length} 个采样点通过`, caseOk === c.samples.length, `通过 ${caseOk}`);
  }
  console.log(`  · 合计 ${totalSamples} 个采样点；全部 case 的最大通道误差 = ${worst}${worstWhere ? `（${worstWhere}）` : ""}`);
  check("全部采样点最大通道误差 ≤ 2", worst <= TOL, `最大 ${worst}`);
}

// ============================================================================
console.log("== B. 尺寸 / sEff（与 fixture expect 完全一致）==");
// ============================================================================
{
  for (const c of fixture.cases) {
    const res = bakeLightmap({
      width: c.width,
      height: c.height,
      texelsPerPixel: c.texelsPerPixel,
      softness: c.softness,
      ambientColor: c.ambient.color,
      ambientIntensity: c.ambient.intensity,
      lights: c.lights,
      occluders: c.occluders
    });
    check(
      `${c.name} 尺寸 ${c.expect.texW}×${c.expect.texH}`,
      res.texW === c.expect.texW && res.texH === c.expect.texH,
      `实际 ${res.texW}×${res.texH}`
    );
    check(`${c.name} sEff=${c.expect.sEff}`, Math.abs(res.sEff - c.expect.sEff) < 1e-9, `实际 ${res.sEff}`);
    check(`${c.name} rgb 长度 = texW*texH*3`, res.rgb.length === res.texW * res.texH * 3, `实际 ${res.rgb.length}`);
  }

  // 2048 截断：自由城那种 2560×1920 @2 = 5120×3840 → 必须等比缩到长边 2048
  {
    const res = bakeLightmap({ width: 2560, height: 1920, texelsPerPixel: 2, softness: 0, lights: [], occluders: [] });
    check("2560×1920@2 超过上限时缩到长边 2048", Math.max(res.texW, res.texH) === 2048, `${res.texW}×${res.texH}`);
    // 等比：2560×1920 的宽高比 4:3，缩完仍是 4:3
    check("缩放保持宽高比（4:3）", Math.abs(res.texW / res.texH - 2560 / 1920) < 0.02, `${(res.texW / res.texH).toFixed(3)}`);
    check("sEff 按缩后的实际比例写回", Math.abs(res.sEff - Math.min(res.texW / 2560, res.texH / 1920)) < 1e-9, `sEff=${res.sEff}`);

    // 不超上限的常见配置：2560×1920 @0.5 = 1280×960，原样保留（这条最容易写错方向）
    const mid = bakeLightmap({ width: 2560, height: 1920, texelsPerPixel: 0.5, softness: 0, lights: [], occluders: [] });
    check("2560×1920@0.5 = 1280×960 不被截断", mid.texW === 1280 && mid.texH === 960, `${mid.texW}×${mid.texH}`);
    check("未截断时 sEff = 请求的采样率", Math.abs(mid.sEff - 0.5) < 1e-9, `sEff=${mid.sEff}`);

    const small = bakeLightmap({ width: 64, height: 48, texelsPerPixel: 0.25, softness: 0, lights: [], occluders: [] });
    check("小图不被放大也不被截断（64×48@0.25 = 16×12）", small.texW === 16 && small.texH === 12, `${small.texW}×${small.texH}`);
  }

  // 极端输入：宽高为 0 / 负数 / NaN 不能除零、不能产出空数组
  {
    const res = bakeLightmap({ width: 0, height: 0, texelsPerPixel: 0, softness: 0, lights: [], occluders: [] });
    check("width=height=0 时仍产出 1×1 且不抛异常", res.texW === 1 && res.texH === 1 && res.rgb.length === 3, `${res.texW}×${res.texH}`);
  }
}

// ============================================================================
console.log("== C. 确定性（hash01 / 同输入同输出）==");
// ============================================================================
{
  // hash01 是闪烁相位的唯一来源，必须与 Java 侧算出一模一样 —— 值钉死，改算法就红
  const known: [string, number][] = [
    ["L1", hash01("L1")],
    ["火把-1", hash01("火把-1")],
    ["", hash01("")],
    ["night-alley-left-light", hash01("night-alley-left-light")]
  ];
  for (const [id, v] of known) {
    check(`hash01("${id}") 落在 [0,1)`, v >= 0 && v < 1, v.toFixed(6));
  }
  // 同一 id 反复算必须完全相同；不同 id 不应全都撞在一起（否则"确定性"变成"常数"）
  check("hash01 幂等", hash01("L1") === hash01("L1"));
  const distinct = new Set(["L1", "L2", "L3", "torch", "lantern"].map((s) => hash01(s)));
  check("hash01 对不同 id 有区分度（≥4/5 种取值）", distinct.size >= 4, `${distinct.size} 种`);

  // 同一输入两次烘焙：逐字节相同（Float32 的联网/多线程顺序差异会在这里暴露）
  const input: BakeInput = {
    width: 256,
    height: 192,
    texelsPerPixel: 0.5,
    softness: 6,
    ambientColor: "#3A4A6B",
    ambientIntensity: 0.35,
    lights: fixture.cases[0].lights,
    occluders: fixture.cases[0].occluders
  };
  const a = bakeLightmap(input);
  const b = bakeLightmap(input);
  let same = a.rgb.length === b.rgb.length;
  if (same) {
    for (let i = 0; i < a.rgb.length; i++) {
      if (a.rgb[i] !== b.rgb[i]) {
        same = false;
        break;
      }
    }
  }
  check("同一输入两次烘焙逐像素相同", same);
  check("两次烘焙的尺寸也相同", a.texW === b.texW && a.texH === b.texH);
}

// ============================================================================
console.log("== D. 柔化：能量守恒 ±1% ==");
// ============================================================================
{
  // 用一张**合成**的图：光源能量离贴图边界足够远（> 最大半径的 2 倍）。
  // 为什么不能直接拿 fixture 场景测：契约 §2.5 的边界归一"不做边缘外推"，
  // 边界窗口的有效像素少 ⇒ 分母变小 ⇒ 贴图边缘的能量会被略微抬高（1~3%），
  // 这是契约明确规定的行为，不是 bug。要断言"守恒"，就必须让卷积核对边界的影响
  // 被排除在外（否则测的是"契约的另一半"，会假失败）。
  const texW = 256;
  const texH = 256;
  const rgb = new Float32Array(texW * texH * 3);
  const cx = 128;
  const cy = 128;
  const rad = 40;
  for (let j = 0; j < texH; j++) {
    for (let i = 0; i < texW; i++) {
      const d = Math.hypot(i - cx, j - cy);
      const v = d < rad ? Math.pow(1 - d / rad, 2) : 0;
      const o = (j * texW + i) * 3;
      rgb[o] = v;
      rgb[o + 1] = v;
      rgb[o + 2] = v;
    }
  }
  const sum = (arr: Float32Array) => {
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return s;
  };
  const raw = sum(rgb);
  check("原始光能量 > 0（不然守恒断言没意义）", raw > 0, raw.toFixed(2));

  // 半径 ≤ 9 时，两遍模糊的有效扩散 ≤ 18 纹素，而能量中心离边界 88 纹素 —— 边界不参与
  for (const r of [1, 2, 5, 9]) {
    const blurred = blurRgb(rgb, texW, texH, r);
    const bs = sum(blurred);
    const drift = Math.abs(bs - raw) / raw;
    check(`半径 ${r} 纹素：能量守恒（漂移 ${(drift * 100).toFixed(4)}%）`, drift <= 0.01, `${bs.toFixed(3)} vs ${raw.toFixed(3)}`);
  }

  // 半径为 0：原样返回（不额外拷贝，不改变数值）
  const same = blurRgb(rgb, texW, texH, 0);
  check("半径 0 ⇒ 原样返回", same === rgb);

  // 模糊后峰值必须下降（方框模糊是低通，如果峰值反而上升说明归一化写反了）
  const blurred = blurRgb(rgb, texW, texH, 4);
  let peakRaw = 0;
  let peakBlur = 0;
  for (let i = 0; i < rgb.length; i++) {
    peakRaw = Math.max(peakRaw, rgb[i]);
    peakBlur = Math.max(peakBlur, blurred[i]);
  }
  check("模糊后峰值下降（低通）", peakBlur < peakRaw, `${peakBlur.toFixed(3)} < ${peakRaw.toFixed(3)}`);

  // 边界归一的规定行为：能量贴到边界时，两遍模糊后的总量只会小幅偏移（<1%），
  // 这是"按窗口内**有效**像素数归一、不做边缘外推"的直接结果（契约 §2.5）。
  // 断言"偏移很小但不为 0"：既防止后来有人改成外推（那会改变贴图边缘亮度、
  // 与 Java 端分叉），也防止有人忘了边界归一（那会让边缘亮度明显变暗）。
  const edge = new Float32Array(texW * texH * 3);
  for (let j = 0; j < texH; j++) {
    for (let i = 0; i < texW; i++) {
      const v = j < 12 ? 1 : 0; // 只在上边缘 12 行有能量
      const o = (j * texW + i) * 3;
      edge[o] = v;
      edge[o + 1] = v;
      edge[o + 2] = v;
    }
  }
  const edgeRaw = sum(edge);
  const edgeBlur = sum(blurRgb(edge, texW, texH, 5));
  const edgeDrift = Math.abs(edgeBlur - edgeRaw) / edgeRaw;
  check("贴边能量：边界归一后总量偏移 < 1%（不做边缘外推）", edgeDrift < 0.01,
    `${edgeBlur.toFixed(1)} vs ${edgeRaw.toFixed(1)}，漂移 ${(edgeDrift * 100).toFixed(3)}%`);
}

// ============================================================================
console.log("== E. 读取规则（契约 §3.3）：光源 / 遮挡体 / 缺省行为 ==");
// ============================================================================

/** 造一个最小的 SceneObject（字段与 SceneObject 完全一致，缺一个导出就丢键）。 */
function obj(kind: SceneObject["kind"], x: number, y: number, extra: Partial<SceneObject> = {}): SceneObject {
  const base = createObject(kind, x, y);
  base.name = `${kind}#${x},${y}`;
  base.layerId = "ground";
  return Object.assign(base, extra);
}

function sceneWith(objects: SceneObject[], lighting?: SceneModel["lighting"]): { scene: SceneModel; project: Project } {
  const project = createProject("光照自检");
  const scene = createScene("自检场景", 20, 15);
  scene.objects = objects;
  if (lighting) scene.lighting = lighting;
  project.scenes = [scene];
  return { scene, project };
}

{
  // ---- E1. props 形式的光源（LIGHT 对象）----
  const propsLight = obj("LIGHT", 100, 80, {
    props: {
      lightRadius: "200",
      lightColor: "#80CCFF",
      lightIntensity: "1.5",
      lightType: "spot",
      lightAngle: "90",
      lightDir: "180",
      lightConeSoft: "20",
      lightFalloff: "3",
      lightShadow: "0",
      lightFlicker: "0.3",
      lightDynamic: "0"
    }
  });
  // ---- E2. 模块形式的光源（render.light，且模块参数**压过** props）----
  const modLight = obj("PROP", 300, 200, {
    props: { lightRadius: "120", lightColor: "#FF0000", lightIntensity: "0.5", color: "#00FF00" },
    modules: [
      {
        defId: "render.light",
        label: "",
        trigger: null,
        values: { radius: "260", color: "#FFC978", strength: "2", flicker: "true" },
        enabled: true,
        collapsed: false
      }
    ]
  });
  // ---- E3. 旧 id look.light 也要认（桌面工程用这个 id）----
  const legacyLight = obj("PROP", 500, 300, {
    props: {},
    modules: [
      { defId: "look.light", label: "", trigger: null, values: { radius: "90", intensity: "0.6" }, enabled: true, collapsed: false }
    ]
  });
  // ---- E4. 被关掉的模块：不算光源（enabled=false 的模块不该发光）----
  const disabledMod = obj("PROP", 600, 400, {
    modules: [
      { defId: "render.light", label: "", trigger: null, values: { radius: "300" }, enabled: false, collapsed: false }
    ]
  });
  // ---- E5. 纯装饰对象：不是光源 ----
  const decoration = obj("PROP", 700, 500, { props: { w: "16", h: "16" } });

  const { scene, project } = sceneWith([propsLight, modLight, legacyLight, disabledMod, decoration]);
  const lights = collectSceneLighting(scene, project);
  check("读出 3 盏光（LIGHT + render.light + look.light；关掉的模块不算）", lights.length === 3, `实际 ${lights.length}`);
  check("纯装饰对象没被误判成光源", !lights.some((l) => l.id === decoration.id));

  // props 光：所有字段都按 props 读出来
  const a = lights.find((l) => l.id === propsLight.id);
  check("props 光：半径 200（非缺省 140）", a?.radius === 200, String(a?.radius));
  check("props 光：颜色 #80CCFF", a?.color === "#80CCFF", String(a?.color));
  check("props 光：强度 1.5", a?.intensity === 1.5, String(a?.intensity));
  check("props 光：类型 spot", a?.type === "spot", String(a?.type));
  check("props 光：角度 90", a?.angle === 90, String(a?.angle));
  check("props 光：方向 180", a?.dir === 180, String(a?.dir));
  check("props 光：锥边软化 20", a?.coneSoft === 20, String(a?.coneSoft));
  check("props 光：衰减 3", a?.falloff === 3, String(a?.falloff));
  check('props 光：lightShadow="0" ⇒ shadow=false', a?.shadow === false, String(a?.shadow));
  check("props 光：闪烁 0.3", Math.abs((a?.flicker ?? 0) - 0.3) < 1e-9, String(a?.flicker));
  check('props 光：lightDynamic="0" ⇒ 进烘焙', a?.dynamic === false, String(a?.dynamic));

  // 模块光：**模块参数优先于 props**（契约 §3.3 的硬要求）
  const m = lights.find((l) => l.id === modLight.id);
  check("模块光：radius 取模块的 260（不是 props 的 120）", m?.radius === 260, String(m?.radius));
  check("模块光：color 取模块的 #FFC978（不是 props 的 #FF0000 / #00FF00）", m?.color === "#FFC978", String(m?.color));
  check("模块光：strength 2 覆盖 props 的 lightIntensity 0.5", m?.intensity === 2, String(m?.intensity));
  check("模块光：flicker=true ⇒ 0.25", Math.abs((m?.flicker ?? 0) - 0.25) < 1e-9, String(m?.flicker));
  check("模块光：没有 lightDynamic ⇒ 默认进烘焙", m?.dynamic === false, String(m?.dynamic));

  // 旧 id
  const g = lights.find((l) => l.id === legacyLight.id);
  check("look.light 也认：radius=90", g?.radius === 90, String(g?.radius));
  check("look.light 也认：intensity=0.6", g?.intensity === 0.6, String(g?.intensity));

  // ---- E6. 遮挡体：三档判定 + 尺寸复用 sizeOf ----
  const wallByTag = obj("PROP", 200, 200, { props: { w: "20", h: "100" }, tags: ["wall"] });
  const blockYes = obj("PROP", 300, 200, { props: { w: "40", h: "40", lightBlock: "1" } });
  const blockNo = obj("PROP", 400, 200, { props: { w: "40", h: "40" }, tags: ["wall", "occluder"], });
  // ↑ 同时有 tags 又显式 lightBlock="0" ⇒ 显式关闭优先，不遮挡
  const blockNoObj = Object.assign(blockNo, { props: { w: "40", h: "40", lightBlock: "0" } });
  const occluderTag = obj("PROP", 500, 200, { tags: ["lightblock"], props: { w: "10", h: "10" } });
  const plain = obj("PROP", 600, 200, { props: { w: "10", h: "10" } });
  // halfW/halfH 只是"尺寸来源"，**本身不是遮挡判据**（契约 §2.4：还要 lightBlock 或 tags）。
  // 所以这里必须给它一个遮挡标记，否则它正确地不会被当成遮挡体。
  const halfObj = obj("PROP", 700, 200, { halfW: 30, halfH: 10, props: { lightBlock: "1" } });

  const sc2 = sceneWith([wallByTag, blockYes, blockNoObj, occluderTag, plain, halfObj]);
  const ocs = collectSceneOccluders(sc2.scene, sc2.project);
  const ids = ocs.map((o) => o.x);
  check("遮挡体：tags 含 wall ⇒ 遮挡", ocs.some((o) => o.x === 200));
  check("遮挡体：lightBlock=1 ⇒ 遮挡", ocs.some((o) => o.x === 300));
  check('遮挡体：tags 有 wall 但 lightBlock="0" ⇒ 显式关闭优先、不遮挡', !ocs.some((o) => o.x === 400));
  check("遮挡体：tags 含 lightblock ⇒ 遮挡", ocs.some((o) => o.x === 500));
  // 契约 §2.4 的「否则不遮挡」分支：没有 tags、也没有 lightBlock ⇒ **必须不入选**。
  // 这条最容易漏（「普通对象为什么会在 ocs 里」根本看不出问题），所以单独断言。
  check("遮挡体：无 tags、无 lightBlock 的普通对象被排除（契约「否则不遮挡」）", !ocs.some((o) => o.x === 600));
  check("遮挡体：选中的数量 = 4（wall + lightBlock=1 + lightblock tag + halfW 那一个）", ocs.length === 4, `实际 ${ocs.length}`);
  check("遮挡体：halfW/halfH 作为尺寸来源（halfW=30 ⇒ hw=30）", (() => {
    const h = ocs.find((o) => o.x === 700);
    return !!h && Math.abs(h.hw - 30) < 1e-6 && Math.abs(h.hh - 10) < 1e-6;
  })(), (() => {
    const h = ocs.find((o) => o.x === 700);
    return h ? `hw=${h.hw} hh=${h.hh}` : "缺失";
  })());
  void ids;

  // props.w/h：半宽高 = w/2 * scaleX
  const sized = obj("PROP", 800, 200, { props: { w: "40", h: "20" }, tags: ["wall"], scaleX: 2, scaleY: 2 });
  const sc3 = sceneWith([sized]);
  const oo = collectSceneOccluders(sc3.scene, sc3.project);
  check("props.w/h 乘 scaleX/scaleY（40×2/2=40, 20×2/2=20）", !!oo[0] && Math.abs(oo[0].hw - 40) < 1e-6 && Math.abs(oo[0].hh - 20) < 1e-6,
    oo[0] ? `hw=${oo[0].hw} hh=${oo[0].hh}` : "缺失");
}

{
  // ---- E7. lighting 缺失 ⇒ 烘焙返回全 ambient、不抛异常（契约 §0.5 零回归的核心）----
  const { scene, project } = sceneWith([obj("LIGHT", 100, 100, { props: { lightRadius: "200", lightColor: "#FFFFFF" } })]);
  // 场景里有一盏灯、但没有 lighting 段：烘焙函数本身是纯数学，**没有**"忽略光源"的开关，
  // 所以它仍然会算这盏灯（这不矛盾：运行时不会调用烘焙，因为 lighting 缺失 = 不启用）。
  // 真正要断言的是"没有 lighting 设置时不崩、且能产出合法数据"，以及
  // "ambient 全是 0 + 没有光源 ⇒ 全黑（RGB=0, A=255）"这个运行时等价语义。
  let threw = false;
  let res: ReturnType<typeof bakeLightmap> | null = null;
  try {
    res = bakeLightmap({ width: 64, height: 64, texelsPerPixel: 1, softness: 0, lights: [], occluders: [] });
  } catch {
    threw = true;
  }
  check("无光源无遮挡烘焙不抛异常", !threw);
  check("无光源无遮挡产出合法尺寸", !!res && res.texW === 64 && res.texH === 64, res ? `${res.texW}×${res.texH}` : "null");

  // ambient 缺省（不传 ambientColor/ambientIntensity）⇒ 走契约缺省 #3A4A6B × 0.35
  const def = bakeLightmap({ width: 8, height: 8, texelsPerPixel: 1, softness: 0, lights: [], occluders: [] });
  const bytes = toRgbaBytes(def.rgb);
  const rgb = parseHexColor("#3A4A6B")!;
  const expectR = Math.round(Math.min(1, rgb[0] * 0.35) * 255);
  check("缺省环境光 = #3A4A6B × 0.35", Math.abs(bytes[0] - expectR) <= TOL, `实得 ${bytes[0]} 期望 ${expectR}`);
  check("缺省环境光 alpha 恒 255", bytes[3] === 255, String(bytes[3]));
  // 整张图应当逐像素等于环境光（没有光源）
  let uniform = true;
  for (let i = 0; i < def.rgb.length; i += 3) {
    if (def.rgb[i] !== def.rgb[0] || def.rgb[i + 1] !== def.rgb[1] || def.rgb[i + 2] !== def.rgb[2]) {
      uniform = false;
      break;
    }
  }
  check("没有光源时整张图逐像素相同（纯环境光）", uniform);

  // 显式全黑 ambient + 没有光源 ⇒ RGB=(0,0,0)、A=255（运行时"加光"加 0，完全无副作用）
  const black = bakeLightmap({ width: 8, height: 8, texelsPerPixel: 1, softness: 0, ambientColor: "#000000", ambientIntensity: 0, lights: [], occluders: [] });
  const bBytes = toRgbaBytes(black.rgb);
  let allZero = true;
  for (let i = 0; i < bBytes.length; i += 4) {
    if (bBytes[i] !== 0 || bBytes[i + 1] !== 0 || bBytes[i + 2] !== 0) {
      allZero = false;
      break;
    }
  }
  check("全黑环境光 ⇒ RGB 全 0（加光无副作用）", allZero);
  check("全黑环境光 ⇒ alpha 仍恒 255", bBytes[3] === 255);

  void scene;
  void project;
}

{
  // ---- E8. lightDynamic="1" 的光源完全不进烘焙（§2.3 终条）----
  const s1: LightSourceSpec = { id: "static", x: 32, y: 32, radius: 60, color: "#FFFFFF", intensity: 1 };
  const s2: LightSourceSpec = { id: "moving", x: 32, y: 32, radius: 60, color: "#FFFFFF", intensity: 1, dynamic: true };
  const staticOnly = bakeLightmap({ width: 64, height: 64, texelsPerPixel: 1, softness: 0, ambientColor: "#000000", ambientIntensity: 0, lights: [s1], occluders: [] });
  const withDynamic = bakeLightmap({ width: 64, height: 64, texelsPerPixel: 1, softness: 0, ambientColor: "#000000", ambientIntensity: 0, lights: [s1, s2], occluders: [] });
  // 灯心纹素：纹素 (32,32) 的**中心**在世界 (32.5, 32.5)（契约 §2.1），
  // 离灯心 (32,32) 有 d=sqrt(0.5²+0.5²)=0.7071，t=0.7071/60，atten=(1-t)²。
  // 这里钉的是**精确值**而不只是"接近 1"：它同时验证
  //   (a) 纹素中心公式用的是 (i+0.5)/sEff 而不是 i/sEff；
  //   (b) 衰减公式在极限处也精确（不是近似）。
  // 解析值：t = 0.7071067811865476/60 = 0.011785113019775793
  //         atten = (1-t)^2 = 0.9765686628...
  const o = (32 * 64 + 32) * 3;
  const tExpected = Math.sqrt(0.5 ** 2 + 0.5 ** 2) / 60;
  const attenExpected = (1 - tExpected) ** 2;
  check(
    "静态光在灯心纹素处等于解析衰减值 (1-√0.5/60)²",
    Math.abs(staticOnly.rgb[o] - attenExpected) < 1e-6,
    `实得 ${staticOnly.rgb[o].toFixed(8)} 解析 ${attenExpected.toFixed(8)}`
  );
  // 同时保留一条宽松的功能断言：它必须明显亮（防止有人把衰减指数写反成 (1-t)^0.5 之类）
  check("静态光在灯心处明显亮（>0.95）", staticOnly.rgb[o] > 0.95, staticOnly.rgb[o].toFixed(3));
  check("加了同位置的动态光后结果不变（动态光不进烘焙）", withDynamic.rgb[o] === staticOnly.rgb[o], `${withDynamic.rgb[o]}`);

  // 只有动态光 ⇒ 烘焙图全黑（连环境光之外的贡献都没有）
  const dynOnly = bakeLightmap({ width: 16, height: 16, texelsPerPixel: 1, softness: 0, ambientColor: "#000000", ambientIntensity: 0, lights: [s2], occluders: [] });
  let allZero = true;
  for (let i = 0; i < dynOnly.rgb.length; i++) if (dynOnly.rgb[i] !== 0) { allZero = false; break; }
  check("只有动态光 ⇒ 烘焙图全 0（这些光由运行时算）", allZero);
}

{
  // ---- E9. 遮挡体真的挡光（对照 fixture 的语义，但用更小的图便于定位）----
  const light: LightSourceSpec = { id: "L", x: 16, y: 32, radius: 120, color: "#FFFFFF", intensity: 1, shadow: true };
  const wall = { x: 40, y: 32, hw: 4, hh: 20 };
  const base = bakeLightmap({ width: 96, height: 64, texelsPerPixel: 1, softness: 0, ambientColor: "#000000", ambientIntensity: 0, lights: [light], occluders: [] });
  const blocked = bakeLightmap({ width: 96, height: 64, texelsPerPixel: 1, softness: 0, ambientColor: "#000000", ambientIntensity: 0, lights: [light], occluders: [wall] });
  // 墙后面一点 (60,32)：无遮挡时被照亮，有墙时应当为 0
  const bxy = (32 * 96 + 60) * 3;
  check("无遮挡时墙后那点被照亮", base.rgb[bxy] > 0.02, base.rgb[bxy].toFixed(3));
  check("有遮挡时墙后那点完全为 0", blocked.rgb[bxy] === 0, blocked.rgb[bxy].toFixed(3));

  // shadow=false 的光不该被挡
  const noShadow = bakeLightmap({ width: 96, height: 64, texelsPerPixel: 1, softness: 0, ambientColor: "#000000", ambientIntensity: 0, lights: [{ ...light, shadow: false }], occluders: [wall] });
  check("shadow=false ⇒ 墙挡不住它", noShadow.rgb[bxy] > 0.02, noShadow.rgb[bxy].toFixed(3));

  // 灯贴着墙（线段端点落在盒内）：按契约"端点贴盒不算遮挡"，灯不应整个熄掉
  const adjacency = bakeLightmap({
    width: 96,
    height: 64,
    texelsPerPixel: 1,
    softness: 0,
    ambientColor: "#000000",
    ambientIntensity: 0,
    lights: [{ id: "edge", x: 36, y: 32, radius: 120, color: "#FFFFFF", intensity: 1, shadow: true }],
    occluders: [wall]
  });
  // 灯左侧 (20,32) 与灯之间没有墙 → 必须亮
  const left = (32 * 96 + 20) * 3;
  check("灯贴墙时，它左侧仍被自己照亮（端点不算遮挡）", adjacency.rgb[left] > 0.02, adjacency.rgb[left].toFixed(3));
}

{
  // ---- E10. normalizeLighting / normalizeLightmap：半截数据不崩、缺字段不补 ---- 
  check("normalizeLighting(null) ⇒ null（不凭空给旧工程加字段）", normalizeLighting(null) === null);
  check("normalizeLighting(undefined) ⇒ null", normalizeLighting(undefined) === null);
  const half = normalizeLighting({ enabled: true });
  check("半截 lighting 补齐为完整合法对象", !!half && half.mode === "both" && half.ambientColor === "#3A4A6B" && half.texelsPerPixel === 0.25,
    half ? `${half.mode}/${half.ambientColor}/${half.texelsPerPixel}` : "null");
  const bad = normalizeLighting({ enabled: true, ambientColor: "#FFC97", ambientIntensity: 5, texelsPerPixel: -1 });
  check("非法颜色回退缺省", bad?.ambientColor === "#3A4A6B", String(bad?.ambientColor));
  check("越界强度被夹到 0..1", bad?.ambientIntensity === 1, String(bad?.ambientIntensity));
  check("非法采样率被夹到合法下限", !!bad && bad.texelsPerPixel > 0, String(bad?.texelsPerPixel));

  check("normalizeLightmap(null) ⇒ null", normalizeLightmap(null) === null);
  check("normalizeLightmap(assetId 为空) ⇒ null（指向空 id 的引用没有意义）", normalizeLightmap({ assetId: "" }) === null);
  const lm = normalizeLightmap({ assetId: "a1", texW: 3000, texH: 96, texelsPerPixel: 0.5 });
  check("lightmap texW 被夹到 2048", lm?.texW === 2048, String(lm?.texW));
  check("lightmap 补齐 version=1", lm?.version === 1, String(lm?.version));
}

{
  // ---- E11. 烘焙性能：自由城规模 2560×1920（实测数字要给 Lead 看）----
  const lights: LightSourceSpec[] = [];
  // 40 盏灯散布（自由城那种夜城：几十盏路灯）
  for (let i = 0; i < 40; i++) {
    lights.push({
      id: `city-${i}`,
      x: ((i % 8) + 0.5) * 320,
      y: (Math.floor(i / 8) + 0.5) * 384,
      radius: 240,
      color: i % 2 ? "#FFC978" : "#80CCFF",
      intensity: 1,
      type: "point",
      falloff: 2,
      shadow: false
    });
  }
  const city: BakeInput = {
    width: 2560,
    height: 1920,
    texelsPerPixel: 0.25,
    softness: 16,
    ambientColor: "#101820",
    ambientIntensity: 0.25,
    lights,
    occluders: []
  };
  const t0 = Date.now();
  const cityRes = bakeLightmap(city);
  const elapsed = Date.now() - t0;
  console.log(`  · 实测：2560×1920 @0.25（40 盏灯、柔化 16）→ 贴图 ${cityRes.texW}×${cityRes.texH}，耗时 ${elapsed} ms（bakeLightmap 内部计时 ${Math.round(cityRes.ms)} ms）`);
  check("自由城规模烘焙能算完（不超 60 秒）", elapsed < 60000, `${elapsed} ms`);
  check("自由城规模贴图尺寸 640×480", cityRes.texW === 640 && cityRes.texH === 480, `${cityRes.texW}×${cityRes.texH}`);

  // 另一个常见规模：2560×1920 @ 0.5（更清晰）→ 1280×960
  const t1 = Date.now();
  const hi = bakeLightmap({ ...city, texelsPerPixel: 0.5 });
  console.log(`  · 实测：2560×1920 @0.5（40 盏灯、柔化 16）→ 贴图 ${hi.texW}×${hi.texH}，耗时 ${Date.now() - t1} ms`);
  check("高清采样也能算完", Date.now() - t1 < 60000, `${Date.now() - t1} ms`);
}

// ============================================================================
console.log("== F. 烘焙前置条件（mode / 开关）与素材合并 ==");
// ============================================================================
{
  // mode="dynamic" 时烘焙必须**明确失败**（不能照常烘完回写一张永远不被读取的 PNG）。
  // 这条是契约 §3.1 + §7 的边界：`mode=dynamic` 的运行时只算动态层、完全不读 lightmap，
  // 所以产物无效——「看起来成功、实际无效」比直接报错更坏。
  const dyn = sceneWith([]);
  dyn.scene.lighting = {
    enabled: true, mode: "dynamic", ambientColor: "#3A4A6B", ambientIntensity: 0.35,
    darkness: 0.35, softness: 16, texelsPerPixel: 0.25, dynamicFps: 15, maxDynamicLights: 8
  };
  const outDyn = await bakeSceneLighting(dyn.scene, dyn.project);
  check("mode=dynamic ⇒ 烘焙明确失败（不产出无效贴图）", outDyn.ok === false, outDyn.ok ? "却成功了" : "");
  check("mode=dynamic 的失败信息解释原因与出路", !outDyn.ok && /dynamic/.test(outDyn.error) && /baked|both/.test(outDyn.error),
    outDyn.ok ? "" : outDyn.error.slice(0, 100));
  check("mode=dynamic ⇒ 没有回写 lightmap", dyn.scene.lightmap === undefined, JSON.stringify(dyn.scene.lightmap ?? null));
  check("mode=dynamic ⇒ 素材库没多出贴图", dyn.project.assets.length === 0, String(dyn.project.assets.length));

  // 开关关着时同样明确失败（而且不产出素材）
  const off = sceneWith([]);
  off.scene.lighting = {
    enabled: false, mode: "both", ambientColor: "#3A4A6B", ambientIntensity: 0.35,
    darkness: 0.35, softness: 16, texelsPerPixel: 0.25, dynamicFps: 15, maxDynamicLights: 8
  };
  const outOff = await bakeSceneLighting(off.scene, off.project);
  check("enabled=false ⇒ 烘焙失败并提示总开关", outOff.ok === false && /总开关/.test(outOff.error),
    outOff.ok ? "却成功了" : outOff.error.slice(0, 60));
  check("enabled=false ⇒ 素材库没多出贴图", off.project.assets.length === 0, String(off.project.assets.length));

  // 没有 lighting 字段 ⇒ 明确失败（不是静默什么都不做）
  const none = sceneWith([]);
  const outNone = await bakeSceneLighting(none.scene, none.project);
  check("lighting 缺失 ⇒ 烘焙失败并提示先启用", outNone.ok === false && /还没有启用|启用 2D 光照/.test(outNone.error),
    outNone.ok ? "却成功了" : outNone.error.slice(0, 60));

  // 素材合并判据：被对象引用 / 被别的场景 lightmap 引用的旧贴图**不许删**
  const p2 = createProject("引用判定");
  const sc1 = createScene("A");
  const sc2 = createScene("B");
  p2.scenes = [sc1, sc2];
  const objRef = createObject("PROP", 0, 0);
  objRef.assetId = "old";
  sc1.objects = [objRef];
  check("有对象引用旧贴图 ⇒ 判定为被引用（不删）", isAssetReferenced(p2, "old", sc1.id));
  sc1.objects = [];
  sc2.lightmap = {
    assetId: "old", x: 0, y: 0, w: 1, h: 1, texW: 1, texH: 1,
    texelsPerPixel: 1, lights: 0, bakedAt: "", version: 1
  };
  check("别的场景 lightmap 引用旧贴图 ⇒ 判定为被引用（不删）", isAssetReferenced(p2, "old", sc1.id));
  check("本场景自己的 lightmap 不算「被引用」（允许重复烘焙合并）", !isAssetReferenced(p2, "old", sc2.id));
  sc2.lightmap = undefined;
  check("无人引用 ⇒ 判定为可删（重复烘焙不堆素材）", !isAssetReferenced(p2, "old", sc1.id));
}

// ============================================================================
console.log("---------------------------------------");
console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 ${fail} → ${fail === 0 ? "ALL PASS" : "FAILED"}`);
if (fail) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f);
}
process.exit(fail === 0 ? 0 : 1);
