# 涌现式沙盘 · 示例工程规格（俯视角）

> 目的：用一个**能玩、能看到涌现**的沙盘证明 §2.11 的四层基底能自然组合，而不是靠脚本写死剧情。
> 交付物：`web/examples/涌现沙盘.bwproj`（生成器 `.tmp_rel8/gen-emergence-demo.mjs`）+ 校验脚本 `web/tools/verify-emergence.mjs`。

## 1. 场景

- 地图 **40 × 30 格 @ 32px**（1280×960），俯视角。
- 结构：中央哨站（石墙房间 + 木门）、南侧草地（易燃）、西侧油桶堆（oil）、东侧水渠（water）、北侧守卫巡逻道。
- TILE 材质映射（靠素材名 → 材质）：
  | 素材 | 材质 | 说明 |
  |------|------|------|
  | 草地 | `grass` | flammable 0.8、burnTime 2.0 |
  | 木墙/木箱 | `wood` | flammable 0.5、burnTime 4.0、烧穿后该格可走 |
  | 石墙 | `stone` | 不可燃（火势屏障） |
  | 油桶 | `oil` | flammable 1.0、蔓延加速 |
  | 水渠 | `water` | 灭火、把相邻材质标记 wet |
- 实体：
  - 玩家（`script.js → player`）：WASD 移动、空格「点火把/挥击」、E「搬运/放下」、鼠标左键「朝鼠标丢油瓶」（用 `bwe.physics.throwAt`）
  - 守卫 ×2（`script.js → guard`）：`bwe.ai.attach` + 巡逻状态机；听到噪音 → investigate；看见玩家起火 → chase/攻击
  - 平民 ×1（`script.js → civilian`）：看到火会逃跑（`bwe.ai` 感知 + flee），跑向水渠
  - 场景脚本 `world`（`onStartScript`）：建材质/格子材质、开物理、开确定性种子、`bwe.every(1, ...)` 输出状态摘要（校验用打点）
  - HUD 脚本 `hud`：血条、状态文字（当前 AI 状态、燃烧格数、噪音事件数）

## 2. 涌现必须能自然出现的组合（脚本里**不写死**）

1. **火链**：玩家点火 → 草地自燃蔓延 → 烧到油桶 → 火势暴涨 → 烧到木墙 → 墙烧穿 → 出现新通路。
2. **地形反制**：火逼近水渠 → 水扑灭该格 → 火势被水线切断（未被烧的草地仍在）。
3. **AI 反应链**：爆炸/打斗噪音 → 守卫 investigate → 看见燃烧或玩家 → chase → 同阵营 `alert` 把另一名守卫也叫来。
4. **平民恐慌**：平民看见火 → flee 到水渠方向；如果水渠边也有火 → 改跑向北侧（状态机分支，由 JS 决策）。
5. **物理互动**：油瓶被 `throwAt` 抛出 → 落地碰撞（`collision` 回调）→ 在落点 `field.emit("fire")`（油瓶脚本自己决定）→ 形成第二火点。

## 3. 验收断言（`web/tools/verify-emergence.mjs`，headless 为主）

用真实 `TopDownRuntime` + 真实 JS 脚本，headless 推进（反射调 update），逐项断言：

| # | 断言 | 判定 |
|---|------|------|
| E1 | 起始点燃草地 (12,22) 后 4 秒，燃烧格 ≥ 20 且烧毁格 ≥ 8 | `field.burning()` / `material.of` |
| E2 | 石墙外的草地保持未燃烧（火被石墙挡住） | 采样 3 个墙外格 |
| E3 | 木墙在 8 秒内烧穿：该格 `material.of == null` 且 `tilemap.solid == false` | |
| E4 | 油桶被点燃后 2 秒内其邻域燃烧格增长 ≥ 3（火势加速） | |
| E5 | 水渠格 `field.sample("fire") == 0`，相邻草地材质 `wet == true` | |
| E6 | 噪音后 2 秒内至少 1 名守卫状态变为 `investigate` 且与声源距离减小 | `ai.state` / 坐标 |
| E7 | 隔墙时 `sense.canSee(guard, player) == false`，但听到噪音（`noise.events` 非空） | |
| E8 | `applyImpulse` 让油瓶位移 ≥ 20px，并触发至少 1 次 `collision` 回调 | |
| E9 | 平民看见火后状态变为 `flee`，且朝水渠方向（|Δx| 增大） | |
| E10 | 确定性：同种子跑两遍，烧毁格数 / AI 状态序列 / 燃烧格数曲线完全一致 | 两次快照比对 |
| E11 | 无 `[脚本错误]`，单帧模拟耗时 < 4ms（field+physics+ai 合计，40×30） | `bwe.log` + 计时打点 |

## 4. 性能预算（40×30 地图，200 实体）

| 子系统 | 预算 |
|--------|------|
| 材质场（fire/water/smoke） | < 1.5 ms/tick |
| 物理（~50 刚体） | < 1.0 ms/帧 |
| 感知/AI（~20 AI） | < 1.0 ms/帧 |
| 合计 | < 4 ms/帧（仍有 60fps 余量） |

## 5. 打点（校验脚本用）

脚本里用 `bwe.log` 输出可供断言的行，统一前缀 `[涌现]`：

```
[涌现] 材质就绪：grass/wood/stone/oil/water
[涌现] 点火 (12,22) 强度 1.0
[涌现] 守卫 甲 状态 → investigate（噪声源 620,410）
[涌现] 木墙 (18,10) 烧穿，格子已可通行
[涌现] 水渠灭火 (24,18)，相邻 3 格变 wet
[涌现] 平民 状态 → flee
[涌现] 4 秒统计：燃烧 27 格 / 烧毁 9 格 / 守卫状态 investigate,chase
```
