/**
 * 内置示例工程的**字段完整性**校验（`data/examples.ts` + `core/model.ts`）。
 *
 * 为什么必须有这条：
 *   `web/examples/*.bwproj` 里有一半是历史版本，缺后来才加的字段 ——
 *   10 个工程里有 6 个没有 `prefabs`。载入示例如果只做 JSON 深拷贝
 *   （`buildExample()` → `cloneProject()`），这些缺字段会以 undefined 漏到面板，
 *   `renderPrefabPanel` 读 `store.project.prefabs.length` 就抛
 *   `TypeError: Cannot read properties of undefined (reading 'length')`，
 *   预制体侧栏整块变成十几个字的残骸。
 *
 *   这个 bug 的真实表现是「点开面板看到一片空白」而不是白屏或报错弹窗，
 *   所以它不会在正常点按流程里被发现 —— 只能靠断言守住。
 *
 * 断言两组：
 *   A. buildExample() 的产物字段齐全（prefabs / packs / scenes / assets / scripts / variables）
 *   B. 缺字段的**输入**经 normalizeProject 后也被补齐（兜底本身有效，而不是靠示例数据干净）
 *
 * 跑法：
 *   node web/tools/verify-example-fields.mjs
 *   或 npm run verify:example-fields
 */
import { buildExample } from "../src/data/examples.ts";
import { normalizeProject } from "../src/core/model.ts";

let pass = 0;
let fail = 0;
const failures = [];

/** 断言。条件在前、名字是字符串 —— 参数顺序写反会给出确定性的假绿。 */
function check(cond, name, detail) {
  if (typeof name !== "string") {
    throw new TypeError(`断言名必须是字符串（参数顺序写反了？）：${String(name)}`);
  }
  if (cond === true) {
    pass++;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const EXAMPLE_IDS = [
  "minesweeper",
  "dressup",
  "topdown-js",
  "emergence",
  "vampire",
  "lighting",
  "alien-shooter"
];

// 面板会直接读的字段。类型不对 = 面板崩。
const ARRAY_FIELDS = ["scenes", "assets", "prefabs", "packs"];
const OBJECT_FIELDS = ["scripts", "variables"];

console.log("== A. buildExample() 产物字段齐全 ==");
for (const id of EXAMPLE_IDS) {
  const { project, fileName } = buildExample(id);
  const missing = [];
  for (const key of ARRAY_FIELDS) {
    if (!Array.isArray(project[key])) missing.push(`${key}=${describe(project[key])}`);
  }
  for (const key of OBJECT_FIELDS) {
    const v = project[key];
    if (!v || typeof v !== "object" || Array.isArray(v)) missing.push(`${key}=${describe(v)}`);
  }
  check(
    missing.length === 0,
    `示例 ${id} 字段齐全`,
    missing.length ? `缺 ${missing.join(", ")} (${fileName})` : `${fileName} · prefabs=${project.prefabs.length} packs=${project.packs.length}`
  );
}

/** 示例工程至少要有一个场景，否则编辑器打开就是空画布。 */
for (const id of EXAMPLE_IDS) {
  const { project } = buildExample(id);
  check(project.scenes.length > 0, `示例 ${id} 至少有一个场景`, `scenes=${project.scenes.length}`);
}

/** 每次载入必须是新对象，否则用户改动会污染模块级缓存（下一次载入还带着上次的改动）。 */
{
  const a = buildExample("topdown-js").project;
  const b = buildExample("topdown-js").project;
  check(a !== b, "两次 buildExample 返回不同对象（深拷贝生效）");
  check(
    a.scenes[0] !== b.scenes[0],
    "两次 buildExample 的场景也是不同对象（不是浅拷贝）"
  );
}

console.log("\n== B. normalizeProject 对缺字段输入的兜底 ==");
// 直接喂一个「什么都没写」的工程，模拟最老版本的 .bwproj
{
  const bare = normalizeProject({ name: "古董工程" });
  for (const key of ARRAY_FIELDS) {
    check(Array.isArray(bare[key]), `缺 ${key} 的工程补齐为数组`, `→ ${describe(bare[key])}`);
  }
  for (const key of OBJECT_FIELDS) {
    const v = bare[key];
    check(
      Boolean(v) && typeof v === "object" && !Array.isArray(v),
      `缺 ${key} 的工程补齐为对象`,
      `→ ${describe(v)}`
    );
  }
}

// 显式给 null / 错误类型，也必须被纠正而不是漏过去
{
  const messy = normalizeProject({
    name: "脏数据",
    prefabs: null,
    packs: "不是数组",
    scenes: null,
    assets: 123,
    scripts: null,
    variables: undefined
  });
  for (const key of ARRAY_FIELDS) {
    check(Array.isArray(messy[key]), `脏值 ${key} 被纠正为数组`, `→ ${describe(messy[key])}`);
  }
  check(
    Boolean(messy.scripts) && typeof messy.scripts === "object",
    "脏值 scripts 被纠正为对象",
    `→ ${describe(messy.scripts)}`
  );
}

// 真实场景：**全部** .bwproj 里的工程经 normalizeProject 后都要字段齐全。
// 这是本条校验存在的真正理由 —— 素材文件会随历史变化，断言不能写死在某个文件上。
console.log("\n== C. 全部内置示例经 normalizeProject 后字段齐全 ==");
for (const id of EXAMPLE_IDS) {
  const raw = JSON.parse(JSON.stringify(buildExample(id).project));
  delete raw.prefabs;
  delete raw.packs;
  const fixed = normalizeProject(raw);
  check(
    Array.isArray(fixed.prefabs) && Array.isArray(fixed.packs),
    `示例 ${id} 缺 prefabs/packs 也能被补齐`,
    `prefabs=${describe(fixed.prefabs)} packs=${describe(fixed.packs)}`
  );
}

function describe(v) {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})`;
  return typeof v;
}

console.log("\n------------------------------------");
if (fail === 0) {
  console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 0 → ALL PASS`);
} else {
  console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 ${fail} → FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
