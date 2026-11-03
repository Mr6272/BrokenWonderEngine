/**
 * 工程脚本写操作内核的单测（`core/scriptOps.ts`）。
 *
 * 为什么必须单独测：写权限出错的表现是「**悄悄改坏用户的工程**」——
 * 删掉被引用的脚本、补丁命中了错的那一处、空片段把内容插到文件头。
 * 这些在编辑器里看起来都正常，跑起来才发现脚本没了/逻辑错了，
 * 而那时用户已经保存、AI 已经继续说下一件事了。所以每条安全边界都要有断言。
 *
 * 断言分四组：
 *   A. 名字与语言（非法名必须拒绝；中文名必须接受 —— 脚本名是工程 key，不是文件名）
 *   B. 读与列（清单/读取的行数与语言）
 *   C. 写（新建 / 覆盖 / create 三态 / 幂等 / 行尾不被打乱）
 *   D. 补丁与删除（找不到不猜、多处不猜、有引用拒绝删除、force 才删）
 *
 * 跑法：
 *   node node_modules/esbuild/bin/esbuild web/tools/ui-checks/verify-script-ops.ts \
 *     --bundle --platform=node --format=esm --outfile=.tmp_ui/script-ops.mjs
 *   node .tmp_ui/script-ops.mjs
 */
import {
  validateScriptName,
  normalizeScriptName,
  normalizeScriptLang,
  findScriptRefs,
  listScripts,
  readScript,
  writeScript,
  patchScript,
  deleteScript,
  describeScriptList
} from "../../src/core/scriptOps.ts";
import { createProject, createScene, createObject, type Project, type SceneObject } from "../../src/core/model.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

/** 造一个最小的工程（含一个场景与一个对象）。 */
function makeProject(scripts: Record<string, { source: string; lang?: "js" | "yarn" }> = {}): Project {
  const p = createProject("测试工程");
  const scene = createScene("主场景");
  p.scenes = [scene];
  p.scripts = {};
  for (const [name, s] of Object.entries(scripts)) {
    p.scripts[name] = {
      name,
      file: `Scripts/${name}.${s.lang === "yarn" ? "yarn" : "js"}`,
      source: s.source,
      lang: s.lang
    };
  }
  return p;
}

/** 往场景里塞一个引用脚本的对象（复刻对象脚本模块的存法）。 */
function addScriptObject(p: Project, scriptName: string, objName = "对象A"): SceneObject {
  const scene = p.scenes[0];
  // ⚠ createObject 的签名是 (kind, x, y)，名字要自己填 —— 不填就是空名，
  // 断言「引用里带对象名」会假失败（我第一次就踩了这个，问题在夹具不在源码）。
  const obj = createObject("PROP", 0, 0);
  obj.name = objName;
  obj.modules = [
    { defId: "script.js", trigger: "ON_START", values: { script: scriptName }, enabled: true, collapsed: false }
  ];
  scene.objects.push(obj);
  return obj;
}

// ============================================================================
// A. 名字与语言
// ============================================================================
console.log("== A. 名字与语言 ==");
{
  check("空名拒绝", validateScriptName("") !== null);
  check("纯空白拒绝", validateScriptName("   ") !== null);
  check("中文名接受（脚本名是工程 key，不是文件名）", validateScriptName("扫雷") === null, String(validateScriptName("扫雷")));
  check("带空格的中文名接受", validateScriptName("脚本 1") === null);
  check("英文与下划线接受", validateScriptName("player_1") === null);
  check("路径分隔符拒绝（/）", validateScriptName("a/b") !== null);
  check("路径分隔符拒绝（\\）", validateScriptName("a\\b") !== null);
  check("点点拒绝", validateScriptName("..") !== null);
  check("超长拒绝", validateScriptName("x".repeat(41)) !== null);
  check("恰好 40 字接受", validateScriptName("x".repeat(40)) === null);
  check("normalize 去首尾空白", normalizeScriptName("  扫雷 ") === "扫雷");
  check("lang: yarn 保留", normalizeScriptLang("yarn") === "yarn");
  check("lang: js 保留", normalizeScriptLang("js") === "js");
  check("lang: 未知值缺省 js", normalizeScriptLang("lua") === "js");
}

