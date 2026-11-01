#!/usr/bin/env node
/**
 * UI 场景往返一致性校验（和 verify-editor-roundtrip.mjs 同一套思路，专测 UI 场景）。
 *
 * 「UI 场景保存后，必须还能被编辑器重新加载、被导出器导出、被 Java 运行时解析」。
 * 这条链路里最容易静默丢数据的是 `normalizeProject()`：它按字段重建 SceneModel，
 * 任何没接进重建清单的字段都会被丢掉 —— 用户「打开 UI 场景 → 改一个字 → 保存」
 * 之后 UI 场景退化成世界场景，症状是「界面突然出现在地图坐标系里」。
 *
 * 做法：
 *   1. 用真实 `createUiScene()` 造工程 → `normalizeProject()` 往返 → JSON 往返
 *      （等价于用户保存再打开），断言 ui/designW/designH 三个字段原样还在；
 *   2. 把往返后的工程交给**真实的** writeQuickBuild 导出，断言：
 *      boot.uiScenes[] 有内容、scenes[] 只有世界场景、ui_*.json 带 ui/designW/designH、
 *      且其 tileSize=1 / width=designW（运行时 mapWidth 公式才能得到设计像素）；
 *   3. 用 javac 编译运行时、用 `GameData.load` + `GameData.loadScene` 真解析一遍，
 *      断言运行时读到的 ui/designW/designH 与导出值一致（不信 JSON 文本，信解析结果）。
 *
 * 用法：node web/tools/verify-ui-scene.mjs
 * 退出码：0 = 一致；1 = 有丢失/不一致；2 = 环境问题。
 *
 * 写盘范围：.tmp_ui_verify/**（不改任何源码）。
 */

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const TMP = join(ROOT, ".tmp_ui_verify");
const nodeRequire = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const notes = [];
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${detail ? "  [" + detail + "]" : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? "  [" + detail + "]" : ""}`);
  }
}
function note(s) {
  notes.push(s);
  console.log(`  ·  ${s}`);
}

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...opts
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

/** 找一个能编译 --release 8 的 javac（JDK 26 删了 java.applet，JOGL 2.1 起不来）。 */
function findJdk(candidates) {
  for (const home of candidates) {
    if (!home || !existsSync(home)) continue;
    const javac = join(home, "bin", process.platform === "win32" ? "javac.exe" : "javac");
    const java = join(home, "bin", process.platform === "win32" ? "java.exe" : "java");
    if (existsSync(javac) && existsSync(java)) {
      const v = run(javac, ["-version"]);
      const m = /javac\s+(\d+)/.exec(v.out);
      const major = m ? Number(m[1]) : 0;
      if (major >= 17 && major <= 25) return { home, javac, java, major };
    }
  }
  return null;
}

function findJdkAuto() {
  const cands = [];
  if (process.env.LEGACY_JDK_HOME) cands.push(process.env.LEGACY_JDK_HOME);
  if (process.env.JAVA_HOME) cands.push(process.env.JAVA_HOME);
  // 本机常见安装位置
  for (const base of [
    "C:\\Program Files\\Microsoft",
    "C:\\Program Files\\Java",
    "C:\\Program Files\\Eclipse Adoptium",
    "C:\\Program Files\\Amazon Corretto",
    "C:\\Program Files\\Zulu"
  ]) {
    try {
      for (const d of readdirSync(base)) cands.push(join(base, d));
    } catch {
      /* 目录不存在 */
    }
  }
  // 版本号从高到低试（25 → 17）
  cands.sort().reverse();
  return findJdk(cands);
}

// ---------------- 1. 模型往返 ----------------

async function checkModelRoundtrip() {
  console.log("\n========== 1. 模型往返（保存 → 重新打开） ==========");
  // 用 esbuild 把 model.ts 打成临时 ESM，跑**编辑器自己的**真实代码（不是复制公式）
  const bundle = join(TMP, "model.mjs");
  // 直接用 node_modules 里的 esbuild 包装脚本，避免 npx 在离线环境卡住。
  // ⚠ Windows 上 esbuild 是 .cmd 批处理，spawnSync 不能直接执行它（ENOENT），
  //   必须经 cmd.exe，或者直接用 esbuild 的原生 exe（node_modules/esbuild/esbuild.exe 不一定有）。
  const esbuildArgs = ["web/src/core/model.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`, "--log-level=warning"];
  const esbuildCmd = process.platform === "win32"
    ? join(ROOT, "node_modules", ".bin", "esbuild.cmd")
    : join(ROOT, "node_modules", ".bin", "esbuild");
  let b;
  if (existsSync(esbuildCmd)) {
    b = process.platform === "win32"
      ? run("cmd.exe", ["/c", esbuildCmd, ...esbuildArgs])
      : run(esbuildCmd, esbuildArgs);
  } else {
    b = run("npx", ["esbuild", ...esbuildArgs]);
  }
  if (b.code !== 0 || !existsSync(bundle)) {
    check("esbuild 打包 model.ts", false, b.out.slice(0, 400));
    return null;
  }
  const model = await import(new URL(`file:///${bundle.replace(/\\/g, "/")}`).href);

  const project = model.createProject("UI 往返验证");
  const world = project.scenes[0];
  world.objects.push({
    id: "w1", name: "地板", kind: "TILE", x: 100, y: 60, z: 0, rotation: 0, scaleX: 1, scaleY: 1,
    halfW: 0, halfH: 0, layerId: world.layers[0].id, visible: true, locked: false,
    assetId: "", animMode: "默认", animFps: 8, modules: [], props: { color: "#25304a" }, tags: ["tile"], parentId: null
  });

  const ui = model.createUiScene("界面 1", 1280, 720, 32);
  ui.objects.push({
    id: "t1", name: "标题", kind: "PROP", x: 640, y: 180, z: 2, rotation: 0, scaleX: 1, scaleY: 1,
    halfW: 0, halfH: 0, layerId: ui.layers[2].id, visible: true, locked: false, assetId: "",
    animMode: "默认", animFps: 8, modules: [],
    props: { text: "BWE UI", textSize: "48", textColor: "#ffd166", textAlign: "center" },
    tags: ["label", "ui"], parentId: null
  });
  project.scenes.push(ui);

  check("createUiScene 造出的场景 ui=true", ui.ui === true, `ui=${ui.ui}`);
  check("createUiScene 造出的场景 default 1280×720", ui.designW === 1280 && ui.designH === 720, `${ui.designW}×${ui.designH}`);
  check("createUiScene 的图层名是界面语义", ui.layers.map((l) => l.name).join("/") === "背景/界面/浮层", ui.layers.map((l) => l.name).join("/"));

  // 真实往返：JSON 字符串 → normalizeProject（就是「保存再打开」）
  const saved = JSON.stringify(project);
  const reopened = model.normalizeProject(JSON.parse(saved));
  const rUi = reopened.scenes[1];
  check("往返后仍是 2 张场景", reopened.scenes.length === 2, String(reopened.scenes.length));
  check("往返后 ui 标记未丢", rUi?.ui === true, `ui=${rUi?.ui}`);
  check("往返后 designW 未丢", rUi?.designW === 1280, `designW=${rUi?.designW}`);
  check("往返后 designH 未丢", rUi?.designH === 720, `designH=${rUi?.designH}`);
  check("往返后文字对象的 props 未丢", rUi?.objects?.[0]?.props?.text === "BWE UI", JSON.stringify(rUi?.objects?.[0]?.props));
  check("往返后 label tag 未丢", Array.isArray(rUi?.objects?.[0]?.tags) && rUi.objects[0].tags.includes("label"), JSON.stringify(rUi?.objects?.[0]?.tags));
  check("往返后世界场景不会被误标成 UI", reopened.scenes[0].ui !== true, `ui=${reopened.scenes[0].ui}`);
  check("scenePixelSize(UI) 返回设计分辨率", JSON.stringify(model.scenePixelSize(rUi, 32)) === JSON.stringify({ w: 1280, h: 720 }), JSON.stringify(model.scenePixelSize(rUi, 32)));
  check("scenePixelSize(世界) 返回格×tileSize", JSON.stringify(model.scenePixelSize(reopened.scenes[0], 32)) === JSON.stringify({ w: 60 * 32, h: 40 * 32 }), JSON.stringify(model.scenePixelSize(reopened.scenes[0], 32)));
  check("uiSafeArea 在设计分辨率内", (() => {
    const a = model.uiSafeArea(rUi);
    return a.x > 0 && a.y > 0 && a.w === 1280 - 2 * a.x && a.h === 720 - 2 * a.y;
  })(), JSON.stringify(model.uiSafeArea(rUi)));
  return reopened;
}

