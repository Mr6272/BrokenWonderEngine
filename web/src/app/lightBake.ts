/**
 * 一键烘焙：把场景光照算成 PNG → 注册成工程素材 → 回写 `scene.lightmap`。
 *
 * 分工（刻意拆成两个文件）：
 *   - `app/lightMath.ts`：纯数学，不碰 DOM，能被 node 里的自检直接跑；
 *   - 本文件：只做"和编辑器/浏览器打交道"的部分 —— 离屏 canvas、PNG 编码、
 *     IndexedDB 素材、`scene.lightmap` 回写、事件广播、统计与警告。
 *
 * 为什么必须用离屏 canvas 的 `toBlob` 而不是手写 PNG 编码器：
 *   手写编码器要自己实现 zlib + 扫描线过滤，一旦与自己实现的解码路径有细微差异，
 *   导出到 Java 端（ImageIO 读）就是"编辑器能看、游戏里读不出"。让浏览器编码，
 *   产出就是标准 PNG —— 与用户导入的其它图走完全同一条资产链路。
 *
 * 全流程 try/catch：面板上点一下按钮不该因为"IndexedDB 满了 / canvas 为 null"抛异常
 * 把整个编辑器带下去。失败返回 `{ ok:false, error }`，由面板显示。
 */

import type { Project, SceneModel } from "../core/model.ts";
import { store } from "../core/store.ts";
import { addRasterAsset, deleteAsset } from "../data/assets.ts";
import {
  bakeLightmap,
  bakeInputFromScene,
  collectSceneLighting,
  toRgbaBytes,
  MAX_TEX,
  type LightSourceSpec,
  type OccluderSpec
} from "./lightMath.ts";

/** 烘焙成功后返回给面板的统计（面板直接照抄显示）。 */
export interface BakeStats {
  ok: true;
  texW: number;
  texH: number;
  /** 实际采样率 sEff（可能因 2048 上限被缩小） */
  sEff: number;
  /** 参与烘焙的光源数（**不含**动态光） */
  lights: number;
  /** 因为 `lightDynamic="1"` 被排除的光源数 */
  dynamicSkipped: number;
  /** 数学计算耗时 ms */
  ms: number;
  /** 素材 id（写进 scene.lightmap.assetId） */
  assetId: string;
  /** 被合并掉的旧贴图数量（重复烘焙不堆素材） */
  removedOld: number;
  /** 给用户看的警告（非致命，但值得知道） */
  warnings: string[];
}

/** 烘焙失败时返回的结构（面板要能"吃住"）。 */
export interface BakeFailure {
  ok: false;
  error: string;
}

export type BakeOutcome = BakeStats | BakeFailure;

/** 烘焙算法版本（写进 `scene.lightmap.version`；公式改了才 +1）。 */
export const BAKEMAP_VERSION = 1;

/** 素材命名：`光照贴图 场景名`（素材面板里一眼能认出这是什么、属于谁）。 */
export function lightmapAssetName(sceneName: string): string {
  const n = String(sceneName ?? "").trim() || "未命名场景";
  return `光照贴图 ${n}`;
}

/**
 * 判断一个素材是否还被"别人"引用。
 *
 * 重复烘焙必须先删掉上一张，否则素材库会一次多一条、十次烘焙后一堆同名贴图
 * （用户还得自己清理）。但**不能盲删**：用户可能把这张烘焙图拖到某个对象上当了贴图、
 * 或者别的场景的 lightmap 指着它 —— 删掉就是把人家的画面弄坏。
 *
 * 判据（保守，宁可少删）：
 *   1. 任何场景里任何对象的 `assetId` 指向它；
 *   2. **任意别的**场景的 `lightmap.assetId` 指向它。
 */
export function isAssetReferenced(project: Project, assetId: string, exceptSceneId: string): boolean {
  for (const scene of project.scenes ?? []) {
    if (scene.id !== exceptSceneId && scene.lightmap?.assetId === assetId) return true;
    for (const o of scene.objects ?? []) {
      if (o.assetId === assetId) return true;
    }
  }
  return false;
}

/**
 * 一帧的 RGB 浮点网格 → 不透明 PNG Blob。
 *
 * `alpha` 恒 255：运行时的"加光"混合是 `GL_SRC_ALPHA, GL_ONE`（契约 §0.2），
 * A=255 ⇒ 直接加 RGB；没有光的纹素 RGB=(0,0,0) ⇒ 加 0，完全无副作用。
 */