// ============================================================================
// B. 读与列
// ============================================================================
console.log("== B. 读与列 ==");
{
  const p = makeProject({
    扫雷: { source: "var a = 1;\nvar b = 2;", lang: "js" },
    对话: { source: "title: 开始", lang: "yarn" }
  });
  const list = listScripts(p);
  check("列出 2 个脚本", list.length === 2, `实际 ${list.length}`);
  const saolei = list.find((s) => s.name === "扫雷");
  check("清单带行数", saolei?.lines === 2, `实际 ${saolei?.lines}`);
  check("清单带语言", saolei?.lang === "js");
  check("清单带导出路径", saolei?.file === "Scripts/扫雷.js", saolei?.file);

  const r = readScript(p, " 扫雷 ");
  check("读脚本时名字自动去空白", r?.name === "扫雷");
  check("读到的源码完整", r?.source === "var a = 1;\nvar b = 2;");
  check("读不存在的脚本返回 null", readScript(p, "不存在") === null);
  check("无工程时清单为空", listScripts(null).length === 0);
  check(
    "空工程清单给出可执行下一步",
    describeScriptList(makeProject()).includes("WriteScript"),
    describeScriptList(makeProject())
  );
}

// ============================================================================
// C. 写
// ============================================================================
console.log("== C. 写 ==");
{
  const p = makeProject();
  const w = writeScript(p, "新脚本", "var x = 1;", { create: true, lang: "js" });
  check("create=true 新建成功", w.ok === true, w.message);
  check("新建后真的进了工程", typeof p.scripts["新脚本"]?.source === "string");
  check("新建时语言取自入参", p.scripts["新脚本"]?.lang === "js");
  check("新建时自动给导出路径", p.scripts["新脚本"]?.file === "Scripts/新脚本.js", p.scripts["新脚本"]?.file);

  const again = writeScript(p, "新脚本", "var y = 2;", { create: true });
  check("create=true 撞已有脚本必须拒绝", again.ok === false, again.message);
  check("拒绝原因分类正确", again.reason === "exists", String(again.reason));

  const over = writeScript(p, "新脚本", "var y = 2;");
  check("不带 create 可覆盖", over.ok === true, over.message);
  check("覆盖后内容变了", p.scripts["新脚本"]?.source === "var y = 2;");
  check("覆盖保留了语言（不擅自 yarn→js）", p.scripts["新脚本"]?.lang === "js");
  check("覆盖返回改动前后内容（供 diff 用）", over.before === "var x = 1;" && over.after === "var y = 2;");

  const idem = writeScript(p, "新脚本", "var y = 2;");
  check("写同样内容幂等（changed=false）", idem.ok === true && idem.changed === false, `${idem.ok}/${idem.changed}`);

  const notFound = writeScript(p, "不存在的脚本", "var z = 1;", { create: false });
  check("create=false 撞不存在必须拒绝", notFound.ok === false && notFound.reason === "not-found", notFound.message);

  const bad = writeScript(p, "a/b", "var z = 1;");
  check("非法名拒绝写入", bad.ok === false && bad.reason === "invalid-name", bad.message);

  const empty = writeScript(p, "空脚本", "");
  check("空源码拒绝（防止造出空脚本）", empty.ok === false, empty.message);

  const noProj = writeScript(null, "x", "var a=1;");
  check("无工程时拒绝", noProj.ok === false && noProj.reason === "no-project", noProj.message);

  // 已有脚本的语言不能被覆盖改动
  const py = makeProject({ 剧本: { source: "title: 开场", lang: "yarn" } });
  writeScript(py, "剧本", "title: 改成这样");
  check("覆盖 yarn 脚本仍保持 yarn", py.scripts["剧本"]?.lang === "yarn", String(py.scripts["剧本"]?.lang));

  // 行尾风格：CRLF 工程被整篇覆盖时，写进去的就是模型给的那份（这是整篇写入的语义）
  const crlf = makeProject({ w: { source: "var a = 1;\r\nvar b = 2;", lang: "js" } });
  writeScript(crlf, "w", "var a = 1;\nvar b = 3;");
  check("整篇写入按入参行尾落盘（不擅自改）", crlf.scripts["w"]?.source.includes("\n"));
}

