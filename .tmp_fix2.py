import io
p = ".tmp_verify_web.mjs"
s = io.open(p, encoding="utf-8").read()

# 素材 path 本来就含 Build/ 前缀，相对产物根解析。
# 场景与脚本的 file 是相对 Build 的。两套基准，不能混。
old = '''for (const a of boot.assets) {
  const ok = existsSync(`${OUT}/Build/${a.path}`);
  check(`素材文件存在 ${a.id}`, ok, "boot.json 引用了不存在的文件: " + a.path);
}'''
new = '''for (const a of boot.assets) {
  // asset.path 形如 "Build/assets/xxx/main.png"，相对的是**产物根**。
  const ok = existsSync(`${OUT}/${a.path}`);
  check(`素材文件存在 ${a.id}`, ok, "boot.json 引用了不存在的文件: " + a.path);
}'''
assert old in s
s = s.replace(old, new, 1)

# 加一条断言把这个约定钉住，防止以后有人"顺手"把前缀去掉
anchor = 'console.log(`\\n结果: ${pass} 通过, ${fail} 失败`);'
add = '''check(
  "素材 path 与场景/脚本的基准不同（asset 含 Build/ 前缀，file 不含）",
  boot.assets[0].path.startsWith("Build/") && !boot.scenes[0].file.startsWith("Build/"),
  "两套路径基准被统一了，会有一端 404"
);

'''
s = s.replace(anchor, add + anchor, 1)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("verify script fixed")
