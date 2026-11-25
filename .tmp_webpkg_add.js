
/**
 * 导出 Web 游戏包。
 *
 * 与 Windows / Android 的目标不同点：Web 产物不是一个可执行容器，而是一个
 * 目录——把 Build 产物 + 播放器（player.js）+ index.html 摆在一起，扔到任何
 * 静态服务器上就能玩。
 *
 * 关键约束：浏览器里没有 JOGL（它是本地库），所以 Web 端不能用 Java 渲染。
 * 这里的做法是「同一份 Build 产物，换一个渲染实现」：web/src/webplayer 是
 * 一个消费 boot.json / scene_0.json / assets 的 WebGL2 播放器。数据格式完全相同，
 * 脚本源码（ES5）直接复用。
 *
 * 诚实说明：播放器目前实现的 API 是渲染/输入/时间/相机/基础音频与基础绘制
 * （见 web/src/webplayer/api.ts 里的三级清单）。用到 bwe.road / bwe.combat
 * 这类高级命名空间的项目，在 Web 端会缺少对应行为，但**不会静默失败**——
 * 会在控制台按名字报出来，可用 __bwe_report() 一次看全。
 */
export async function packageWeb(project, uploadedAssets, options = {}, onLog = console.log) {
  if (!project || !Array.isArray(project.scenes)) {
    throw new Error("工程数据不完整：缺少 scenes");
  }
  const jobId = safeId(options.jobId || `build_web_${Date.now()}`);
  const outRoot = resolve(options.outDir || join(packageRoot, jobId));
  const buildDir = join(outRoot, "work");
  const outDir = join(outRoot, "out");
  await rm(outRoot, { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const appName = safeSegment(options.name || project.name || "BWE-Web", "BWE-Web");
  const version = safeVersion(options.version || project.version);
  const warnings = [];

  logStep(onLog, `开始导出 Web 包「${appName}」v${version}`);

  // 1/3 工程数据 -> Build 产物（与 Windows/Android 完全同一条路径）
  logStep(onLog, "1/3 转换工程数据与素材…");
  const uploaded = uploadedAssets
    ? normalizeUploadedAssets(uploadedAssets)
    : await collectDataUrlAssets(project, onLog);
  const build = await writeBuild(project, buildDir, uploaded.files, onLog, warnings, uploaded.problems);
  for (const w of warnings) logStep(onLog, `⚠ ${w}`);

  // 2/3 把 Build 产物挪到产物根目录下
  logStep(onLog, "2/3 拷贝 Build 产物…");
  const buildOut = join(outDir, "Build");
  await cp(buildDir, buildOut, { recursive: true });

  // 3/3 打包播放器：esbuild 把 web/src/webplayer 打成一个 player.js
  logStep(onLog, "3/3 打包 Web 播放器…");
  const playerSrc = join(webRoot, "src", "webplayer", "main.ts");
  if (!existsSync(playerSrc)) {
    throw new Error(`找不到播放器源码: ${playerSrc}`);
  }
  const playerOut = join(outDir, "player.js");
  const esbuildBin = join(repoRoot, "node_modules", "esbuild", "bin", "esbuild");
  const esbuildArgs = [
    playerSrc,
    "--bundle",
    "--format=iife",
    "--platform=browser",
    "--target=es2020",
    "--minify",
    `--outfile=${playerOut}`,
  ];
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [esbuildBin, ...esbuildArgs], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`播放器打包失败 (exit ${code}):\n${err}`));
    });
  });

  // index.html：标题替换成工程名
  const htmlSrc = join(webRoot, "src", "webplayer", "index.html");
  let html = await readFile(htmlSrc, "utf8");
  html = html.replace(/__BWE_GAME_TITLE__/g, escapeHtml(appName));
  await writeFile(join(outDir, "index.html"), html, "utf8");

  // 一份 README，说明怎么把它跑起来 / 怎么部署
  const readme = [
    `# ${appName} (Web 导出)`,
    "",
    `由 BrokenWonderEngine 导出于 ${new Date().toISOString()}`,
    "",
    "## 怎么跑起来",
    "",
    "浏览器不允许直接从 file:// 读 JSON（fetch 被拦），所以要起一个静态服务器：",
    "",
    "```bash",
    "npx serve .",
    "# 或",
    "python -m http.server 8000",
    "```",
    "",
    "然后打开提示的地址。",
    "",
    "## 怎么部署",
    "",
    "把整个目录原样上传到任意静态托管（itch.io、GitHub Pages、Netlify、Nginx）即可。",
    "没有后端依赖，没有特殊响应头要求。",
    "",
    "## 出问题时",
    "",
    "打开浏览器控制台：",
    "",
    "- `__bwe_stats` — 帧率、帧耗时、对象数、draw call",
    "- `__bwe_report()` — 哪些 API 在 Web 端还没实现（这是导出产物，不是 bug）",
    "",
    "### 已知限制",
    "",
    "Web 播放器复用同一份 Build 数据，但渲染是由 WebGL2 重新实现的，",
    "而不是运行 Java 运行时。以下能力在 Web 端是简化或缺失的：",
    "",
    "- 高级玩法命名空间（road / vehicle / combat / material / field / sense /",
    "  faction / nav / physics / quest / dialog 等）尚未移植",
    "- 光照与后处理未实现",
    "- 虚拟摇杆、输入框等移动端 UI 控件未实现",
    "",
    "用到这些的项目，Web 端会在控制台按名字报出缺失调用，不会静默失效。",
    "",
    `工程名: ${appName}`,
    `版本: ${version}`,
    `素材: ${(build.assets ?? []).length ?? "?"}`,
    "",
  ].join("\n");
  await writeFile(join(outDir, "README-WEB.md"), readme, "utf8");

  const stats = {
    appName,
    version,
    outDir,
    playerBytes: (await stat(playerOut)).size,
    buildFiles: await countFiles(buildOut),
    warnings,
    limitations: [
      "高级玩法命名空间未移植（road/vehicle/combat/material/field/sense/faction/nav/physics/quest/dialog）",
      "光照与后处理未实现",
      "移动端虚拟摇杆与输入控件未实现",
    ],
  };
  logStep(onLog, `完成：${outDir}`);
  logStep(onLog, `player.js ${(stats.playerBytes / 1024).toFixed(1)} KB · Build 内 ${stats.buildFiles} 个文件`);
  logStep(onLog, "提示：Web 端复用同一份 Build 数据，但渲染是 WebGL2 重写的，不是 Java 运行时。");
  return stats;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function countFiles(dir) {
  let n = 0;
  const walk = async (d) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(join(d, e.name));
      else n++;
    }
  };
  await walk(dir);
  return n;
}