// ============================================================================
// D. 补丁与删除
// ============================================================================
console.log("== D. 补丁与删除 ==");
{
  const p = makeProject({ 主脚本: { source: "function onStart() {\n  var speed = 3;\n}\n", lang: "js" } });

  const okPatch = patchScript(p, "主脚本", "var speed = 3;", "var speed = 6;");
  check("补丁命中并替换", okPatch.ok === true && okPatch.changed === true, okPatch.message);
  check("补丁真的改了源码", String(p.scripts["主脚本"].source).includes("var speed = 6;"));
  check("补丁不动其它行", String(p.scripts["主脚本"].source).startsWith("function onStart() {"));

  const noMatch = patchScript(p, "主脚本", "var speed = 99;", "var speed = 1;");
  check("片段找不到必须失败（不猜）", noMatch.ok === false && noMatch.reason === "patch-no-match", noMatch.message);
  check("找不到时提示先 ReadScript", noMatch.message.includes("ReadScript"), noMatch.message);

  const amb = makeProject({ 重复: { source: "x();\ny();\nx();\n", lang: "js" } });
  const ambiguous = patchScript(amb, "重复", "x();", "z();");
  check("命中多处必须失败（不猜哪一处）", ambiguous.ok === false && ambiguous.reason === "patch-ambiguous", ambiguous.message);
  check("多处失败时报告命中数", ambiguous.message.includes("2 处"), ambiguous.message);
  check("多处失败后源码不变", amb.scripts["重复"].source === "x();\ny();\nx();\n");
  // 带上下文后能唯一定位
  const narrowed = patchScript(amb, "重复", "y();\nx();", "y();\nz();");
  check("扩上下文后可唯一定位", narrowed.ok === true, narrowed.message);

  const emptyFind = patchScript(p, "主脚本", "", "插入");
  check("空片段拒绝（否则等于在文件头插入）", emptyFind.ok === false, emptyFind.message);

  const noSuch = patchScript(p, "没有这个", "a", "b");
  check("补丁到不存在的脚本失败", noSuch.ok === false && noSuch.reason === "not-found", noSuch.message);

  // CRLF 工程：补丁不应把整篇行尾改掉
  const crlf = makeProject({ c: { source: "var a = 1;\r\nvar b = 2;\r\nvar c = 3;\r\n", lang: "js" } });
  const crlfPatch = patchScript(crlf, "c", "var b = 2;\n", "var b = 22;\n");
  check("CRLF 工程补丁命中（片段用 \\n 也能匹配）", crlfPatch.ok === true, crlfPatch.message);
  check("CRLF 工程补丁不把整篇改成 LF", (crlf.scripts["c"].source.match(/\r\n/g) ?? []).length === 3, crlf.scripts["c"].source);
}

console.log("== D2. 删除与引用 ==");
{
  const p = makeProject({ 被引用: { source: "var a=1;", lang: "js" }, 没人用: { source: "var b=2;", lang: "js" } });
  addScriptObject(p, "被引用");

  const refs = findScriptRefs(p, "被引用");
  check("能查出对象模块引用", refs.length === 1, `实际 ${refs.length}`);
  check("引用带场景名", refs[0]?.scene === "主场景", refs[0]?.scene);
  check("引用带对象名", refs[0]?.object === "对象A", String(refs[0]?.object));

  p.scenes[0].onStartScript = "没人用";
  const refs2 = findScriptRefs(p, "没人用");
  check("能查出场景脚本引用", refs2.length === 1 && refs2[0].kind === "sceneStartScript", String(refs2[0]?.kind));

  // 没有任何引用的脚本可以直删
  const p2 = makeProject({ 孤零零: { source: "var c=3;", lang: "js" } });
  const del = deleteScript(p2, "孤零零");
  check("无引用脚本可直接删除", del.ok === true && del.changed === true, del.message);
  check("删除后真的没了", p2.scripts["孤零零"] === undefined);

  // 有引用必须拒绝
  const p3 = makeProject({ 在用: { source: "var d=4;", lang: "js" } });
  addScriptObject(p3, "在用");
  const refused = deleteScript(p3, "在用");
  check("被引用的脚本拒绝删除", refused.ok === false && refused.reason === "in-use", refused.message);
  check("拒绝时仍保留脚本", p3.scripts["在用"] !== undefined);
  check("拒绝时列出引用位置", refused.message.includes("主场景") && refused.message.includes("对象A"), refused.message);
  check("拒绝时返回引用清单", Array.isArray(refused.refs) && refused.refs.length === 1);

  const forced = deleteScript(p3, "在用", { force: true });
  check("force=true 才允许删被引用的脚本", forced.ok === true, forced.message);
  check("force 删除后提示残留引用", forced.message.includes("引用"), forced.message);

  const delMissing = deleteScript(p3, "不存在");
  check("删不存在的脚本失败", delMissing.ok === false && delMissing.reason === "not-found", delMissing.message);
}

// ============================================================================
// E. 一整套串起来：AI 的典型用法
// ============================================================================
console.log("== E. 端到端（AI 的典型用法）==");
{
  const p = makeProject({ player: { source: "function onUpdate() {\n  var speed = 5;\n}\n", lang: "js" } });
  // 1) 读 → 2) 补丁改一行 → 3) 再读确认
  const before = readScript(p, "player");
  check("读得到", before?.source.includes("var speed = 5;") === true);
  const patch = patchScript(p, "player", "var speed = 5;", "var speed = 9;");
  check("改一行成功", patch.ok === true, patch.message);
  const after = readScript(p, "player");
  check("改动落地可读回", after?.source.includes("var speed = 9;") === true);
  check("未受影响的行仍在", after?.source.includes("function onUpdate()") === true);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