export async function rgbToPngBlob(rgba: Uint8ClampedArray, texW: number, texH: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = texW;
  canvas.height = texH;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("浏览器拿不到 2D canvas，无法把光照贴图编码成 PNG");
  // ImageData 构造函数要求 Uint8ClampedArray；长度必须是 texW*texH*4，编译器不管这事，
  // 运行时少一个字节会直接抛 IndexSizeError，所以这里给一句人话提示。
  if (rgba.length !== texW * texH * 4) {
    throw new Error(`光照贴图数据长度不对：期望 ${texW * texH * 4}，实际 ${rgba.length}`);
  }
  // 不做任何缩放/平滑：1:1 直接写像素，否则贴图会被二次重采样糊掉一圈
  g.imageSmoothingEnabled = false;
  // ImageData 的构造函数要求底层是 **ArrayBuffer**（不是 SharedArrayBuffer）；
  // Uint8ClampedArray 的默认类型参数是 ArrayBufferLike，TS 在这里会拒收，
  // 所以显式拷一份「确定基于 ArrayBuffer」的副本（顺带也把调用方传进来的数组隔离开）。
  const bytes = new Uint8ClampedArray(rgba.length);
  bytes.set(rgba);
  g.putImageData(new ImageData(bytes, texW, texH), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
  if (!blob) throw new Error("PNG 编码失败（canvas.toBlob 返回空）");
  return blob;
}

/** 收集警告文案（纯函数，方便自检里单独断言；不产生副作用）。 */
export function collectBakeWarnings(opts: {
  scene: SceneModel;
  lights: LightSourceSpec[];
  occluders: OccluderSpec[];
  texW: number;
  texH: number;
  rawTexW: number;
  rawTexH: number;
}): string[] {
  const warnings: string[] = [];
  const lighting = opts.scene.lighting;
  const active = opts.lights.filter((l) => !l.dynamic);
  const dynamic = opts.lights.filter((l) => l.dynamic);

  if (active.length === 0) {
    warnings.push(
      dynamic.length
        ? `场景里只有动态光（${dynamic.length} 盏），本次烘焙没有任何光参与 —— 贴图只有环境光。`
        : "场景里一盏光源都没有，本次烘焙只有环境光（想有光：右键画布「在这里放一个光源」）。"
    );
  }
  if (active.length > 64) {
    warnings.push(
      `参与烘焙的光源有 ${active.length} 盏（超过 64）。烘焙耗时与内存会明显上升；` +
        "把远处的灯改成「烘焙时排除（动态光）」或减少数量都能提速。"
    );
  }
  if (opts.texW !== opts.rawTexW || opts.texH !== opts.rawTexH) {
    warnings.push(
      `贴图原尺寸 ${opts.rawTexW}×${opts.rawTexH} 超过 ${MAX_TEX} 上限，已按同一比例缩到 ` +
        `${opts.texW}×${opts.texH}（光照会更糊一点，但画面比例不会变）。`
    );
  }
  if (dynamic.length > 0) {
    warnings.push(`有 ${dynamic.length} 盏光源标记为「烘焙时排除（动态光）」，它们不在贴图里。`);
  }
  if (lighting && lighting.mode === "baked" && dynamic.length > 0) {
    warnings.push(
      `当前模式是「只用烘焙贴图 baked」，但那 ${dynamic.length} 盏动态光不会进贴图 —— ` +
        "游戏里看不到它们。要么改成「烘焙+动态 both」，要么把它们改成烘焙光。"
    );
  }
  if (opts.occluders.length === 0) {
    warnings.push("场景里没有遮挡体（tags 里带 wall / occluder / lightblock，或 props.lightBlock=\"1\"），光不会被墙挡住。");
  }
  return warnings;
}

/**
 * 一键烘焙。**整个流程不抛异常**，失败一律返回 `{ ok:false, error }`。
 *
 * 步骤（顺序有意义）：
 *   1. 校验总开关（没开就明确提示，绝不静默什么都不做 —— 用户会以为按钮坏了）；
 *   2. 收集光源/遮挡体 → `bakeLightmap`（纯数学）；
 *   3. RGB → RGBA → PNG Blob（浏览器编码）；
 *   4. 注册素材（`addRasterAsset`，与导入图完全同一套 IDB 格式）；
 *   5. **删掉上一张**烘焙图（先合并，后回写：中途失败不至于让工程指向一张不存在的素材）；
 *   6. 回写 `scene.lightmap`；
 *   7. `markDirty` + 三个事件（commit 进撤销栈 / repaint 重画画布 / refresh 重刷面板）。
 *
 * @param sceneOverride 面板可以传入"正在看的场景"，避免依赖 store 的当前场景
 *   （烘焙按钮在面板里，面板切场景的时序与 store 可能差一帧）。
 */
export async function bakeSceneLighting(
  sceneOverride?: SceneModel | null,
  projectOverride?: Project | null
): Promise<BakeOutcome> {
  try {
    const scene = sceneOverride ?? store.scene;
    const project = projectOverride ?? store.project;
    if (!scene) return { ok: false, error: "没有打开的场景，无法烘焙" };
    if (!project) return { ok: false, error: "没有打开工程，无法烘焙" };

    const lighting = scene.lighting;
    if (!lighting) {
      return { ok: false, error: "这张场景还没有启用 2D 光照（打开面板里的「启用 2D 光照」再来烘焙）" };
    }
    if (lighting.enabled !== true) {
      return { ok: false, error: "光照总开关关着：先打开「启用 2D 光照」再烘焙（关着烘焙出来的图运行时不会用）" };
    }
    // ★ mode="dynamic" 时**拒绝烘焙**（契约 §3.1 + §7）。
    //
    // 为什么不是"照常烘完再警告"：`mode=dynamic` 的运行时只算动态层、**完全不读 lightmap**，
    // 于是这张 PNG 永远不会被任何一帧用到 —— 工程体积白涨，素材库里多一张"光照贴图 X"让人以为
    // 生效了，而游戏里看到的其实是运行时另算的一套。这种"看起来成功、实际无效"的产物
    // 比直接报错更坏。所以这里明确失败，并告诉用户两条可行路径（切模式 / 把光标记成烘焙）。
    if (lighting.mode === "dynamic") {
      return {
        ok: false,
        error:
          "当前光照模式是「只用运行时动态 dynamic」，烘焙产物不会被任何一帧使用（运行时不读烘焙图）。" +
          "要烘焙请先把模式切到「烘焙 + 动态 both」或「只用烘焙图 baked」；" +
          "如果你只是想让某些光由运行时算，把它们勾上「烘焙时排除（动态光）」，模式保持 baked/both。"
      };
    }

    // ---- 1) 输入 ----
    const built = bakeInputFromScene(scene, project, project.tileSize);
    if (!built.ok) return { ok: false, error: built.error };
    const input = built.input;

    const allLights = collectSceneLighting(scene, project);
    const occluders = input.occluders ?? [];

    // 原始尺寸只用于"是否被缩过"的警告
    const s0 = lighting.texelsPerPixel > 0 ? lighting.texelsPerPixel : 0.25;
    const rawTexW = Math.max(1, Math.round(input.width * s0));
    const rawTexH = Math.max(1, Math.round(input.height * s0));

    // ---- 2) 数学 ----
    const result = bakeLightmap(input);
    // 空场景里面包屑：环境光全 0 的贴图没有任何意义（运行时加 0），
    // 但也不该拒绝烘焙（用户可能就是要一张"纯环境光"的底图）。
    const rgba = toRgbaBytes(result.rgb);

    // 警告要在"rgb 已被 bake 覆写"之前算吗？bakeLightmap 返回的是新数组，
    // 不修改 input.lights，所以这里可以照常算。
    const warnings = collectBakeWarnings({
      scene,
      lights: allLights,
      occluders,
      texW: result.texW,
      texH: result.texH,
      rawTexW,
      rawTexH
    });

    // ---- 3) PNG ----
    const blob = await rgbToPngBlob(rgba, result.texW, result.texH);

    // ---- 4) 注册素材 ----
    const name = lightmapAssetName(scene.name);
    const entry = await addRasterAsset(project, {
      name,
      blob,
      width: result.texW,
      height: result.texH,
      group: "光照"
    });

    // ---- 5) 合并旧贴图（先记下来，回写后再删，保证引用不悬空） ----
    const oldAssetId = scene.lightmap?.assetId ?? "";
    let removedOld = 0;

    // ---- 6) 回写 ----
    scene.lightmap = {
      assetId: entry.id,
      x: 0,
      y: 0,
      w: Math.round(input.width),
      h: Math.round(input.height),
      texW: result.texW,
      texH: result.texH,
      texelsPerPixel: result.sEff,
      lights: allLights.filter((l) => !l.dynamic).length,
      bakedAt: new Date().toISOString(),
      version: BAKEMAP_VERSION
    };

    // 新引用已经写好了，这时删旧的才安全（即使删失败，工程也是自洽的）
    if (oldAssetId && oldAssetId !== entry.id && !isAssetReferenced(project, oldAssetId, scene.id)) {
      try {
        await deleteAsset(project, oldAssetId);
        removedOld = 1;
      } catch {
        /* 删不掉只是留一份垃圾素材，不影响这次烘焙结果 —— 不升级成失败 */
      }
    }

    // ---- 7) 落盘 + 广播 ----
    store.markDirty();
    window.dispatchEvent(new CustomEvent("bwe:commit", { detail: { label: "一键烘焙光照" } }));
    window.dispatchEvent(new CustomEvent("bwe:repaint"));
    window.dispatchEvent(new CustomEvent("bwe:refresh"));

    return {
      ok: true,
      texW: result.texW,
      texH: result.texH,
      sEff: result.sEff,
      lights: allLights.filter((l) => !l.dynamic).length,
      dynamicSkipped: allLights.filter((l) => l.dynamic).length,
      ms: result.ms,
      assetId: entry.id,
      removedOld,
      warnings
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
