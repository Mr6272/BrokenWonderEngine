# bwe.combat — 战斗（Combat）

> 本页覆盖：`bwe.combat` 的全部成员 —— 武器参数表、命中判定、格挡与减伤、武器切换、弹药、射程判定、战斗事件。
>
> 相关页：[collision：碰撞](collision.md) · [vehicle：车辆](vehicle.md) · [actions：输入动作](actions.md) · [entity：Entity](entity.md) · [README：索引](README.md)

## 设计：数据驱动，引擎不做决策

武器参数是一张**内置数据表**（`DEFAULT_WEAPONS`），引擎只负责：

- 按名字查参数（`params()`）
- 按参数做一次命中结算（`hit()`）
- 记录格挡 / 武器 / 弹药这些**状态**

**不做**：AI 什么时候开火、打谁、要不要走位 —— 那些写在游戏脚本里。

**Phase 说明**：`✅ 已实现`。

## 武器参数表字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | `string` | 武器名 |
| `damage` | `number` | 伤害 |
| `range` | `number` | 有效距离（格） |
| `cooldown` | `number` | 冷却秒 |
| `ammoMax` | `number` | 弹药上限 |
| `melee` | `boolean` | 是否近战 |

---

## 一、武器参数

### bwe.combat.params(kind) → WeaponParams | null

**签名**
`bwe.combat.params(kind: string): WeaponParams | null`

**参数**
- `kind` — 武器名（省略默认 `"fist"`）

**返回**
参数表项；未知武器返回 `null`

**说明**
✅ 已实现。用于做武器选择界面、或者让脚本按数据算伤害。

**示例**
```js
var p = bwe.combat.params("pistol");
if (p) {
  bwe.log(p.name + "：伤害 " + p.damage + "，射程 " + p.range + " 格，冷却 " + p.cooldown + "s");
} else {
  bwe.log("没有这把武器");
}
```

