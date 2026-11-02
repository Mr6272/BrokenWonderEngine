/**
 * 真 key 协议验证（`--protocol-live`）：跑两轮真实请求，验证「工具轮 + 多轮重放」都不 400。
 *
 * ── 两个前置检查（错一个就会产出「假结果」）─────────────────────────────
 *
 * ① **必须能读到用户的 key**。
 *    原来直接用 `--user-data=<mkdtemp>` 隔离目录 → 里面 settings.json 是空的 →
 *    读不到 key → 整个验证在**没有 key 的情况下空跑**，却报出「失败 5 项」。
 *    那是「假红」：会让人以为协议还是坏的，然后去改本来正确的代码。
 *
 *    现在的做法：把用户真实 `%APPDATA%\BWE Studio\settings.json` **只复制这一个文件**
 *    到临时目录（不复制 sessions，隔离历史）。加密用 DPAPI（绑用户不绑路径），
 *    所以复制后仍可解 —— 前提是它没坏。
 *
 * ② **必须用「解不开」状态判断，不能只看有密文**。
 *    `encryptedApiKey` 存在但解不开时，`hasApiKey` 为 false 且 `keyUndecryptable` 为 true ——
 *    这表示「填过但坏了」，应当 **exit 2 跳过并说明原因**，
 *    而不是当成「有 key」跑下去、然后在空 key 上报失败。
 *
 * 用法：
 *   node desktop/tools/verify-protocol-live.mjs
 *   node desktop/tools/verify-protocol-live.mjs --dry-run   只做前置检查，不花 token
 *
 * 退出码：0 通过 / 1 真的失败（有 key 但协议错）/ 2 跳过（无 key 或 key 解不开）
 *
 * ⚠ **会消耗 token**：两轮对话 + 一次工具调用，量级约 2000~5000 token；用 `--dry-run` 可先不花钱。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO = resolve(DESKTOP, "..");
const ELECTRON = join(DESKTOP, "vendor", "electron", process.platform === "win32" ? "electron.exe" : "electron");
const DRY_RUN = process.argv.includes("--dry-run");

const log = (m) => console.log(`[verify-protocol-live] ${m}`);
const skip = (reason) => {
  log(`跳过：${reason}`);
  return 2;
};

/** 用户真实配置目录（Electron 的 appData/Roaming + productName）。 */
function userDataRoot() {
  const appData = process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming");
  return join(appData, "BWE Studio");
}

