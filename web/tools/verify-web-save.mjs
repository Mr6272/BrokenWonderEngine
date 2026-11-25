// bwe.save 与键名归一的行为验证：打成 CJS 在 node 里跑，不需要浏览器。
// 存档用注入的假 Storage，所以不碰本机 localStorage。
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bwe-save-"));
const outfile = join(dir, "api.cjs");
await build({
  entryPoints: ["web/src/webplayer/save.ts", "web/src/webplayer/api.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outdir: dir,
  logLevel: "silent",
});

const saveMod = await import(pathToFileURL(join(dir, "save.js")).href);
const apiMod = await import(pathToFileURL(join(dir, "api.js")).href);

let pass = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fails.push(name + (detail === undefined ? "" : " -> " + JSON.stringify(detail)));
};

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

const warns = [];
const save = saveMod.createSave(
  { project: "扫雷演示", warn: (n, note) => warns.push(n + ":" + note) },
  memStorage()
);

// ---------- 内存 ----------
save.set("level", 3);
save.set("pos", { x: 1, y: 2 });
save.set("flags", [true, false, null]);
ok("get 数字", save.get("level") === 3);
ok("get 缺省", save.get("nope", 7) === 7);
const pos = save.get("pos");
pos.x = 99;
ok("get 返回拷贝", save.get("pos").x === 1, save.get("pos"));
ok("has", save.has("level") === true && save.has("nope") === false);
ok("数组原样", JSON.stringify(save.get("flags")) === "[true,false,null]");

save.set("", 1);
ok("空键是空操作", save.has("") === false);
save.set("fn", () => 1);
ok("函数被拒绝", save.has("fn") === false);
ok("函数只告警一次", warns.length === 1, warns);
save.set("fn2", () => 2);
ok("函数告警不重复", warns.length === 1);

// ---------- 槽位 ----------
ok("write 成功", save.write("slot1") === true);
save.set("level", 9);
ok("write 不改内存", save.get("level") === 9);
ok("exists", save.exists("slot1") === true && save.exists("没有") === false);
ok("read 失败不动内存", save.read("没有") === false && save.get("level") === 9);
ok("read 整体替换", save.read("slot1") === true && save.get("level") === 3 && save.has("pos"));
ok("槽位名清洗", saveMod.slotFile("a/b:c") === "a_b_c.json", saveMod.slotFile("a/b:c"));
ok("空槽位是 auto", saveMod.slotFile("") === "auto.json" && saveMod.slotFile(undefined) === "auto.json");
ok("flush 即 auto", save.flush() === true && save.exists("auto") === true);

save.delete("slot1");
ok("delete 后不存在", save.exists("slot1") === false);
save.clear();
ok("clear", save.has("level") === false && save.get("level", 0) === 0);

// NaN 不能进 JSON
save.set("bad", NaN);
ok("NaN 存成 null", save.get("bad") === null);

// ---------- 键名 ----------
const { canonKey } = apiMod;
ok("W 与 KeyW", canonKey("W") === "KeyW" && canonKey("keyw") === "KeyW" && canonKey("KeyW") === "KeyW");
ok("空格三种写法", canonKey("Space") === "Space" && canonKey(" ") === "Space" && canonKey("space") === "Space",
  [canonKey("Space"), canonKey(" "), canonKey("space")]);
ok("方向键别名", canonKey("Left") === "ArrowLeft" && canonKey("arrowup") === "ArrowUp");
ok("数字键", canonKey("1") === "Digit1" && canonKey("Digit1") === "Digit1");
ok("Esc 别名", canonKey("Esc") === "Escape" && canonKey("escape") === "Escape");

console.log(`verify-web-save: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.error("  FAIL " + f);
  process.exit(1);
}