**另见**
[bwe.combat.weapons](#bwecombatweapons--string)

---

### bwe.combat.weapons() → string[]

**签名**
`bwe.combat.weapons(): string[]`

**参数**
无

**返回**
`string[]` — 全部武器名

**说明**
✅ 已实现。可以拿它来遍历参数表。

**示例**
```js
var names = bwe.combat.weapons();
for (var i = 0; i < names.length; i++) {
  var p = bwe.combat.params(names[i]);
  bwe.log(names[i] + " — " + p.damage + " 伤害");
}
```

---

## 二、命中

### bwe.combat.hit({from, to, weapon}) → {hit, target, amount, blocked, killed}

**签名**
`bwe.combat.hit(opts: object): HitResult`

**参数**
- `opts` — 认这几个键：`from`（攻击方实体）/ `to`（目标实体）/ `weapon`（武器名）等

**返回**

| 字段 | 类型 | 说明 |
|---|---|---|
| `hit` | `boolean` | 是否命中 |
| `target` | `Entity \| null` | 目标 |
| `amount` | `number` | 实际造成伤害（已被格挡 / 减伤扣过） |
| `blocked` | `boolean` | 是否被格挡 |
| `killed` | `boolean` | 是否击杀 |

**说明**
✅ 已实现。**一次调用做完整结算**：查武器参数 → 判距离 → 算减伤 → 扣血 → 判死亡 → 派发 `damage` / `kill` 事件。

未命中时返回 `{hit: false, amount: 0, blocked: false, killed: false}`，`target` 仍可能非 `null`（打了但没中）。

**示例**
```js
var r = bwe.combat.hit({ from: me, to: enemy, weapon: "pistol" });
if (r.hit) {
  bwe.log("造成 " + r.amount + " 伤害" + (r.blocked ? "（被格挡）" : "") + (r.killed ? "，击杀！" : ""));
} else {
  bwe.log("没打中");
}
```

**另见**
[bwe.combat.inRange](#bwecombatinrangea-b-range--boolean) · [bwe.combat.on](#bwecombatonkill--damage-fn--function--null)

---

### bwe.combat.inRange(a, b, range?) → boolean

**签名**
`bwe.combat.inRange(a: Entity, b: Entity, range?: number): boolean`

**参数**
- `a` — 实体 A
- `b` — 实体 B
- `range` — 判定距离（省略 = **无限远**）

**返回**
`boolean` — 两点距离是否 ≤ `range`

**说明**
✅ 已实现。**纯距离判定**，不看朝向、不看遮挡。任一方无效返回 `false`。

用于自己写开火逻辑时判"够不够得着"，和武器参数表里的 `range` 配合：

```js
var p = bwe.combat.params("pistol");
if (bwe.combat.inRange(me, enemy, p.range)) {
  bwe.combat.hit({ from: me, to: enemy, weapon: "pistol" });
}
```

**示例**
```js
bwe.log(bwe.combat.inRange(me, enemy, 200) ? "在射程内" : "太远了");
```

---

## 三、格挡

### bwe.combat.defend(e, on = true) → boolean

**签名**
`bwe.combat.defend(e: Entity, on?: boolean): boolean`

**参数**
- `e` — 实体
- `on` — 省略 = `true`

**返回**
`boolean` — 设置成功；实体无效返回 `false`

**说明**
✅ 已实现。开/关格挡**状态**，实际减伤由 `setDefense()` 的系数决定。

**示例**
```js
// 按住 defend 动作时格挡
bwe.combat.defend(me, bwe.actions.down("defend"));
```

**另见**
[bwe.combat.defending](#bwecombatdefendinge--boolean) · [bwe.combat.setDefense](#bwecombatsetdefensee-v--05--boolean)

---

### bwe.combat.defending(e) → boolean

**签名**
`bwe.combat.defending(e: Entity): boolean`

**参数**
- `e` — 实体

**返回**
`boolean` — 是否在格挡（实体无效返回 `false`）

**说明**
✅ 已实现。

**示例**
```js
bwe.log(bwe.combat.defending(enemy) ? "对方在格挡，别硬拼" : "对方没防");
```

---

### bwe.combat.setDefense(e, v = 0.5) → boolean

**签名**
`bwe.combat.setDefense(e: Entity, v?: number): boolean`

**参数**
- `e` — 实体
- `v` — 减伤系数 `0..1`（省略 = `0.5`；超出范围会被夹到 `0..1`）

**返回**
`boolean` — 设置成功；实体无效返回 `false`

**说明**
✅ 已实现。系数越大减得越多。具体减伤公式见 `hit()` 的结算（格挡命中时 `amount` 已扣过）。

**示例**
```js
bwe.combat.setDefense(me, 0.7);   // 重甲：挡掉七成
```

---

## 四、武器与弹药

### bwe.combat.weapon(e, name?) → string | boolean

**签名**
`bwe.combat.weapon(e: Entity, name?: string): string | boolean`

**参数**
- `e` — 实体
- `name`（可选）— 要换的武器名

**返回**
- **不传 `name`**：返回当前武器名（`string`）
- **传 `name`**：换武器，成功 `true` / 未知武器 `false`

**说明**
✅ 已实现。**同一个方法两种语义**，返回类型因此是联合类型 —— 调用时按你的用法断言。

```js
bwe.combat.weapon(me);            // "fist"（只读）
bwe.combat.weapon(me, "pistol");  // true（换武器）
bwe.combat.weapon(me, "laser");   // false（未知武器，并打日志）
```

换武器成功时**弹药会重置为该武器的 `ammoMax`**（不是清零）。

**示例**
```js
var w = bwe.combat.weapon(me);
bwe.log("现在拿的是 " + w);
```

**另见**
[bwe.combat.weaponOf](#bwecombatweaponofe--string) · [bwe.combat.switchWeapon](#bwecombatswitchweapone--string--boolean)

---

### bwe.combat.weaponOf(e) → string

**签名**
`bwe.combat.weaponOf(e: Entity): string`

**参数**
- `e` — 实体

**返回**
`string` — 当前武器名；实体无效返回 `"fist"`

**说明**
✅ 已实现。**总是返回字符串**（不会返回 `boolean`），比 `weapon(e)` 更适合"只想读"的场合。

**示例**
```js
bwe.log("敌人拿着 " + bwe.combat.weaponOf(enemy));
```

---

### bwe.combat.switchWeapon(e) → string | boolean

**签名**
`bwe.combat.switchWeapon(e: Entity): string | boolean`

**参数**
- `e` — 实体

**返回**
新武器名（`string`）；实体无效返回 `false`

**说明**
✅ 已实现。按参数表**循环切下一把**（最后一把之后回到第一把）。切完弹药重置为新的 `ammoMax`。

**示例**
```js
if (bwe.actions.pressed("switch_weapon")) {
  var next = bwe.combat.switchWeapon(me);
  if (next) bwe.log("换成 " + next);
}
```

**另见**
[bwe.actions.pressed](actions.md#bweactionspressedaction--boolean)

---

### bwe.combat.ammo(e) → number

**签名**
`bwe.combat.ammo(e: Entity): number`

**参数**
- `e` — 实体

**返回**
`number` — 当前弹药；实体无效返回 `0`

**说明**
✅ 已实现。

**示例**
```js
bwe.log("剩 " + bwe.combat.ammo(me) + " 发");
```

---

### bwe.combat.setAmmo(e, n) → boolean

**签名**
`bwe.combat.setAmmo(e: Entity, n: number): boolean`

**参数**
- `e` — 实体
- `n` — 弹药数（负数会被夹到 `0`）

**返回**
`boolean` — 设置成功；实体无效返回 `false`

**说明**
✅ 已实现。做拾取弹药 / 作弊码 / 存档恢复都用它。

**示例**
```js
bwe.combat.setAmmo(me, 30);    // 补满
bwe.combat.setAmmo(me, 0);     // 清空
```

---

## 五、事件

### bwe.combat.on("kill" | "damage", fn) → Function | null

**签名**
`bwe.combat.on(ev: "kill" | "damage", fn: (info: CombatEvent) => void): Function | null`

**参数**
- `ev` — 只认 `"kill"`（击杀）与 `"damage"`（造成伤害）
- `fn` — 回调，入参：

  | 字段 | 类型 | 说明 |
  |---|---|---|
  | `event` | `string` | `"kill"` / `"damage"` |
  | `from` | `Entity \| null` | 攻击方 |
  | `to` | `Entity` | 承受方 |
  | `amount` | `number` | 伤害量 |
  | `killed` | `boolean` | 是否因此击杀 |

**返回**
传进去的 `fn` 本身（便于 `off(fn)`）；事件名未知或 `fn` 非法时返回 `null`

**说明**
✅ 已实现。事件由 `hit()` 结算时派发。

**示例**
```js
bwe.combat.on("damage", function (info) {
  bwe.log(info.from.tag + " 打了 " + info.to.tag + " " + info.amount + " 点");
});
bwe.combat.on("kill", function (info) {
  bwe.log(info.to.tag + " 被击杀");
});
```

**另见**
[bwe.combat.off](#bwecombatofffn--boolean)

---

### bwe.combat.off(fn) → boolean

**签名**
`bwe.combat.off(fn: Function): boolean`

**参数**
- `fn` — 回调引用

**返回**
`boolean` — 是否真的摘掉了

**说明**
✅ 已实现。按函数引用在 `kill` / `damage` 两个事件里找。

**示例**
```js
var onDamage = function (info) { bwe.log("挨打"); };
bwe.combat.on("damage", onDamage);
bwe.combat.off(onDamage);
```

---

## 另见

- [collision：碰撞](collision.md) —— 命中前"够不够得着"的几何判定
- [entity：Entity](entity.md) —— `e.hp` / `e.hpMax` 是血量的真实来源
- [actions：输入动作](actions.md) —— `attack` / `switch_weapon` / `defend` 三个动作
- [vehicle：车辆](vehicle.md) —— 车辆损伤走 `bwe.vehicle.damage`
