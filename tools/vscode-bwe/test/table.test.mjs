#!/usr/bin/env node
/**
 * 数据表 + 补全 + 悬浮 的纯函数测试（不需要 vscode，也不需要起服务）。
 *
 * 覆盖：
 *   1. `data/bwe-api.json` 自检（条目 > 250、名字唯一、字段齐全、生命周期齐全）；
 *   2. 补全：`bwe.w` / `bwe.world.f` / `bwe.draw.t` / `onS` 的前缀过滤真的命中预期条目；
 *   3. 悬浮：`hoverFor()` 在 `bwe.world.find`、`e.setPos` 上给出正确的签名与文档链接；
 *   4. 签名帮助：`signatureForMember()` 的参数表；
 *   5. 生成器与数据不同步检测（`--check` 由外部验收命令覆盖，这里只比对哈希字段存在性）。
 *
 * 输出 PASS / FAIL，退出码 0 / 1。
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(EXT_ROOT, "..", "..");
const nodeRequire = createRequire(import.meta.url);

const apiIndex = nodeRequire(join(EXT_ROOT, "lib", "apiIndex.js"));

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${extra ? ` —— ${extra}` : ""}`);
    console.log(`FAIL  ${name}${extra ? ` —— ${extra}` : ""}`);
  }
}

// ============================================================================
// 1. 数据表自检
// ============================================================================

const table = apiIndex.loadTable();
ok("data/bwe-api.json 能加载", Array.isArray(table.apis) && table.apis.length > 0, table.error || "");

if (!Array.isArray(table.apis) || table.apis.length === 0) {
  console.log("");
  console.log(`结果：${passed} 通过 / ${failed} 失败`);
  console.log("数据表为空，后续用例无法进行。先跑 node web/tools/gen-vscode-api.mjs。");
  process.exit(1);
}

const validation = apiIndex.validateTable();
ok("条目数 > 250", validation.stats.count > 250, `count=${validation.stats.count}`);
ok("validateTable() 无问题", validation.ok, validation.problems.join(" | "));
ok("名字唯一", new Set(table.apis.map((a) => a.name)).size === table.apis.length);
ok("每条都有 signature/summary/group/link", validation.problems.every((p) => !/缺字段/.test(p)));
ok("12 个生命周期函数都在表里", apiIndex.LIFECYCLE.every((n) => !!apiIndex.lookup(n)), apiIndex.LIFECYCLE.filter((n) => !apiIndex.lookup(n)).join(","));
ok("文档链接真实存在（docs/api 下的 .md 文件）", checkDocLinks(table.apis), badLinks(table.apis).slice(0, 5).join(" ; "));
ok("meta 里带生成器与源文件哈希（可检出不新鲜的数据表）", !!table.meta && !!table.meta.generator && !!table.meta.sha256 && !!table.meta.sha256.bweDts, JSON.stringify(table.meta || {}).slice(0, 120));
ok("typeOnly 条目占少数（<20%，防止把类型当文档）", validation.stats.typeOnly / validation.stats.count < 0.2, `${validation.stats.typeOnly}/${validation.stats.count}`);

function checkDocLinks(apis) {
  return badLinks(apis).length === 0;
}
function badLinks(apis) {
  const bad = [];
  for (const api of apis) {
    const link = String(api.link || "");
    if (!link.startsWith("docs/api/")) {
      bad.push(`${api.name}: ${link}`);
      continue;
    }
    const file = join(REPO_ROOT, link.split("#")[0]);
    if (!existsSync(file)) bad.push(`${api.name}: ${link}`);
  }
  return bad;
}

// ============================================================================
// 2. 补全（真实前缀断言）
// ============================================================================

{
  const r = apiIndex.completePrefix("bwe.w");
  ok("补全 bwe.w 有候选", r.kind === "member" && r.items.length > 0, JSON.stringify(r.kind));
  const names = r.items.map((i) => i.name);
  ok("补全 bwe.w 命中 bwe.world（命名空间级条目或成员）", names.some((n) => n.startsWith("bwe.world")), names.slice(0, 5).join(","));
}
{
  const r = apiIndex.completePrefix("bwe.world.f");
  const names = r.items.map((i) => i.name);
  ok("补全 bwe.world.f 命中 bwe.world.find", names.includes("bwe.world.find"), names.join(","));
  ok("补全 bwe.world.f 命中 bwe.world.findAll", names.includes("bwe.world.findAll"), names.join(","));
  ok("补全 bwe.world.f 收窄到 3 条以内", r.items.length <= 3, `${r.items.length}: ${names.join(",")}`);
  const find = r.items.find((i) => i.name === "bwe.world.find");
  ok("补全项带签名", !!find && /bwe\.world\.find\(/.test(find.signature), find ? find.signature : "null");
  ok("补全项带摘要", !!find && find.summary.length > 0, find ? find.summary : "null");
  ok("补全项带分组", !!find && find.group === "world", find ? find.group : "null");
}
{
  const r = apiIndex.completePrefix("bwe.draw.t");
  const names = r.items.map((i) => i.name);
  ok("补全 bwe.draw.t 命中 bwe.draw.text", names.includes("bwe.draw.text"), names.join(","));
  ok("补全 bwe.draw.t 不混入 bwe.draw.rect", !names.includes("bwe.draw.rect"), names.join(","));
}
{
  const r = apiIndex.completePrefix("bwe.");
  ok("补全 bwe. 给出大量顶层候选", r.kind === "namespace" && r.items.length > 50, `${r.kind} ${r.items.length}`);
}
{
  const r = apiIndex.completePrefix("bwe");
  ok("补全 bwe（无点）也算命名空间", r.kind === "namespace" && r.items.length > 50, `${r.kind} ${r.items.length}`);
}
{
  const r = apiIndex.completePrefix("  onS");
  const names = r.items.map((i) => i.name);
  ok("补全 onS 命中 onStart / onSceneStart / onSceneEnd", r.kind === "lifecycle" && names.includes("onStart") && names.includes("onSceneStart") && names.includes("onSceneEnd"), names.join(","));
}
{
  const r = apiIndex.completePrefix("var x = 1;");
  ok("普通代码不触发补全", r.kind === "none" && r.items.length === 0, JSON.stringify(r.kind));
}
{
  const r = apiIndex.completePrefix("bwe.textinput.v");
  const names = r.items.map((i) => i.name);
  ok("补全 bwe.textinput.v 命中唯一成员 bwe.textinput.value", names.length === 1 && names[0] === "bwe.textinput.value", names.join(","));
}

// ============================================================================
// 3. 悬浮（hoverFor）
// ============================================================================

{
  const line = 'var e = bwe.world.find({ tag: "玩家" });';
  const col = line.indexOf("find") + 2;
  const api = apiIndex.hoverFor(line, col);
  ok("悬浮 bwe.world.find 命中条目", !!api && api.name === "bwe.world.find", api ? api.name : "null");
  ok("悬浮结果带签名", !!api && /Entity \| null/.test(api.signature), api ? api.signature : "null");
  ok("悬浮结果带 docs 链接且含锚点", !!api && /docs\/api\/world\.md#/.test(api.link), api ? api.link : "null");
}
{
  const line = "player.setPos(1, 2);";
  const api = apiIndex.hoverFor(line, line.indexOf("Pos") + 1);
  // `player.` 是局部变量，不是 API；扩展约定「宁可没有，也不瞎猜」
  ok("悬浮局部变量 player.setPos 返回 null（不猜成 e.setPos）", api === null, JSON.stringify(api));
}
{
  const line = "  var p = e.setPos(1, 2);";
  const api = apiIndex.hoverFor(line, line.indexOf("setPos") + 1);
  ok("悬浮 e.setPos 直接命中（前缀 e. 与表里同名）", !!api && api.name === "e.setPos", api ? api.name : "null");
}
{
  const api = apiIndex.hoverFor("var x = 1;", 8);
  ok("悬浮普通变量返回 null", api === null, JSON.stringify(api));
}
{
  const api = apiIndex.hoverFor("ctx.self.x += 1;", 5);
  ok("悬浮 ctx.self 返回 null（不在表里，不瞎猜）", api === null, JSON.stringify(api));
}
{
  const line = "var p = bwe.world;";
  const api = apiIndex.hoverFor(line, line.indexOf("world") + 1);
  ok("悬浮命名空间 bwe.world 本身也能命中", !!api && api.name === "bwe.world", api ? api.name : "null");
}
{
  const api = apiIndex.hoverFor("function onUpdate(ctx, dt) {}", 10);
  ok("悬浮生命周期函数 onUpdate 命中", !!api && api.name === "onUpdate", api ? api.name : "null");
}

// ============================================================================
// 4. 签名帮助
// ============================================================================

{
  const sig = apiIndex.signatureForMember("bwe.draw.text");
  ok("签名帮助 bwe.draw.text 有参数表", !!sig && sig.parameters.length >= 4, sig ? sig.parameters.join(",") : "null");
  ok("签名帮助把 opts 对象解构压成一行", !!sig && String(sig.parameters[3]).startsWith("{"), sig ? sig.parameters[3] : "null");
}
{
  const sig = apiIndex.signatureForMember("bwe.world.find");
  ok("签名帮助 bwe.world.find 有 1 个参数", !!sig && sig.parameters.length === 1 && sig.parameters[0] === "q", sig ? JSON.stringify(sig.parameters) : "null");
}
{
  const sig = apiIndex.signatureForMember("bwe.world.paused");
  ok("属性型条目没有参数表", !!sig && sig.parameters.length === 0, JSON.stringify(sig));
}
{
  const sig = apiIndex.signatureForMember("bwe.notexist");
  ok("未知条目返回 null", sig === null, JSON.stringify(sig));
}

// ============================================================================
// 5. 表与源码一致性（哈希字段来自生成器；不同步时提示）
// ============================================================================

{
  const hashes = table.meta && table.meta.sha256 ? table.meta.sha256 : {};
  ok("meta.sha256 三个源文件哈希都存在", !!hashes.apiDocsTs && !!hashes.bweDts && !!hashes.globalsDts, JSON.stringify(hashes));
  ok("meta 记录 apiDocs 条目数与 d.ts 值成员数", table.meta.apiDocsEntries > 300 && table.meta.dtsValueMembers > 250, `apiDocs=${table.meta.apiDocsEntries} dts=${table.meta.dtsValueMembers}`);
}

// ============================================================================

console.log("");
console.log(`结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✅ 数据表 / 补全 / 悬浮 测试全绿");
process.exit(0);
