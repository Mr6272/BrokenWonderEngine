# projectOps 扩展规格（Agent 全量改写工程能力）

> 目标：AI 能改**工程里任意**属性 / 变量 / 参数 / 预制体 / 场景摆放。
> 落地文件 `web/src/core/projectOps.ts`（纯函数，可单测）。
> 所有 op 沿用既有三条纪律：校验先行、整批事务、纯函数。
> 本文是**实现与测试的共同契约** —— 字段名一个都不能改。

## 0. 命名约定

- 已有 op 保持原样，不改名、不改语义。
- 新增 op 一律「动词 + 名词」，复数表示批量。
- 所有 `patch` / `set` 语义：**只覆盖给出的字段**（未给 = 不动）。
- 所有引用型字段（sceneId / assetId / scriptName / defId / layerId）必须校验存在性，
  不存在 → `Rejection`（原因码见 §9）。
- `delete*` 类必须防「删空」：删到 0 个场景 / 0 个图层 → 拒绝。

## 1. 工程级：`updateProject`

```ts
{ op: "updateProject", set: ProjectSettingsPatch }

interface ProjectSettingsPatch {
  name?: string;            // 非空；去首尾空格
  author?: string;
  tileSize?: number;        // 正整数 1..512
  gridW?: number;           // 正整数 1..512
  gridH?: number;           // 正整数 1..512
  masterVolume?: number;    // 0..1
  orientation?: "portrait" | "landscape" | "";
                              // "" = 清除该字段（回到「按宽高比推断」）
}
```

注意：`gridW/gridH` 是**工程默认格子数**，不会自动改已有场景的 `widthTiles` ——
摘要文本里必须说清这一点，否则模型会以为「改了 gridW 关卡就变大了」。

## 2. 场景：`updateScene` / `deleteScene` / `reorderScenes`

```ts
{ op: "updateScene", sceneId?: string, sceneName?: string, set: ScenePatch }

interface ScenePatch {
  name?: string;            // 非空；不能与其它场景重名
  widthTiles?: number;      // 1..1024，正整数
  heightTiles?: number;
  originX?: number;
  originY?: number;
  onStartScript?: string;   // 空串 = 清除；非空必须是 scripts 里存在的名字
  bgmAssetId?: string;      // 空串 = 清除；非空必须是存在的素材，且 kind 必须是 audio
  ui?: boolean;             // true 转 UI 场景；切到 UI 时若没有 designW/H 则补默认 1280x720
  designW?: number;         // 仅 ui 场景有意义，正整数
  designH?: number;
}

{ op: "deleteScene", sceneId?: string, sceneName?: string }
// 删到 0 个场景 → 拒绝（code: "last_scene"）

{ op: "reorderScenes", order: string[] }
// order = 场景 id 或名字的完整列表（顺序即新顺序）。
// 必须**覆盖全部场景**（数量相等、无重复、无未知项），否则拒绝。
// 为什么要求完整列表而不是「把 X 移到第 N 位」：后者在并发/多次操作时极易错位，
// 而完整列表是幂等的 —— 重放同一条 order 结果不变。
```

## 3. 图层：`updateLayers` / `deleteLayers`

```ts
{ op: "updateLayers", sceneId?: string, sceneName?: string,
  updates: Array<{ id: string; patch: { name?: string; visible?: boolean; locked?: boolean; order?: number } }> }

{ op: "deleteLayers", sceneId?: string, sceneName?: string, ids: string[] }
// 删到 0 个图层 → 拒绝（last_layer）
// 图层上还有对象 → 拒绝（layer_not_empty），提示先 updateObjects 把 layerId 挪走或 deleteObjects
```

## 4. 对象：扩展 `updateObjects` 的 patch 字段 + `reorderObjects`

`updateObjects` 的 `patch` 增加：

```ts
{
  parentId?: string | null;   // null/"" = 挂回场景根；非空必须是**同场景**存在的对象 id，且不能成环
  animMode?: string;          // 非空字符串
  animFps?: number;           // 0..240
  prefabId?: string | null;   // 必须存在或 null
}
```

`addObjects` 的 spec 也补 `animMode?` / `animFps?` / `parentId?`（默认值分别 "static" / 0 / null）。

```ts
{ op: "reorderObjects", sceneId?: string, sceneName?: string, order: string[] }
// 同 reorderScenes 语义：完整列表，顺序即绘制顺序（会写回 z = 下标）
```

成环检测：把 parentId 链走一遍，若回到自己 → 拒绝（code: "cycle"）。
深度上限 64，超过也拒绝（防脏数据造成的死循环）。

## 5. 预制体：`updatePrefabs`

```ts
{ op: "updatePrefabs", updates: Array<{ id: string; patch: PrefabPatch }> }

interface PrefabPatch {
  name?: string;              // 非空且不与其他预制体重名（运行期 bwe.prefab.spawn 按名字查）
  blurb?: string;
  kind?: GameObjectKind;
  assetId?: string;           // 存在性校验，"" = 清除
  z?: number;
  layer?: number;             // 缺省图层序号
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  halfW?: number;
  halfH?: number;
  animMode?: string;
  animFps?: number;
  tags?: string[];
  props?: Record<string, string>;   // 合并，不是替换
  script?: string;                  // 必须是存在的脚本名，"" = 清除
  spawnJitter?: { x: number; y: number };  // 各自 0..1024
}
```

## 6. 模块：`patchModules`（改单个参数，不清其它值）

`attachModules` 是「整实例覆盖」——它会对未给出的参数补默认值，
所以「只改 speed」会把它同实例的其它参数一起重置。这是真实缺口，必须补：

