import io
p = "web/tools/package-bwe.mjs"
s = io.open(p, encoding="utf-8").read()

old = '''  const buildOut = join(outDir, "Build");
  await cp(buildDir, buildOut, { recursive: true });'''
new = '''  // writeBuild 把产物写进 <buildDir>/Build，所以源目录要再下一层，
  // 否则会得到 Build/Build/boot.json，播放器按 Build/boot.json 找就会 404。
  const buildSrc = join(buildDir, "Build");
  const buildOut = join(outDir, "Build");
  if (!existsSync(buildSrc)) {
    throw new Error(`writeBuild 没有产出 Build 目录: ${buildSrc}`);
  }
  await cp(buildSrc, buildOut, { recursive: true });'''

if old in s:
    s = s.replace(old, new, 1)
    print("nested Build fixed")
else:
    print("anchor MISSING")
io.open(p, "w", encoding="utf-8", newline="").write(s)