async function main() {
  if (!existsSync(ELECTRON)) return skip(`缺少 Electron：${ELECTRON}`);

  const realRoot = userDataRoot();
  const realSettings = join(realRoot, "settings.json");
  if (!existsSync(realSettings)) {
    return skip(`找不到用户配置：${realSettings}\n  （这台机器还没运行过 BWE Studio，或配置被清空）`);
  }

  // ---- 复制 settings（只这一个文件，隔离 sessions）----
  const runDir = await mkdtemp(join(tmpdir(), "live-proto-"));
  const ud = join(runDir, "ud");
  await mkdir(ud, { recursive: true });
  await copyFile(realSettings, join(ud, "settings.json"));
  log(`已复制用户配置（只复制 settings.json，不碰会话历史）`);

  // ---- 先用只读探针拿诊断（不花 token）----
  const diagJson = join(runDir, "diag.json");
  const diag = await runProbe({ ud, outJson: diagJson, protocolLive: false });
  const st = diag?.channels?.["bwe:ai-status"] ?? {};
  const models = diag?.channels?.["bwe:ai-models"]?.models ?? [];
  const withKey = models.filter((m) => m.hasApiKey);
  const broken = models.filter((m) => m.keyUndecryptable);

  log(`诊断：provider=${st.provider} ready=${st.ready} keyUndecryptable=${Boolean(st.keyUndecryptable)}`);
  log(`      模型数=${models.length} 有可用 key=${withKey.length} key 解不开=${broken.length}`);

  if (broken.length || st.keyUndecryptable) {
    // ★ 这是「填过但坏了」，不是「没填」。必须明确报出来并跳过。
    log("");
    log(`⚠ 检测到 ${broken.length} 个 API Key **密文解不开**（不是没填）：`);
    for (const b of broken) log(`   · ${b.id}`);
    log("  成因通常是 Electron safeStorage 在 Windows 上失效（DPAPI 上下文不一致）。");
    log("  下一步：在编辑器「设置 → AI」里**重新粘贴一次 Key**（填完立即生效）。");
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
    return skip("key 存在但解不开 —— 需要用户重新粘贴一次，本次无法验证真实链路");
  }

  if (withKey.length === 0) {
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
    return skip("当前配置里没有可用的真 key（所有条目 hasApiKey=false）");
  }

  if (DRY_RUN) {
    log("dry-run：前置检查通过（有可用 key），未发起真实请求");
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
    return 0;
  }

  log(`即将发起真实请求（约 2000~5000 token）…`);
  const outJson = join(runDir, "probe.json");
  const probe = await runProbe({ ud, outJson, protocolLive: true });
  const res = probe?.channels?.["bwe:protocol-live"];

  // ⚠ 判据必须看**业务字段**，不能只看对象存不存在：
  //   主进程在「没有 key」时返回 { ok:false, skipped:true, reason:"no-key" }，
  //   那种情况是「跳过」而不是「失败」。
  if (!res || res.skipped === true || res.reason === "no-key") {
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
    return skip(`主进程报告无可用 key：${res?.detail ?? res?.reason ?? "未返回结果"}`);
  }

  const failures = [];
  const check = (cond, msg) => {
    if (cond) log(`  ✓ ${msg}`);
    else {
      log(`  ✗ ${msg}`);
      failures.push(msg);
    }
  };

  log("");
  log(`模型：${res.baseUrl || "(空)"} · ${res.model || "(空)"}`);
  check(Boolean(res.model), `模型名非空（实际「${res.model}」）`);
  check((res.errors ?? []).length === 0, `两轮无协议错误（${(res.errors ?? []).length} 条${res.errors?.length ? "：" + String(res.errors[0]).slice(0, 120) : ""}）`);
  check(String(res.firstText ?? "").length > 0, `第 1 轮正文非空（长度 ${String(res.firstText ?? "").length}）`);
  check(String(res.secondText ?? "").length > 0, `第 2 轮正文非空（长度 ${String(res.secondText ?? "").length}）`);
  check(Number(res.toolCalls) >= 1, `第 1 轮真的调用了工具（${res.toolCalls ?? 0} 次）`);
  check((res.statuses ?? []).every((s) => s === 200), `所有请求都是 200（实际 ${JSON.stringify(res.statuses)}）`);

  await rm(runDir, { recursive: true, force: true }).catch(() => {});
  if (failures.length) {
    log(`\n失败 ${failures.length} 项（有 key 但协议仍不对）`);
    return 1;
  }
  log("\n全部通过（真 key：工具轮 + 多轮重放都没有 400）");
  return 0;
}

/** 跑一次主进程探针；返回解析后的 JSON（失败返回 null）。 */
function runProbe({ ud, outJson, protocolLive }) {
  return new Promise((done) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [
      join(DESKTOP, "main.mjs"),
      `--ipc-probe=${outJson}`,
      "--ipc-probe-no-import",
      `--user-data=${ud}`,
      "--console"
    ];
    if (protocolLive) args.push("--protocol-live");

    const child = spawn(ELECTRON, args, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { out += d.toString("utf8"); });

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, 240000);
    child.on("close", (code) => {
      clearTimeout(timer);
      for (const line of out.split(/\r?\n/)) {
        if (/协议验证|protocol|reasoning_content|400|工具依赖|key 密文/.test(line)) console.log(`  ${line}`);
      }
      // 读探针 JSON：先同步读一次，失败再等 200ms 重试一次。
      // 为什么需要重试：主进程 finishProbe 是 async 写盘 + process.exit(0)，
      // 极少数情况下 close 事件到达时文件还没完全落盘。
      const parse = () => {
        try {
          const text = readFileSync(outJson, "utf8");
          // 去掉可能的 UTF-8 BOM（某些写入路径会带）
          let t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
          // 只取第一个完整 JSON 对象（防御末尾混入的日志行）
          const start = t.indexOf("{");
          if (start > 0) t = t.slice(start);
          const end = t.lastIndexOf("}");
          if (end >= 0) t = t.slice(0, end + 1);
          return JSON.parse(t);
        } catch (e) {
          if (process.env.BWE_DEBUG_PROBE_READ) {
            console.error(`[debug] 读 ${outJson} 失败：${e?.message}`);
          }
          return null;
        }
      };
      const first = parse();
      if (first) return done(first);
      setTimeout(() => {
        const second = parse();
        if (!second) {
          // 明确报出来，不要静默 return null（那会让上层误判成"没有 key"）
          const exists = existsSync(outJson);
          const size = exists ? statSync(outJson).size : -1;
          console.error(
            `[verify-protocol-live] 无法解析探针输出：${outJson}（存在=${exists} 大小=${size} 子进程退出码=${code}）`
          );
          if (!exists) {
            console.error("[verify-protocol-live] 子进程输出尾部：");
            console.error(out.split(/\r?\n/).slice(-12).join("\n"));
          }
        }
        done(second);
      }, 200);
    });
  });
}

process.exitCode = await main();
