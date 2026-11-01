/**
 * 「打包到 BWE」前端工作台。
 *
 * 浏览器不能直接调用 jpackage，所以这里只负责：
 *   1. 把 IndexedDB 里的素材栅格化成 PNG / 原样音频；
 *   2. 连同 .bwproj JSON 一起交给本地服务；
 *   3. 轮询进度、展示日志、下载 zip、打开输出目录。
 *
 * 如果页面不是通过 npm run serve 打开的，会直接给出可执行的修复提示，
 * 而不是让用户对着一句「网络错误」猜。
 */

import { store } from "../core/store.ts";
import { apiFetch, nativeHost } from "../core/host.ts";
import { appendOutput } from "../core/output.ts";
import { setProblems, clearProblems, type Problem } from "../core/diagnostics.ts";
import { el, button, input } from "../core/dom.ts";
import { I } from "../ui/icons.ts";
import { error, info, modal, warn } from "../ui/toast.ts";
import { assetFilesForPack } from "../data/assets.ts";
import { moduleDef } from "../data/modules.ts";
import type { Project } from "../core/model.ts";

interface PackStatus {
  ok: boolean;
  node: string;
  javac: boolean;
  jpackage: boolean;
  wix: boolean;
  appImage: boolean;
  android?: { ok: boolean; gradlew: string | null; projectDir: string } | null;
  port: number;
  outRoot: string;
}

interface PackJobResult {
  platform?: string;
  appName: string;
  version: string;
  outDir: string;
  buildDir?: string;
  appDir?: string;
  exeName?: string;
  exePath?: string;
  apkName?: string;
  apkPath?: string;
  zipName?: string;
  zipPath?: string;
  sizeBytes: number;
  warnings: string[];
}

interface PackJob {
  id: string;
  status: "running" | "done" | "error";
  logs: string[];
  error: string | null;
  result?: PackJobResult;
}

/** /api/js-check 返回的一条诊断（行号列号都相对用户脚本，1 开始）。 */
interface JsDiagnostic {
  line: number;
  col: number;
  severity: "error" | "warning";
  message: string;
}

interface JsCheckResult {
  ok: boolean;
  name?: string;
  hasTypes?: boolean;
  diagnostics?: JsDiagnostic[];
  transpiled?: string;
  error?: string;
}

interface QuickRunResult {
  ok: boolean;
  pid?: number;
  error?: string;
  warnings?: string[];
  logFile?: string;
  logTail?: string;
}

interface QuickRunStatus {
  ok: boolean;
  running: boolean;
  pid: number | null;
  project?: string;
  startedAt?: string | null;
  logTail?: string;
  error?: string;
}

interface UploadedAssetPayload {
  id: string;
  files: { name: string; data: string }[];
  error?: string;
}

/**
 * 下载打包产物。
 *
 * 网页版：直接 `location.href = /api/package-bwe/download/<jobId>`，浏览器接管。
 * 桌面版：**这条路不通** —— 页面跑在 file:// 协议下，跳转 /api 只会得到 404，
 * 而且 Electron 不会给 file:// 页面弹下载。主进程为此暴露了 downloadFile()，
 * 它会读本地文件并弹原生保存对话框（契约见 host.ts 的 BweHost.downloadFile）。
 *
 * cancelled=true 是用户主动取消，不是失败 —— 弹红条会让人以为保存坏了。
 */
function downloadArtifact(jobId: string, apk: boolean): void {
  const h = nativeHost();
  const path = apk
    ? `/api/package-bwe/download-apk/${jobId}`
    : `/api/package-bwe/download/${jobId}`;

  if (h?.downloadFile) {
    void h
      .downloadFile(path)
      .then((r) => {
        if (r?.cancelled) return;
        if (r?.ok === false) {
          error(`保存失败：${r.error ?? "未知原因"}`);
          return;
        }
        info(apk ? "已保存 APK" : "已保存 ZIP");
      })
      .catch((e: unknown) => error(`保存失败：${(e as Error)?.message ?? String(e)}`));
    return;
  }
  window.location.href = path;
}

/** 工程里的 JS 脚本（lang 缺省是 yarn，不算）。 */
function projectJsScripts(p: Project): { name: string; source: string }[] {
  const raw = (p.scripts ?? {}) as unknown as Record<
    string,
    { name?: string; lang?: string; source?: string } | null | undefined
  >;
  return Object.entries(raw)
    .filter(([, s]) => s && String(s.lang ?? "yarn").toLowerCase() === "js")
    .map(([key, s]) => ({ name: String(s?.name ?? key), source: String(s?.source ?? "") }));
}

