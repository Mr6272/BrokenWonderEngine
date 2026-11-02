/**
 * apiDocs.ts 与 bwe.d.ts 的条目差异统计（只读分析，不改任何显示逻辑）。
 *
 * ==========================================================================
 * ⚠⚠ 结论先行：**这个脚本的「签名不一致」数字不可靠，不要写进 CI 断言** ⚠⚠
 * ==========================================================================
 * 我改了 9 次归一化规则，③ 的数字在 0~276 之间反复跳：
 *   227 → 208 → 18 → 35 → 276 → 86 → 31 → 45
 * 每一轮我都确信"这次终于对了"。这不是统计，是**拟合**。
 *
 * 根因（不可修，不是没修好）：
 *   `apiDocs.ts` 的 `signature` 是**给人读的展示文本**，例如
 *     "bwe.draw.text(x, y, text, {size = 16, color = \"#fff\", align = \"left\"})"
 *   里面含默认值、省略类型、中文箭头 —— **它本身不是可解析的语法**。
 *   用正则去和 TypeScript 的 AST 做结构化比对，从根上不成立。
 *
 * 所以：
 *   - ① 缺签名 / ② 缺中文：**可靠**（用语言服务判断"符号在不在"，不是字符串比对）；
 *   - ③ 签名不一致：**不可靠**，仅供参考，**禁止进 CI 断言**。
 *     在工具不可靠时写断言 = 随机红/绿的假护栏，比没有更糟（它会训练人"红了先重跑"）。
 * 长期正解：按 apiDocs 的写法**生成一行调用代码，让编译器报错**（独立任务，见 §最后）。
 *
 * --------------------------------------------------------------------------
 * 二级成员核实（用 TypeScript 语言服务逐个查，非字符串比对）
 * --------------------------------------------------------------------------
 * 历史上 ① 曾报「17 条缺失」，全部是 `bwe.<成员>` 形式的二级成员。
 * 根因：查询键写成了 `bwe..`（双点，语法错误 → 补全返回 0 条）。
 * 逐个核实结果（`complete()` 在 `bwe.` 后取候选，detail 是编译器给的签名）：
 *
 *   bwe.on       → function bwe.on(name: string, fn: (payload?: any) => void): void        ✓
 *   bwe.off      → function bwe.off(name: string, fn?: (payload?: any) => void): void     ✓
 *   bwe.after    → function bwe.after(sec: number, fn: () => void): number                ✓
 *   bwe.every    → function bwe.every(sec: number, fn: () => void, opts?: bwe.EveryOpts): number ✓
 *   bwe.cancel   → function bwe.cancel(id: number): void                                  ✓
 *   bwe.tween    → function bwe.tween(target: unknown, props: Record<string, number>, …)   ✓
 *   bwe.random   → function bwe.random(min?: number, max?: number): number                ✓
 *   bwe.randomInt→ function bwe.randomInt(min: number, max: number): number               ✓
 *   bwe.chance   → function bwe.chance(p: number): boolean                                ✓
 *   bwe.pick     → function bwe.pick<T>(arr: T[]): T                                      ✓
 *   bwe.clamp    → function bwe.clamp(v: number, a: number, b: number): number            ✓
 *   bwe.lerp     → function bwe.lerp(a: number, b: number, t: number): number             ✓
 *   bwe.dist     → function bwe.dist(x1: number, y1: number, x2: number, y2: number): number ✓
 *   bwe.log      → function bwe.log(...args: unknown[]): void                             ✓
 *   bwe.error    → function bwe.error(...args: unknown[]): void                           ✓
 *   bwe.call     → function bwe.call(scriptName: string, handlerName: string, ...args): …  ✓
 *   bwe.has      → function bwe.has(scriptName: string): boolean                          ✓
 *
 * **结论：① 实际 0 条。** 那 17 条全部真实存在，补全不会漏。
 * （历史上报 17 条，是查询键写成 "bwe.." + 前缀导致 `bwe..` 的语法错误。）
 *
 * --------------------------------------------------------------------------
 * 长期正解（未实现，独立任务，不阻塞补全 UI）
 * --------------------------------------------------------------------------
 * 对每条 apiDocs 条目，按其 signature 生成一行真实调用：
 *     bwe.world.find({ tag: "x" });        // 照 apiDocs 的写法
 * 让 TypeScript 编译这一行；**报错即说明 apiDocs 的写法与真实签名不符**。
 * 这是编译器判定，不是猜。届时 ③ 才有资格进 CI。
 */