// ---------------- 2. 导出 ----------------

async function checkExport(project) {
  console.log("\n========== 2. 导出（真实 writeQuickBuild） ==========");
  const outDir = join(TMP, "build");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const { writeQuickBuild } = await import(new URL(`file:///web/tools/package-bwe.mjs`, "file:///").href.replace("file:///", `file:///${ROOT.replace(/\\/g, "/")}/`));

  let build;
  try {
    build = await writeQuickBuild(project, null, outDir, () => {});
  } catch (e) {
    check("writeQuickBuild 成功", false, String(e?.message || e).slice(0, 400));
    return null;
  }
  check("writeQuickBuild 成功", true, `scenes=${build.scenes.length} uiScenes=${build.uiScenes.length}`);
  check("世界场景进 scenes[]", build.scenes.length === 1 && build.scenes[0].file === "scene_0.json", JSON.stringify(build.scenes));
  check("UI 场景进 uiScenes[]", build.uiScenes.length === 1 && build.uiScenes[0].file === "ui_1.json", JSON.stringify(build.uiScenes));
  check("uiScenes 带 designW/designH", build.uiScenes[0]?.designW === 1280 && build.uiScenes[0]?.designH === 720, JSON.stringify(build.uiScenes[0]));

  const buildDir = join(outDir, "Build");
  check("boot.json 存在", existsSync(join(buildDir, "boot.json")));
  const boot = JSON.parse(readFileSync(join(buildDir, "boot.json"), "utf8"));
  check("boot.json 有 uiScenes[]", Array.isArray(boot.uiScenes) && boot.uiScenes.length === 1, JSON.stringify(boot.uiScenes));
  check("boot.json 的 scenes[] 不含 UI 场景", boot.scenes.length === 1 && boot.scenes[0].file === "scene_0.json", JSON.stringify(boot.scenes));

  const uiFile = join(buildDir, "ui_1.json");
  check("ui_1.json 存在", existsSync(uiFile));
  const uiJson = JSON.parse(readFileSync(uiFile, "utf8"));
  check("ui_1.json 顶层 ui=true", uiJson.ui === true, String(uiJson.ui));
  check("ui_1.json designW/designH", uiJson.designW === 1280 && uiJson.designH === 720, `${uiJson.designW}×${uiJson.designH}`);
  check("ui_1.json tileSize=1（让 width×tileSize 恰好等于设计像素）", uiJson.tileSize === 1, String(uiJson.tileSize));
  check("ui_1.json width=designW", uiJson.width === 1280, String(uiJson.width));
  check("ui_1.json 带全部界面对象", uiJson.objects.length === 1, String(uiJson.objects.length));
  check("ui_1.json 对象带 label tag 与 props", uiJson.objects[0]?.tags?.includes("label") === true && uiJson.objects[0]?.props?.text === "BWE UI", JSON.stringify(uiJson.objects[0]?.props));
  check("ui_1.json 不带世界空间字段（buildings/navLinks）", !("buildings" in uiJson) && !("navLinks" in uiJson), Object.keys(uiJson).join(","));

  const sceneFile = join(buildDir, "scene_0.json");
  const sceneJson = JSON.parse(readFileSync(sceneFile, "utf8"));
  check("scene_0.json 没有被写成 UI 场景", sceneJson.ui === undefined, String(sceneJson.ui));
  check("scene_0.json 保持原 tileSize", sceneJson.tileSize === 32, String(sceneJson.tileSize));
  return { buildDir, boot, uiJson, sceneJson };
}