/**
 * 打包/试跑的错误与日志要能被"事后复盘"：
 *   - 日志进「输出」面板（关掉弹窗也不丢）；
 *   - 错误进「问题」面板（底部徽标会显示，用户不用记住弹窗里写了什么）。
 * 这里集中成两个小函数，避免在四五个分支里各写一遍。
 */
function logPack(text: string, level: "info" | "ok" | "warn" | "error" = "info"): void {
  appendOutput("打包", text, level);
}

function logRun(text: string, level: "info" | "ok" | "warn" | "error" = "info"): void {
  appendOutput("试跑", text, level);
}

/** 把一条打包/试跑错误写进问题面板（没有源码行，点它只会跳去输出）。 */
function reportBuildError(source: "package" | "run", message: string, label: string): void {
  const list: Problem[] = message
    ? [{
        id: `${source}#0`,
        severity: "error",
        source,
        sourceLabel: label,
        message
      }]
    : [];
  setProblems(source, list);
}

/**
 * 把 IndexedDB 里的素材栅格化成可上传的 base64。
 * 打包与试跑共用这一份，避免两条路径对素材的收集规则不一致（一边转 PNG、一边丢掉）。
 */
async function collectUploads(
  p: Project,
  say: (s: string) => void
): Promise<{ uploaded: UploadedAssetPayload[]; packed: number }> {
  const uploaded: UploadedAssetPayload[] = [];
  let done = 0;
  let packed = 0;
  for (const asset of p.assets) {
    done++;
    say(`收集素材 ${done}/${p.assets.length}：${asset.name}`);
    const pack = await assetFilesForPack(asset);
    if (pack.error) {
      say(`  ⚠ 跳过「${asset.name}」：${pack.error}`);
      uploaded.push({ id: asset.id, files: [], error: pack.error });
      continue;
    }
    if (!pack.files.length) {
      uploaded.push({ id: asset.id, files: [], error: "没有可打包的文件" });
      continue;
    }
    const files: { name: string; data: string }[] = [];
    for (const f of pack.files) {
      files.push({ name: f.name, data: await blobToBase64(f.blob) });
    }
    uploaded.push({ id: asset.id, files });
    packed++;
  }
  return { uploaded, packed };
}

/** 当前 Java 运行时真的会执行的模块；其余只保留数据，不会被解释。 */
const RUNTIME_MODULES = new Set([
  // script.js：运行时会按事件调用脚本里的 onStart / onUpdate / onClick …（ScriptEngine.bindSceneObjects）
  "script.js",
  "move.follow",
  "move.patrol",
  "move.wander",
  "move.flee",
  "move.locked",
  "combat.health",
  "fight.hp",
  "fx.cameraFollow",
  "show.camera",
  "render.shadow",
  "look.shadow",
  "render.blink",
  "look.blink",
  "render.sortByY",
  "look.sortByY",
  "render.playOnce",
  "look.playOnce",
  "game.minesweeper",
  "game.dressup",
  "game.dressPart"
]);

/**
 * 扫描工程里运行期不执行的模块。
 *
 * 注意预制体（prefabs）也要扫：预制体虽然「这一刻还没被摆进场景」，但导出后会进
 * boot.json 的 `prefabs[]`，运行期 `bwe.prefab.spawn()` 一调就真的会生成对象。
 * 只看场景对象会漏掉「模板里挂了一个运行时不认的模块」这种情况 —— 用户会以为
 * 预制体是干净的，一生成才发现行为不对。
 *
 * 返回 `{ ids, inPrefab }`：
 *   ids      —— 所有不支持的 defId（去重）
 *   inPrefab —— 其中至少出现在某个预制体里的（用于把提示说得更准）
 */