import { readFileSync } from "node:fs";
import { createScriptLanguage } from "../script-language.mjs";
import { API_DOCS } from "../../src/data/apiDocs.ts";

// createScriptLanguage 要的是**声明文件全文**，不是路径。
// 传路径会静默得到 hasTypes=false，所有补全查不到 —— 第一次就因此跑出
// "359 条全部缺失"的假结果。这类「传参形状不对 → 静默空结果」最容易骗人。
const bweDts = readFileSync(new URL("../../src/js/bwe.d.ts", import.meta.url), "utf8");
const lang = createScriptLanguage({ bweDts });

console.log(`[diff] bwe.d.ts 已载入 ${bweDts.length} 字符`);
console.log(`[diff] apiDocs 条目 ${API_DOCS.length} 条`);

/** 在 `bwe.<prefix>.` 之后取补全（detail 是真实签名，docs 是注释）。 */
function completionsUnder(prefix) {
  // prefix === "" 要查的是 **bwe 根对象**（`bwe.` 后取补全），不是 `bwe..`
  // （双点 = 语法错误，补全返回 0 条）。第一版写成 `bwe.${prefix}.`，
  // prefix 为空时得到 `bwe..`，于是 bwe.on / bwe.random / bwe.clamp
  // 这类挂在根对象上的成员全被误报成"d.ts 里没有"（17 条假缺失）。
  const access = prefix ? `bwe.${prefix}.` : "bwe.";
  const text = "function __probe(ctx) {\n  " + access + "\n}\n";
  const offset = text.indexOf(access) + access.length;
  const r = lang.complete(text, offset);
  return r.entries.map((e) => ({ name: e.name, detail: e.detail, docs: e.docs }));
}

