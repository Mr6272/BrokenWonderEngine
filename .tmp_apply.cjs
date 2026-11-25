const fs=require("fs");
function edit(f,fn){let s=fs.readFileSync(f,"utf8");const n=fn(s);if(n===s)throw new Error("no change "+f);fs.writeFileSync(f,n,"utf8");}
edit("web/tools/api-core.mjs",s=>s.replace('findRuntimeJdk, packageAndroid, packageBwe, writeQuickBuild','findRuntimeJdk, packageAndroid, packageBwe, packageWeb, writeQuickBuild'));
edit("web/tools/api-core.mjs",s=>{
 const old='''      if (platform === "android") {''';
 const replacement='''      if (platform === "web") {
        const result = await packageWeb(
          body.project,
          body.assets ?? [],
          { jobId: job.id, name: body.name || body.project.name, version: body.version || "1.0.0" },
          (message) => pushLog(job, message)
        );
        job.result = { platform: "web", ...result };
        job.status = "done";
        job.finishedAt = new Date().toISOString();
        pushLog(job, `Web 导出完成，文件：${result.zipPath}`);
      } else if (platform === "android") {''';
 if(!s.includes(old))throw new Error('branch marker missing');return s.replace(old,replacement);
});
edit("web/tools/package-bwe.mjs",s=>{
 const marker='''  const stats = {
     appName,
     version,
     outDir,
     playerBytes: (await stat(playerOut)).size,''';
 const repl='''  const zipPath = await zipWeb(outDir, appName, onLog);
  const zipStats = await stat(zipPath);
  const stats = {
     platform: "web",
     appName,
     version,
     outDir,
     zipPath,
     zipName: basename(zipPath),
     sizeBytes: zipStats.size,
     playerBytes: (await stat(playerOut)).size,''';
 if(!s.includes(marker))throw new Error('stats marker missing');return s.replace(marker,repl);
});
edit("web/tools/package-bwe.mjs",s=>{
 const marker='''async function countFiles(dir) {''';
 const fn='''async function zipWeb(outDir, appName, onLog) {
  const zipPath = join(dirname(outDir), `${appName}-web.zip`);
  await rm(zipPath, { force: true });
  logStep(onLog, `压缩 Web 包：${zipPath}`);
  if (process.platform === "win32") {
    const script = `Compress-Archive -Path '${join(outDir, "*").replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { cwd: dirname(outDir) });
  } else {
    await run("tar", ["-a", "-c", "-f", zipPath, "-C", outDir, "."], { cwd: dirname(outDir) });
  }
  return zipPath;
}

''';
 if(!s.includes(marker))throw new Error('count marker missing');return s.replace(marker,fn+marker);
});
edit("web/src/app/packageBwe.ts",s=>s.replace('export async function openBwePackager(): Promise<void> {','export async function openBwePackager(initialPlatform: "windows" | "android" | "web" = "windows"): Promise<void> {').replace('let platform = "windows" as "windows" | "android";','let platform = initialPlatform;'));
edit("web/src/app/packageBwe.ts",s=>s.replace('async function start(plat: "windows" | "android" = "windows")','async function start(plat: "windows" | "android" | "web" = "windows")'));
edit("web/src/app/packageBwe.ts",s=>s.replace('platform === "android" ? "打包到 BWE · Android APK" : "打包到 BWE · Windows EXE"','platform === "android" ? "打包到 BWE · Android APK" : platform === "web" ? "导出 Web 游戏包" : "打包到 BWE · Windows EXE"').replace('platform === "android"\n            ? "把当前工程交给 BWE Android 运行时，通过 Gradle assembleDebug 生成 debug APK，拷进 android/app/src/main/assets/BWE/。"','platform === "android"\n            ? "把当前工程交给 BWE Android 运行时，通过 Gradle assembleDebug 生成 debug APK，拷进 android/app/src/main/assets/BWE/。"').replace('''            : "把当前工程交给 BWE Java 运行时，生成自带 Java 的 Windows 应用目录，再压缩成 zip。"''','''            : platform === "web"
              ? "把当前工程导出为可部署的 Web 游戏包，包含 WebGL2 播放器与同一份 Build 数据，解压后上传到静态服务器即可。"
              : "把当前工程交给 BWE Java 运行时，生成自带 Java 的 Windows 应用目录，再压缩成 zip。"'''));
edit("web/src/app/packageBwe.ts",s=>s.replace('''      const apkBtn = button("打包 Android APK", () => void start("android"), {''','''      const webBtn = button("导出 Web 游戏包", () => void start("web"), {
        variant: "outline",
        iconPath: I.exportImg,
        title: "生成可部署的 Web 游戏 ZIP"
      });
      const apkBtn = button("打包 Android APK", () => void start("android"), {''').replace('''      actionRow.appendChild(startBtn);
      actionRow.appendChild(apkBtn);''','''      actionRow.appendChild(startBtn);
      actionRow.appendChild(webBtn);
      actionRow.appendChild(apkBtn);'''));
edit("web/src/app/packageBwe.ts",s=>s.replace('''        resultBox.appendChild(el("div", { class: "pkg-result-title" }, r.platform === "android" ? "Android APK 打包完成" : "打包完成"));''','''        resultBox.appendChild(el("div", { class: "pkg-result-title" }, r.platform === "android" ? "Android APK 打包完成" : r.platform === "web" ? "Web 游戏包导出完成" : "打包完成"));''').replace('''              title: "下载包含 exe 的 Windows 应用包"''','''              title: r.platform === "web" ? "下载可部署的 Web 游戏包" : "下载包含 exe 的 Windows 应用包"''').replace('''              : "解压后双击 exe 运行；如果启动失败，查看 Build/bwe.log。")''','''              : r.platform === "web"
                ? "解压后把整个目录上传到静态托管，或用 npx serve / python -m http.server 启动。"
                : "解压后双击 exe 运行；如果启动失败，查看 Build/bwe.log。")'''));
edit("web/src/app/editor.ts",s=>s.replace('{ label: "导出 Web 游戏包", disabled: true, hint: "下一步实现", onClick: () => this.exportWeb() }','{ label: "导出 Web 游戏包", onClick: () => this.exportWeb() }').replace('{ id: "project.exportWeb", title: "导出 Web 游戏包", group: "工程", icon: "exportImg", enabled: () => false, run: () => this.exportWeb() }','{ id: "project.exportWeb", title: "导出 Web 游戏包", group: "工程", icon: "exportImg", enabled: () => Boolean(store.project), run: () => this.exportWeb() }').replace('''  private exportWeb(): void {
    info("Web 游戏包导出正在开发中");
  }''','''  private exportWeb(): void {
    void openBwePackager("web");
  }'''));