// ---------------- 3. 运行时解析 ----------------

function checkRuntimeParse(buildDir) {
  console.log("\n========== 3. 运行时解析（真编译 + 真 load） ==========");
  const jdk = findJdkAuto();
  if (!jdk) {
    check("找到 JDK 17~25", false, "未找到；可用 LEGACY_JDK_HOME 指定");
    return;
  }
  note(`使用 JDK ${jdk.major}：${jdk.home}`);

  const classes = join(TMP, "classes");
  rmSync(classes, { recursive: true, force: true });
  mkdirSync(classes, { recursive: true });
  const srcFiles = readdirSync(join(ROOT, "src", "Studio", "runtime"))
    .filter((f) => f.endsWith(".java") && f !== "GameLauncher.java" && !f.endsWith("Test.java"))
    .map((f) => join(ROOT, "src", "Studio", "runtime", f));
  const cp = join(ROOT, "lib", "*");
  const c = run(jdk.javac, ["-nowarn", "--release", "8", "-encoding", "utf-8", "-cp", cp, "-sourcepath", join(ROOT, "src"), "-d", classes, ...srcFiles]);
  check("javac 编译运行时", c.code === 0, c.code === 0 ? "" : c.out.slice(0, 600));
  if (c.code !== 0) return;

  // 用同包小驱动读 boot.json：直接调 GameData.load / loadScene（生产代码路径）
  const probe = join(ROOT, "src", "Studio", "runtime", "UiSceneProbe.java");
  const probeSrc = `package Studio.runtime;

import java.io.File;
import java.util.List;

/** 临时探针（verify-ui-scene.mjs 写到 src/Studio/runtime 后立即删除）。 */
public final class UiSceneProbe {
    public static void main(String[] args) throws Exception {
        File boot = new File(args[0]);
        GameData g = GameData.load(boot);
        System.out.println("SCENES=" + g.scenes.size());
        System.out.println("UI_SCENES=" + g.uiScenes.size());
        for (GameData.UiSceneRef r : g.uiScenes) {
            System.out.println("UI_REF=" + r.file + "|" + r.designW + "|" + r.designH);
            File f = new File(boot.getParentFile(), r.file);
            GameData.RtScene s = GameData.loadScene(f, 1);
            System.out.println("UI_SCENE=ui:" + s.ui + "|designW:" + s.designW + "|designH:" + s.designH
                    + "|w:" + s.width + "|h:" + s.height + "|tile:" + s.tileSize + "|objects:" + s.objects.size());
            for (GameData.RtObject o : s.objects) {
                // 中文经 Windows 控制台编码会乱码：标签按 ASCII 序列化成 t0/t1，文字内容走 hex
                // 整条 tag 的 hashCode 比"首字符"更能区分（label 与 look 首字符相同）
                StringBuilder tagHex = new StringBuilder();
                for (String tg : o.tags) { tagHex.append(tg == null ? "" : Integer.toHexString(tg.hashCode())); }
                String text = o.props.get("text");
                StringBuilder textHex = new StringBuilder();
                if (text != null) for (int i = 0; i < text.length(); i++) textHex.append(Integer.toHexString(text.charAt(i))).append(",");
                System.out.println("UI_OBJ=tagCount:" + o.tags.size() + "|tags:" + String.join("/", o.tags).replaceAll("[^\u0000-\u007f]", "?") + "|textHex:" + textHex);
            }
        }
        GameData.SceneRef w = g.scenes.get(0);
        GameData.RtScene ws = GameData.loadScene(new File(boot.getParentFile(), w.file), g.tileSize);
        System.out.println("WORLD_SCENE=ui:" + ws.ui + "|w:" + ws.width + "|h:" + ws.height + "|tile:" + ws.tileSize);
    }
}`;
  writeFileSync(probe, probeSrc, "utf8");
  try {
    const cp2 = run(jdk.javac, ["-nowarn", "--release", "8", "-encoding", "utf-8", "-cp", `${classes}${process.platform === "win32" ? ";" : ":"}${cp}`, "-d", classes, probe]);
    check("javac 编译探针", cp2.code === 0, cp2.code === 0 ? "" : cp2.out.slice(0, 400));
    if (cp2.code !== 0) return;

    const r = run(jdk.java, ["-cp", `${classes}${process.platform === "win32" ? ";" : ":"}${cp}`, "Studio.runtime.UiSceneProbe", join(buildDir, "boot.json")]);
    check("探针运行成功", r.code === 0, r.code === 0 ? "" : r.out.slice(0, 400));
    const lines = r.out.split(/\r?\n/).filter(Boolean);
    const get = (k) => (lines.find((l) => l.startsWith(k + "=")) || "").slice(k.length + 1);
    check("运行时读到 1 张世界场景", get("SCENES") === "1", get("SCENES"));
    check("运行时读到 1 张 UI 场景", get("UI_SCENES") === "1", get("UI_SCENES"));
    check("UI 场景引用带设计分辨率", get("UI_REF") === "ui_1.json|1280|720", get("UI_REF"));
    const uiSceneLine = get("UI_SCENE");
    check("UI scene json 解析出 ui=true", uiSceneLine.includes("ui:true"), uiSceneLine);
    check("UI scene 设计分辨率 1280×720", uiSceneLine.includes("designW:1280") && uiSceneLine.includes("designH:720"), uiSceneLine);
    check("UI scene 宽高按设计像素", uiSceneLine.includes("w:1280") && uiSceneLine.includes("h:720"), uiSceneLine);
    check("UI scene tileSize=1", uiSceneLine.includes("tile:1"), uiSceneLine);
    check("UI scene 有 1 个界面对象", uiSceneLine.includes("objects:1"), uiSceneLine);
    const uiObjLine = get("UI_OBJ");
    // 断言用「tag 集合本身」而不是 hash：探针另外输出一个 ASCII 安全的标签计数与首字符码点。
    check("UI 对象解析出 2 个 tag", uiObjLine.includes("tagCount:2"), uiObjLine.slice(0, 120));
    check("tags 里含 label 与 ui", uiObjLine.includes("tags:label/ui"), uiObjLine.slice(0, 120));
    check("UI 对象解析出文字内容", uiObjLine.includes("42,57,45,20,55,49"), uiObjLine.slice(-80));
    const worldLine = get("WORLD_SCENE");
    check("世界场景解析出 ui=false", worldLine.includes("ui:false"), worldLine);
    check("世界场景宽高按格×tileSize", worldLine.includes("w:60") && worldLine.includes("h:40"), worldLine);
    check("世界场景 tileSize=32", worldLine.includes("tile:32"), worldLine);
  } finally {
    rmSync(probe, { force: true });
  }
}

// ---------------- main ----------------

async function main() {
  console.log("========== UI 场景往返一致性 ==========");
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  try {
    const project = await checkModelRoundtrip();
    if (!project) throw new Error("模型往返失败，后续步骤跳过");
    const built = await checkExport(project);
    if (!built) throw new Error("导出失败，运行时解析跳过");
    checkRuntimeParse(built.buildDir);
  } catch (e) {
    console.log(`\n❌ 中断：${e?.message || e}`);
    fail++;
  }
  console.log(`\n------------------------------------`);
  console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 ${fail} → ${fail === 0 ? "ALL PASS" : "FAIL"}`);
  console.log(`中间产物：${TMP}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