/**
 * 按**顶层逗号**切参数（考虑 () {} [] <> 嵌套）。
 *
 * ⚠ 这是第 6 次校准。前 5 次都是同一个错：用 `inside.split(",")` 简单切分，
 * 于是 apiDocs 的展开对象 `spawn({x, y, asset, ...})` 被切成 20 个"参数"，
 * 而 dts 的 `spawn(opts)` 只有 1 个 → 全部误报"参数不一致"（数字在 17/35/79/276 之间乱跳）。
 * 结论：**散手写正则统计不可靠**，必须要么用 AST，要么就用深度感知的切分。
 * 这里用后者（够用且无需引入 TS AST 遍历）。
 */
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if ("({[<".includes(ch)) depth++;
    else if (")}]>".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * 把两边签名压成**同一套可比口径**后返回 { member, params }。
 *
 * 口径规则（每条都对应一次踩过的坑）：
 *   1. apiDocs 的 "bwe.world.mapSize() → {...}"：剥 "bwe."、取最后一段成员名、
 *      去掉 "→" / "=" 之后的说明尾巴；
 *   2. d.ts 的 "(method) bwe.World.clear()" 与 "function bwe.on(...)"：
 *      两种 kind 前缀都要剥；
 *   3. **有无括号不代表不一致**（属性 `a` 与方法 `a()` 对用户是同一个东西）；
 *   4. **对象参数归一成 1 个**（apiDocs 常把 opts 展开写，dts 写命名类型）；
 *   5. 参数比较只取**名字**，类型标注不影响"会不会传错实参"。
 */
function normalizeSig(text, fromDts) {
  let s = String(text || "");
  if (fromDts) {
    s = s
      .replace(/^\((property|method|function|const|var)\s*\)\s*/, "")
      .replace(/^(property|method|function|const|var)\s+/, "")
      .replace(/^bwe\.(?:[A-Z][\w$]*\.)?/, "");
  } else {
    s = s.replace(/^bwe\./, "");
    // ⚠ 只能按 "→" 截（返回值说明），**不能按 "=" 截**：
    //   apiDocs 里大量默认值写法 "follow(e, {smooth = 0.15})"，
    //   按 "=" 截会把参数列表整段砍掉 → 变成 follow() → 误报"参数不一致"。
    s = s.split("→")[0];
  }
  const head = s.split(/[（(]/)[0];
  const member = head.split(".").pop().trim();
  // 取第一对**圆括号**里的内容。注意：圆括号内部可能出现 `{}`、`<>`、`[]`，
  // 它们里面的 `)` 不能当作结束（例如 `spawnAt(opts: Omit<...,"x"|"y"> & {x?:number;}, x, y)`）。
  // 所以这里对**所有**括号类型一起计深度，只在圆括号深度归零时收尾。
  const openIdx = s.search(/[（(]/);
  let inside = "";
  if (openIdx >= 0) {
    let depth = 0;
    for (let i = openIdx; i < s.length; i++) {
      const ch = s[i];
      if (ch === "(" || ch === "（" || ch === "{" || ch === "[" || ch === "<") depth++;
      else if (ch === ")" || ch === "）" || ch === "}" || ch === "]" || ch === ">") {
        depth--;
        if (depth === 0 && (ch === ")" || ch === "）")) {
          inside = s.slice(openIdx + 1, i);
          break;
        }
      }
    }
  }
  const params = splitTopLevel(inside)
    .map((p) => (p.startsWith("{") ? "opts" : p.replace(/^([A-Za-z_$][\w$]*).*/, "$1")))
    .join(",");
  return { member, params };
}

/** 同理压 d.ts 的签名（去掉 "(property)"/"(method)" 前缀）。 */
function dtsCore(detail) {
  // TypeScript 的 displayParts 有两种形状：
  //   "(method) bwe.World.clear(): void"   ← 类成员，kind 在括号里
  //   "function bwe.on(name: string, ...)" ← 命名空间里的函数，kind 是裸关键字
  // 第一版只剥了括号形式，`function bwe.on` 剥不掉 → 落进"无法比对"分支。
  let s = String(detail || "")
    .replace(/^\((property|method|function|const|var)\s*\)\s*/, "")
    .replace(/^(property|method|function|const|var)\s+/, "");
  // 去掉 "bwe.World." / "bwe." 之类限定前缀
  s = s.replace(/^bwe\.(?:[A-Z][\w$]*\.)?/, "");
  const m = /^([A-Za-z_][\w$]*)\s*(\([^)]*\))?/.exec(s);
  if (!m) return "";
  const params = (m[2] || "").replace(/\s+/g, "");
  return `${m[1]}${params}`;
}

/**
 * 从 `名字(参数列表)` 里抽出**参数名列表**（丢掉类型标注）。
 *
 * 为什么只比参数名：类型标注的有无是书写风格（apiDocs 给人看、d.ts 给编译器看），
 * 而参数名/个数不同才会让用户照补全插入时传错实参 —— 那才是真不一致。
 */
function paramSig(core) {
  const m = /^\(([^)]*)\)$/.exec(core.slice(core.indexOf("(")));
  const inner = m ? m[1] : core.slice(core.indexOf("(") + 1, core.lastIndexOf(")"));
  if (!inner.trim()) return "()";
  const names = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if ("<{[( ".includes(ch)) depth++;
    if (">}]) ".includes(ch)) depth--;
    if (ch === "," && depth <= 0) {
      names.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  names.push(cur);
  return "(" + names
    .map((n) => {
      const t = n.trim();
      // 对象字面量参数整体算 1 个（名字统一记 opts）：
      // apiDocs 习惯把 opts 展开写成 {x, y, size=16}，而 d.ts 写 opts: SpawnOpts。
      // 不归一的话「展开对象」会被数成 N 个参数，全部误报"参数个数不同"。
      if (t.startsWith("{")) return "opts";
      // "a: number" / "a=1" / "a?" 都只取名字 a
      return t.replace(/^([A-Za-z_$][\w$]*).*/, "$1");
    })
    .filter(Boolean)
    .join(",") + ")";
}

// ---- 分类 ----
const bweMembers = [];
const lifecycle = [];
const entityProps = [];
for (const d of API_DOCS) {
  if (d.name.startsWith("bwe.")) bweMembers.push(d);
  else if (/^on[A-Z]/.test(d.name)) lifecycle.push(d);
  else if (/^e\./.test(d.name)) entityProps.push(d);
  else bweMembers.push(d);
}
console.log(
  `[diff] 分类：bwe.* 成员 ${bweMembers.length} / 生命周期函数 ${lifecycle.length} / 实体属性 ${entityProps.length}`
);

const cache = new Map();
function entriesFor(ns) {
  if (cache.has(ns)) return cache.get(ns);
  const e = completionsUnder(ns);
  cache.set(ns, e);
  return e;
}

/** "bwe.world.find" → { prefix: "world", member: "find" }；"bwe.on" → { prefix: "", member: "on" } */
function splitName(name) {
  const parts = name.split(".");
  if (parts.length < 3) return { prefix: "", member: parts[parts.length - 1] };
  return { prefix: parts.slice(1, -1).join("."), member: parts[parts.length - 1] };
}

const missingInDts = [];
const matched = [];
const sigMismatch = [];
const sigUnknown = [];
/** 只是"写法不同"（参数类型标注有无），参数名/个数一致的 —— 不算不一致 */
const sigStyleOnly = [];

for (const d of bweMembers) {
  const { prefix, member } = splitName(d.name);
  const entries = prefix ? entriesFor(prefix) : entriesFor("");
  const hit = entries.find((e) => e.name === member);
  if (!hit) {
    missingInDts.push(d);
    continue;
  }
  matched.push({ doc: d, dts: hit });
  const a = normalizeSig(d.signature, false);
  const b = normalizeSig(hit.detail, true);
  if (!b.member) {
    // 真的取不到签名（而不是"看起来对"）—— 如实记为无法比对
    sigUnknown.push({ doc: d, kind: String(hit.detail || "（空）") });
  } else if (a.member && a.params !== b.params) {
    // 只比**参数名序列**：类型标注/是否有括号都不算不一致
    sigMismatch.push({
      doc: d,
      docCore: `${a.member}(${a.params})`,
      dtsCore: `${b.member}(${b.params})`,
      dts: hit.detail
    });
  } else {
    sigStyleOnly.push({ doc: d, a: `${a.member}(${a.params})`, b: `${b.member}(${b.params})` });
  }
}

// 反向：d.ts 里有、apiDocs 没有
const docsByName = new Set(API_DOCS.map((d) => d.name));
const missingInDocs = [];
const namespaces = new Set();
for (const d of bweMembers) {
  const { prefix } = splitName(d.name);
  if (prefix) namespaces.add(prefix);
}
for (const ns of namespaces) {
  for (const e of entriesFor(ns)) {
    const full = `bwe.${ns}.${e.name}`;
    if (!docsByName.has(full) && !docsByName.has(`bwe.${e.name}`)) {
      missingInDocs.push({ full, kind: e.detail || "" });
    }
  }
}

console.log("");
console.log("========== 差异统计（只看 bwe.* 成员）==========");
console.log(`[diff] bwe.* 成员总数: ${bweMembers.length}`);
console.log(`[diff] 对齐成功: ${matched.length}`);
console.log(`[diff] ① apiDocs 有、bwe.d.ts 没有: ${missingInDts.length} 条`);
for (const d of missingInDts.slice(0, 25)) console.log(`[diff]    ${d.name}  ${d.signature}`);
if (missingInDts.length > 25) console.log(`[diff]    …还有 ${missingInDts.length - 25} 条`);
console.log(`[diff] ② bwe.d.ts 有、apiDocs 没有: ${missingInDocs.length} 条`);
for (const d of missingInDocs.slice(0, 25)) console.log(`[diff]    ${d.full}  (${String(d.kind).slice(0, 60)})`);
if (missingInDocs.length > 25) console.log(`[diff]    …还有 ${missingInDocs.length - 25} 条`);
console.log(`[diff] ③ 签名不一致: ${sigMismatch.length} 条`);
for (const m of sigMismatch.slice(0, 25)) {
  console.log(`[diff]    ${m.doc.name}`);
  console.log(`[diff]      apiDocs: ${m.docCore}`);
  console.log(`[diff]      bwe.d.ts: ${m.dtsCore}`);
}
if (sigMismatch.length > 25) console.log(`[diff]    …还有 ${sigMismatch.length - 25} 条`);
console.log(`[diff] ④ 无法比对签名（补全明细只给 kind）: ${sigUnknown.length} 条`);
console.log(
  `[diff] ⑤ 仅写法不同（参数名/个数一致，apiDocs 省略了类型标注）: ${sigStyleOnly.length} 条 —— 不算问题`
);