function unsupportedModules(p: Project): { ids: string[]; inPrefab: Set<string> } {
  const out = new Set<string>();
  const inPrefab = new Set<string>();
  for (const scene of p.scenes) {
    for (const obj of scene.objects) {
      for (const m of obj.modules) {
        if (!m.enabled) continue;
        if (!RUNTIME_MODULES.has(m.defId)) out.add(m.defId);
      }
    }
  }
  for (const prefab of p.prefabs ?? []) {
    for (const m of prefab.modules ?? []) {
      if (!m.enabled) continue;
      if (!RUNTIME_MODULES.has(m.defId)) {
        out.add(m.defId);
        inPrefab.add(m.defId);
      }
    }
  }
  return { ids: [...out], inPrefab };
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function instructionsModal(title: string, lines: string[]): void {
  modal({
    title,
    body: (() => {
      const box = el("div", { class: "col" });
      for (const line of lines) {
        box.appendChild(el("div", { class: "hint", style: { lineHeight: "1.75" } }, line));
      }
      return box;
    })(),
    actions: [{ label: "知道了", variant: "primary", onClick: (close) => close() }]
  });
}

export async function openBwePackager(): Promise<void> {
  const p = store.project;
  if (!p) {
    warn("先打开一个工程");
    return;
  }

  let status: PackStatus | null = null;
  try {
    const resp = await apiFetch("/api/package-bwe/status", { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    status = (await resp.json()) as PackStatus;
  } catch {
    reportBuildError("package", "打包服务不可用（/api/package-bwe/status 无响应）", "打包 BWE");
    logPack("打包服务不可用：/api/package-bwe/status 请求失败", "error");
    instructionsModal("打包服务没有启动", [
      "「打包到 BWE」要调用 JDK 的 jpackage，需要一个本地 Node 服务。",
      "网页版：在项目根目录运行 npm run serve，再从对应地址打开编辑器。",
      "桌面版：主进程内已内置这套能力，出现这条说明宿主 IPC 没有接上（看「输出」面板里的错误）。",
      "",
      "如果你已经用其他端口启动，请从对应地址打开页面。",
      "没有 JDK 时，服务会显示缺少 javac / jpackage；安装 JDK 17+ 后重启服务即可。"
    ]);
    return;
  }

  if (!status || !status.ok) {
    instructionsModal("本机缺少打包工具", [
      `Node：${status?.node ?? "未知"}`,
      `javac：${status?.javac ? "已找到" : "缺失"}`,
      `jpackage：${status?.jpackage ? "已找到" : "缺失"}`,
      "",
      "安装 JDK 17 或更高版本，把 bin 目录加入 PATH，然后重启 npm run serve。",
      "Windows 便携应用不需要 WiX；只有做安装器（setup.exe）才需要。"
    ]);
    return;
  }
  const st = status;
  // 打包平台：windows = 现有 Windows EXE（jpackage）；android = Android APK（gradle assembleDebug）。
  // ⚠ 这行原来是 `let platform: "windows" | "android" = "windows";`，
  // 字面量类型被推断成 "windows"，于是下面 `platform === "android"` 永远为 false
  // （tsc 直接报 TS2367：两个类型没有重叠）。等于 Android 分支是死代码 ——
  // 打包 Android 时从不检查 gradlew/SDK 是否就绪，直接往下跑到 Gradle 才失败。
  // 用显式泛型标注保留联合类型，分支才真的可达。
  let platform = "windows" as "windows" | "android";
  if (platform === "android" && st.android?.ok !== true) {
    instructionsModal("本机缺少 Android 打包条件", [
      "Android 打包需要 android/gradlew 脚本 + Android SDK（compileSdk 34）在本机。",
      `gradlew：${st.android?.gradlew ?? "缺失"}`,
      `Android 工程：${st.android?.projectDir ?? ""}`,
      "",
      "装好 Android SDK 后，点「打包 Android APK」即可通过 Gradle 生成 debug APK。"
    ]);
    return;
  }
  // 弹窗关闭时停掉「试跑」的 1s 轮询；body 里会把它指到真正的 clearInterval 上。
  let stopRunPolling: () => void = () => {};

  const unsupported = unsupportedModules(p);
  const multipleScenes = p.scenes.length > 1;
  const prefabCount = (p.prefabs ?? []).length;

  modal({
    title: platform === "android" ? "打包到 BWE · Android APK" : "打包到 BWE · Windows EXE",
    xwide: true,
    closeOnMask: false,
    // 关掉面板就停止轮询试跑日志；Java 窗口本身保留，用户可再开面板点「停止试跑」。
    onClose: () => stopRunPolling(),
    body: () => {
      const wrap = el("div", { class: "col pkg-workbench" });

      wrap.appendChild(
        el(
          "div",
          { class: "hint" },
          platform === "android"
            ? "把当前工程交给 BWE Android 运行时，通过 Gradle assembleDebug 生成 debug APK，拷进 android/app/src/main/assets/BWE/。"
              + "装上 Android 工程（gradlew + Android SDK）后即可在安卓设备上运行。"
            : "把当前工程交给 BWE Java 运行时，生成自带 Java 的 Windows 应用目录，再压缩成 zip。"
              + "解压后双击里面的 .exe 即可运行，目标机器不需要安装 Java。"
        )
      );

      const infoRow = el("div", { class: "pkg-meta" });
      infoRow.appendChild(el("span", {}, `工程：${p.name}`));
      infoRow.appendChild(el("span", {}, `场景：${p.scenes.length}`));
      infoRow.appendChild(el("span", {}, `素材：${p.assets.length}`));
      infoRow.appendChild(el("span", {}, `Node ${st.node}`));
      wrap.appendChild(infoRow);

      if (multipleScenes) {
        wrap.appendChild(
          el("div", { class: "hint pkg-warn" },
            `注意：当前运行时会加载第一张场景「${p.scenes[0]?.name ?? ""}」，多场景切换模块暂未实现。`)
        );
      }
      // 预制体也会进 boot.json，运行期 bwe.prefab.spawn() 一调就真的生成对象，
      // 所以这里报一句「它们会被导出」比让用户猜要清楚。
      if (prefabCount > 0) {
        const withBad = unsupported.inPrefab.size;
        wrap.appendChild(
          el("div", { class: "hint" },
            withBad > 0
              ? `工程里有 ${prefabCount} 个预制体会一起导出；其中 ${withBad} 种模块运行期不执行（预制体数据保留，生成出来的对象不会带这块行为）。`
              : `工程里有 ${prefabCount} 个预制体会一起导出，运行期可以用 bwe.prefab.spawn("名字") 生成。`)
        );
      }
      if (unsupported.ids.length > 0) {
        const names = unsupported.ids.slice(0, 12).map((id) => moduleDef(id)?.title ?? id);
        wrap.appendChild(
          el("div", { class: "hint pkg-warn" },
            `以下 ${unsupported.ids.length} 个模块在打包运行时里不会执行（工程数据保留，不会报错）：`
              + names.join("、") + (unsupported.ids.length > 12 ? "…" : ""))
        );
      }

      const form = el("div", { class: "pkg-form" });
      form.appendChild(el("label", { class: "pkg-label" }, "应用名称（显示在窗口标题和 exe 文件名）"));
      const nameI = input(p.name, { hint: "建议使用英文名，兼容性最好；中文名会自动重试" });
      form.appendChild(nameI);

      form.appendChild(el("label", { class: "pkg-label" }, "版本号"));
      const verI = input("1.0.0", { hint: "三段数字，例如 1.0.0" });
      form.appendChild(verI);

      const consoleRow = el("label", { class: "pkg-check" });
      const consoleBox = el("input", { type: "checkbox" }) as HTMLInputElement;
      consoleRow.appendChild(consoleBox);
      consoleRow.appendChild(el("span", {}, "保留控制台窗口（调试用，正常发布不要勾）"));
      form.appendChild(consoleRow);
      wrap.appendChild(form);

      const actionRow = el("div", { class: "row tight" });
      const startBtn = button("开始打包", () => void start("windows"), {
        variant: "primary",
        iconPath: I.exportImg,
        title: "生成 Windows 应用与 zip"
      });
      const apkBtn = button("打包 Android APK", () => void start("android"), {
        variant: "outline",
        iconPath: I.exportImg,
        title: "通过 ./gradlew assembleDebug 生成 Android debug APK"
      });
      // 试跑：不打包，直接在本机起 Java 窗口。先做 JS 诊断，有 error 就停在提示。
      const runBtn = button("试跑", () => void tryRun(), {
        variant: "outline",
        iconPath: I.play,
        title: "不做 Windows 包，直接在本机启动 Java 运行时看效果"
      });
      actionRow.appendChild(startBtn);
      actionRow.appendChild(apkBtn);
      actionRow.appendChild(runBtn);
      actionRow.appendChild(
        el("span", { class: "hint pkg-hint" },
          st.wix ? "已检测到 WiX，但本版本仍输出便携 zip。" : "未安装 WiX：输出便携 zip；安装器 exe 不在本版本范围。")
      );
      wrap.appendChild(actionRow);

      const logBox = el("pre", { class: "pkg-log" }, "等待开始…");
      wrap.appendChild(logBox);
      const resultBox = el("div", { class: "pkg-result" });
      wrap.appendChild(resultBox);

      // ---------- 试跑面板（日志 + 停止）----------
      const runSection = el("div", { class: "col" });
      runSection.appendChild(el("div", { class: "pkg-label" }, "试跑（本机 Java 窗口，不生成 exe）"));
      runSection.appendChild(
        el("div", { class: "hint" },
          "先用 TypeScript 检查全部 JS 脚本：有 error 会停下来并列出位置；没有错误就直接起 Java 窗口。"
            + "日志每秒刷新，改完代码可以再点一次「试跑」。")
      );
      const runLogBox = el("pre", { class: "pkg-log" }, "点上方「试跑」启动本机 Java 窗口…");
      runSection.appendChild(runLogBox);
      const runRow = el("div", { class: "row tight" });
      const stopBtn = button("停止试跑", () => void stopRun(), {
        variant: "danger",
        size: "sm",
        iconPath: I.stop,
        title: "结束本机 Java 试跑进程（Windows 下杀整棵进程树）",
        disabled: true
      });
      runRow.appendChild(stopBtn);
      const runHint = el("span", { class: "hint pkg-hint" }, "未启动");
      runRow.appendChild(runHint);
      runSection.appendChild(runRow);
      wrap.appendChild(runSection);

      let busy = false;
      let lastJobId = "";

      // ---- 试跑状态 ----
      let runTimer: number | null = null;
      let runStarting = false;
      let runPid = 0;

      const setRunLog = (lines: string[] | string): void => {
        const text = Array.isArray(lines) ? lines.join("\n") : lines;
        runLogBox.textContent = text || "（没有日志）";
        runLogBox.scrollTop = runLogBox.scrollHeight;
      };

      function stopPolling(): void {
        if (runTimer !== null) {
          window.clearInterval(runTimer);
          runTimer = null;
        }
      }
      // 弹窗关闭后停止轮询（Java 进程保留，用户可以从任务栏关窗口，或再开面板点停止）。
      stopRunPolling = stopPolling;

      async function refreshRunStatus(): Promise<void> {
        try {
          const resp = await apiFetch("/api/quick-run/status", { cache: "no-store" });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = (await resp.json()) as QuickRunStatus;
          if (data.logTail) setRunLog(data.logTail);
          if (data.running) {
            runPid = data.pid ?? runPid;
            stopBtn.disabled = false;
            runHint.textContent = `运行中 · PID ${data.pid} · 日志每秒刷新`;
          } else {
            stopPolling();
            runPid = 0;
            stopBtn.disabled = true;
            runHint.textContent = "试跑进程已退出";
          }
        } catch (e) {
          stopPolling();
          const msg = e instanceof Error ? e.message : String(e);
          setRunLog(`${runLogBox.textContent ?? ""}\n读取试跑状态失败：${msg}`);
          runHint.textContent = "状态读取失败";
        }
      }

      async function tryRun(): Promise<void> {
        if (!p || runStarting) return;
        runStarting = true;
        stopPolling();
        runBtn.disabled = true;
        runBtn.textContent = "准备中…";
        stopBtn.disabled = true;
        runHint.textContent = "检查 JS 脚本诊断…";
        const lines: string[] = [];
        const say = (s: string): void => {
          lines.push(s);
          setRunLog(lines);
          logRun(s);
        };
        try {
          const jsScripts = projectJsScripts(p);
          let errors = 0;
          if (jsScripts.length === 0) {
            say("工程里没有 JS 脚本，直接试跑。");
          } else {
            for (const script of jsScripts) {
              const r = await apiFetch("/api/js-check", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ source: script.source, name: script.name })
              });
              const data = (await r.json()) as JsCheckResult;
              if (!r.ok) {
                say(`⚠ 脚本「${script.name}」诊断服务不可用：${data.error || `HTTP ${r.status}`}`);
                continue;
              }
              const diagnostics = data.diagnostics ?? [];
              const errs = diagnostics.filter((d) => d.severity === "error");
              errors += errs.length;
              say(
                `脚本「${script.name}」：${errs.length} 个错误 / ${diagnostics.length - errs.length} 个警告`
                  + (data.hasTypes ? "" : "（bwe.d.ts 不可用，只做了语法检查）")
              );
              for (const d of diagnostics) {
                say(`  ${d.severity === "error" ? "✗" : "⚠"} 第 ${d.line} 行第 ${d.col} 列：${d.message}`);
              }
            }
            if (errors > 0) {
              // 有 error 就停在这里：起 Java 窗口也只会看到脚本报错，先把源码改对。
              say(`✗ 有 ${errors} 个脚本错误，先修好再试跑（没有发起试跑请求）。`);
              runHint.textContent = "脚本有错误，未启动试跑";
              error(`JS 脚本有 ${errors} 个错误`);
              return;
            }
            say(`✓ ${jsScripts.length} 个 JS 脚本诊断通过`);
          }

          say("准备素材…");
          const { uploaded, packed } = await collectUploads(p, say);
          say(`素材 ${packed}/${p.assets.length} 项，请求启动 Java 运行时…`);
          runHint.textContent = "启动 Java 运行时…";
          const resp = await apiFetch("/api/quick-run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ project: p, assets: uploaded, name: p.name })
          });
          const data = (await resp.json()) as QuickRunResult;
          if (data.logTail) setRunLog(data.logTail);
          if (!resp.ok || !data.ok) {
            throw new Error(data.error || `试跑失败（HTTP ${resp.status}）`);
          }
          runPid = data.pid ?? 0;
          for (const w of data.warnings ?? []) say(`⚠ ${w}`);
          say(`✓ Java 已启动：PID ${data.pid}（日志：${data.logFile ?? ".build/quickrun/run.log"}）`);
          stopBtn.disabled = false;
          runHint.textContent = `运行中 · PID ${data.pid}`;
          stopPolling();
          runTimer = window.setInterval(() => void refreshRunStatus(), 1000);
          void refreshRunStatus();
          clearProblems("run");
          info(`试跑已启动：PID ${data.pid}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          say(`✗ ${msg}`);
          error(`试跑失败：${msg}`);
          reportBuildError("run", msg, "试跑");
          runHint.textContent = "试跑失败";
        } finally {
          runStarting = false;
          runBtn.disabled = false;
          runBtn.textContent = "试跑";
        }
      }

      async function stopRun(): Promise<void> {
        stopPolling();
        stopBtn.disabled = true;
        runHint.textContent = "正在结束试跑…";
        try {
          const resp = await apiFetch("/api/quick-run/stop", { method: "POST" });
          const data = (await resp.json()) as QuickRunStatus & { stopped?: boolean };
          if (data.logTail) setRunLog(data.logTail);
          runPid = 0;
          if (data.stopped) {
            runHint.textContent = "已停止试跑";
            info("已停止试跑");
          } else {
            runHint.textContent = "当前没有在跑的试跑进程";
            info("没有在跑的试跑进程");
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setRunLog(`${runLogBox.textContent ?? ""}\n停止试跑失败：${msg}`);
          warn("停止试跑失败，请手动结束 java 进程");
        }
      }

      const setLogs = (lines: string[]) => {
        const text = lines.length ? lines.join("\n") : "等待开始…";
        logBox.textContent = text;
        logBox.scrollTop = logBox.scrollHeight;
      };

      async function start(plat: "windows" | "android" = "windows"): Promise<void> {
        if (busy) return;
        busy = true;
        platform = plat;
        startBtn.disabled = true;
        startBtn.textContent = "打包中…";
        resultBox.replaceChildren();
        const local: string[] = [];
        let remoteLogs: string[] = [];
        const display = () => setLogs([...remoteLogs, ...local].slice(-160));
        const say = (s: string) => {
          local.push(s);
          if (local.length > 120) local.splice(0, local.length - 120);
          display();
          // 同一句同时写进「输出」：弹窗一关掉，用户还能翻回去看
          logPack(s);
        };
        try {
          if (!p) throw new Error("工程已关闭");
          const name = nameI.value.trim() || p.name;
          const version = verI.value.trim() || "1.0.0";
          say(`准备打包「${name}」v${version}（平台：${plat}）`);

          // 素材失败也要把原因一起上传：服务端 writeBuild 会把它写进 result.warnings，
          // 「这局游戏里某张图变成色块」的原因就不会只留在前端日志里。
          const { uploaded, packed } = await collectUploads(p, say);
          say(`素材准备完成：${packed}/${p.assets.length} 项，开始上传工程…`);

          const body = JSON.stringify({
            project: p,
            assets: uploaded,
            name,
            version,
            console: consoleBox.checked,
            platform: plat
          });
          const resp = await apiFetch("/api/package-bwe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body
          });
          const data = (await resp.json()) as { ok?: boolean; jobId?: string; error?: string };
          if (!resp.ok || !data.jobId) {
            throw new Error(data.error || `打包请求失败（HTTP ${resp.status}）`);
          }
          lastJobId = data.jobId;
          say(`任务已创建：${lastJobId}`);

          let job: PackJob | null = null;
          for (;;) {
            await delay(750);
            const r = await apiFetch(`/api/package-bwe/jobs/${lastJobId}`, { cache: "no-store" });
            if (!r.ok) throw new Error(`读取进度失败（HTTP ${r.status}）`);
            const jd = (await r.json()) as { ok?: boolean; job?: PackJob; error?: string };
            if (!jd.job) throw new Error(jd.error || "任务状态为空");
            job = jd.job;
            if (job.logs?.length) {
              // 服务端日志到达后，丢掉前端「准备阶段」的重复行，之后两边合并展示。
              if (remoteLogs.length === 0) local.length = 0;
              remoteLogs = job.logs;
              display();
            }
            if (job.status === "done" || job.status === "error") break;
          }
          if (!job) throw new Error("没有拿到打包任务状态");

          if (job.status === "error") {
            throw new Error(job.error || "打包失败");
          }
          const r = job.result;
          if (!r) throw new Error("打包完成但没有返回结果");
          const doneLabel = r.apkName || r.zipName || r.exeName || "产物";
          say(`打包完成：${doneLabel}（${formatBytes(r.sizeBytes)}）`);
          renderResult(r, lastJobId);
          clearProblems("package");
          info(`打包完成：${doneLabel}`);
          startBtn.textContent = "重新打包";
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          say(`✗ ${msg}`);
          error(`打包失败：${msg}`);
          reportBuildError("package", msg, "打包 BWE");
          startBtn.textContent = "重试打包";
        } finally {
          busy = false;
          startBtn.disabled = false;
        }
      }

      function renderResult(r: NonNullable<PackJob["result"]>, jobId: string): void {
        resultBox.replaceChildren();
        resultBox.appendChild(el("div", { class: "pkg-result-title" }, r.platform === "android" ? "Android APK 打包完成" : "打包完成"));
        const nameLabel = r.apkName || r.zipName || r.exeName || r.appName;
        resultBox.appendChild(
          el("div", { class: "hint" },
            `${nameLabel} · ${r.version} · ${formatBytes(r.sizeBytes)}`)
        );
        resultBox.appendChild(el("div", { class: "hint pkg-path" }, `输出目录：${r.outDir}`));
        const row = el("div", { class: "row tight" });
        if (r.platform === "android" && r.apkPath) {
          row.appendChild(
            button("下载 APK", () => downloadArtifact(jobId, true), {
              variant: "primary",
              iconPath: I.import,
              title: "下载 Android debug APK"
            })
          );
        } else if (r.zipName) {
          row.appendChild(
            button("下载 ZIP", () => downloadArtifact(jobId, false), {
              variant: "primary",
              iconPath: I.import,
              title: "下载包含 exe 的 Windows 应用包"
            })
          );
        }
        row.appendChild(
          button("打开输出目录", () => {
            void apiFetch(`/api/package-bwe/open/${jobId}`).catch(() => {
              warn("打不开资源管理器，请手动复制输出目录");
            });
          }, { size: "sm", iconPath: I.open })
        );
        resultBox.appendChild(row);
        if (r.warnings?.length) {
          for (const w of r.warnings) {
            resultBox.appendChild(el("div", { class: "hint pkg-warn" }, `⚠ ${w}`));
          }
        }
        resultBox.appendChild(
          el("div", { class: "hint" },
            r.platform === "android"
              ? "APK 已生成（debug）。可用 ADB / 文件传输安装到 Android 设备（需开启未知来源/安装权限）。"
              : "解压后双击 exe 运行；如果启动失败，查看 Build/bwe.log。")
        );
      }

      return wrap;
    },
    actions: [
      { label: "关闭", variant: "ghost", onClick: (close) => close() }
    ]
  });
}