```ts
{ op: "patchModules", sceneId?: string, targetId: string, isPrefab?: boolean,
  patches: Array<{ defId: string; values?: Record<string, string>;
                   trigger?: TriggerId | null; enabled?: boolean }> }
// defId 在该对象上不存在 → 拒绝（unknown_module_instance）
// values 只合并给出的键；键必须在该模块的 params 内、数值在 min..max 内
// trigger 给 null 表示清除触发时机；给字符串必须在该模块支持的 triggers 内
```

## 7. 素材：`updateAssets` / `deleteAssets`

```ts
{ op: "updateAssets", updates: Array<{ id: string; patch: AssetPatch }> }

interface AssetPatch {
  name?: string;              // 非空
  group?: string;
  note?: string;
  url?: string;               // 仅 src="url" 的素材有意义
  cols?: number; rows?: number; cellW?: number; cellH?: number;   // 图集
  frameCount?: number;        // 序列帧，1..240
  hiddenFrames?: number[];    // 序列帧，下标必须 < frameCount
  frameDurations?: number[];  // 序列帧，长度必须 == frameCount，值 10..5000
}

{ op: "deleteAssets", ids: string[] }
// 被对象 / 预制体 / 场景 bgm 引用 → 拒绝（asset_in_use），并在 hint 里列出引用方
```

## 8. 规则包：`definePacks` / `updatePacks` / `deletePacks` / `applyPacks`

```ts
{ op: "definePacks", packs: Array<{ name, blurb?, modules: ModuleInstanceSpec[],
                                    exposed?, exposedLabel? }> }
{ op: "updatePacks", updates: Array<{ id: string; patch: { name?, blurb?, modules?: ModuleInstanceSpec[],
                                    exposed?, exposedLabel? } }> }
{ op: "deletePacks", ids: string[] }
{ op: "applyPacks", sceneId?: string, sceneName?: string,
  targets: string[],        // 对象 id 列表
  packIds: string[] }       // 要套的包
// 套用语义与 data/packs.ts 的 applyPack 一致：
//   (defId + values.callName) 相同的视为同一条 → 覆盖 params/trigger/enabled；其余追加。
// 注意：这里**必须在 projectOps 内部重新实现一份**，不能 import data/packs.ts ——
//   后者直接操作 store（全局状态），而 projectOps 必须保持纯函数。
//   两份实现必须用同一条断言锁住（见测试「applyPacks 与 applyPack 语义一致」）。
```

## 9. 脚本：扩展 `writeScripts` + `deleteScripts`

```ts
{ op: "writeScripts", scripts: Array<{ path: string; source: string; name?: string;
                                       lang?: "js" | "yarn" }> }
// lang 缺省：按 path 后缀推断（.js → js，.yarn → yarn），再缺省 yarn（与 model.ts 的 scriptLang 一致）

{ op: "deleteScripts", names: string[] }
// 被场景 onStartScript 或任何对象的 script.js 模块引用 → 拒绝（script_in_use），
// hint 里列出引用方。force 参数**不提供**：AI 应该先解引用，而不是强删。
```

## 10. 新的失败原因码（`OpFailureCode` 追加）

| code | 含义 |
|---|---|
| `last_scene` | 删除后场景数会变 0 |
| `last_layer` | 删除后图层数会变 0 |
| `layer_not_empty` | 图层上还有对象 |
| `cycle` | parentId 成环或链过深 |
| `asset_in_use` | 素材被引用，不能删 |
| `script_in_use` | 脚本被引用，不能删 |
| `duplicate_name` | 名字与同类型其它项重复（场景名 / 预制体名 / 包名） |
| `bad_order` | reorder* 的 order 不是完整、无重复、无未知项的列表 |

## 11. `ProjectDigest` 必须扩展（否则模型看不见可改的东西）

现阶段 digest 只给「对象名/kind/坐标/模块 defId」，模型看不到 rotation / scale /
visible / tags / props / parentId / animMode，也看不到场景的 onStartScript / bgm、
图层的 visible/locked、预制体的 spawnJitter、素材的 group、工程级字段、规则包。
**改不了看不见的东西**，所以 digest 必须全量：

- 工程块：`name / author / tileSize / gridW / gridH / masterVolume / orientation`
- 场景块：+ `originX / originY / onStartScript / bgmAssetId`
- 图层：+ `visible / locked / order`
- 对象：+ `z / rotation / scaleX / scaleY / halfW / halfH / visible / locked / assetId / layerId / tags / props / parentId / prefabId / animMode / animFps`
- 预制体：+ `blurb / assetId / z / layer / rotation / scaleX / scaleY / animMode / animFps / script / spawnJitter / props / tags / halfW / halfH`
- 素材：+ `src / url / path / group / note / cols / rows / cellW / cellH / frameCount / headName / hiddenFrames / frameDurations`
- 规则包：`id / name / blurb / modules / exposed`

但**不能把上下文撑爆**：对象仍只列前 `maxObjects`（默认 40），
超出时给出总数与「用 maxObjects 调大 / 用 scene 过滤」的提示。
其余集合（素材、预制体、包、脚本）本来就是几十个量级，全列。

## 12. 工具 schema（`desktop/lib/ai/tools.mjs` 的 `ApplyProjectOps`）

`op` 的 enum 必须与本文 §1~§9 完全一致（多一个少一个都算契约断裂，
`verify-project-ops` 里有一条断言直接比对 enum 与 `PROJECT_OP_NAMES`）。
