# Key 失效链路的真机验收（可复跑命令）

> **状态：不可执行 —— 等待主进程把 `keyUndecryptable` 全链路落地。**
> 本文档是可复跑的**命令 + 断言点**，不是已通过的证据。
> 字段落地前跑，第 ① 条必然失败（会看到「本地演示」而不是「⚠ Key 失效」）。

## 为什么必须真机验，不能用 demo 截图

demo 触发器（`data-demo-key-broken` / `data-demo-insecure`）证明的是
**「UI 收到这些状态后会这样显示」**，走真实判定与渲染路径；
但**不证明「真实环境会产出这些状态」**。

把 demo 截图当成真机验收 = 把「组件能画对」冒充成「整条链路通了」。

## 前置条件（缺一条结论就无效）

```bash
# 0. 清残留进程（不清会抢单实例锁，--shot 挂到超时，报的是假红）
taskkill //F //IM electron.exe

# 1. 主进程已吐出 keyUndecryptable / keyUndecryptableCount / keyUndecryptableEntries
#    （A 落地；未落地时本文件第 ① 条必败）

# 2. 用**真实 userData**目录，不能用隔离目录
#    —— 隔离目录里没有真实配置，"解不开"根本不会发生
UD="C:/Users/<你>/AppData/Roaming/BWE Studio"
```

> **「真实目录 vs 隔离目录」是两个命题。**
> A 上一轮就是在隔离目录里得出「本机没 key」的错误结论 ——
> 报告里不写清楚用的是哪个目录，别人无法判断验的是哪个世界。

---

## ① 重启后应看到红色「⚠ Key 失效」，且**不显示「本地演示」**

```bash
node desktop/main.mjs \
  --shot=.tmp_desk/rm1.png --size=1600x1000 \
  --user-data="$UD" \
  --probe-dom=.tmp_desk/rm1.json \
  --console \
  --tap-seq='click:[data-panel-tab="ai"]; wait:600; probe:.model-chip; probe:.ai-keybroken-hint'
```

**断言（三条都要过）**：

| # | 断言 | 判据 |
|---|---|---|
| ①a | `.model-chip` 文本含 `Key 失效` | 红 chip 出现，说明 key-broken 状态被正确判定 |
| ①b | **`.model-chip` 文本不含「本地演示」** | ★ **反向判据**：这轮修的 bug 正是"chip 显示本地演示"，只断言新元素出现，旧的错误显示仍在也不会被发现 |
| ①c | `.ai-keybroken-hint` 可见 | 批量条出现 |

**为什么 ①b 是关键**：「断言新东西出现」+「断言旧东西消失」= 一次完整的状态迁移验证。只做前半等于没验。

---

## ② 点「去重填」→ 粘贴**可用** key → 立即可用（不重启）

```bash
# ②a 自动：填 key 框应弹出
node desktop/main.mjs \
  --shot=.tmp_desk/rm2.png --size=1600x1000 \
  --user-data="$UD" \
  --probe-dom=.tmp_desk/rm2.json \
  --tap-seq='click:[data-panel-tab="ai"]; wait:600; click:[data-ai-rekey-all]; wait:400; probe:.modal [data-ai-key-input]'
# 断言：.modal [data-ai-key-input] 匹配 1
```

**②b 需要真实可用 key**（无法纯自动化）：

```
粘贴真实 key → 点「保存并切换」→
断言：
  · .model-chip 文本不再含「Key 失效」
  · .ai-keybroken-hint 不可见（批量条自动消失，同时满足第 ③ 条）
  · 发一条消息能正常收到回答（这才是"可用"的最终证据，不是 chip 变绿）
```

> ⚠ **没有可用 key 时，如实报「①②验了、②b『立即可用』未验」。**
> **不要用假 key 冒充** —— 假 key 会 401，那证明的是"错误展示正确"，
> 不是"填完可用"。这是两个命题。

---

## ③ 前两条成立时，批量条自动消失

已包含在 ②b 的断言里。单独复核：

```bash
node desktop/main.mjs --shot=.tmp_desk/rm3.png --size=1600x1000 \
  --user-data="$UD" --probe-dom=.tmp_desk/rm3.json \
  --tap-seq='click:[data-panel-tab="ai"]; wait:600; probe:.ai-keybroken-hint'
# 断言：匹配 0，或 display:none
```

---

## 报告模板（三件事必须写清，否则结论无效）

```
1. 哪几条跑了：
   ① a/b/c  [通过/未通过/未跑]
   ② a      [通过/未通过]
   ② b      [通过/未通过/**未验：无可用 key**]
   ③        [通过/未通过]

2. 用的是哪个 userData 目录：
   真实目录 <完整路径>  /  隔离目录（pid 随机）
   ※ 隔离目录只能验 UI，不能验"解不开"

3. 是否检查了反向判据 ①b：
   是 → .model-chip 文本为「<实际文本>」，不含「本地演示」
   否 → 结论不完整
```

---

## 附：旧图上的 `midnight FAIL` 是判据 bug，不是主题坏了

`.tmp_desk/keydialog.png` 等**带 modal 的截图**曾报 `主题: midnight → FAIL`。

**原因**：`desktop/lib/png.mjs` 的 `assertTheme()` 用
「全画面出现次数最多的颜色」判断深浅 —— modal 遮罩一铺，
深色遮罩成了最大面积 → 被判成深色主题。

**已验证的隔离实验**：
- 只点 `data-demo-key-broken`（不弹 modal）→ cream ✓
- 只点 `data-ai-rekey-all`（弹 modal）→ cream ✓
- 两者组合 → midnight ✗（可复现）

已交由桌面侧改为「优先读 DOM 底色 + 像素采样兜底」。
**后人翻到旧图上的 `midnight FAIL` 不要以为主题坏了** —— 那是工具误判。
