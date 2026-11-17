#!/usr/bin/env bash
# 热重载语法探针的行为测试。
# 需要一个 JDK（JAVA_HOME 或 PATH 里的 javac/java）和仓库自带的 rhino jar。
set -e
cd "$(dirname "$0")/../.."
RH="$(ls .tmp_droid/apk/work/input/rhino-*.jar 2>/dev/null | head -1 || true)"
[ -z "$RH" ] && RH="$(ls lib/rhino*.jar 2>/dev/null | head -1 || true)"
if [ -z "$RH" ]; then echo "跳过: 找不到 rhino jar"; exit 0; fi
JAVAC="${JAVA_HOME:+$JAVA_HOME/bin/}javac"
JAVA="${JAVA_HOME:+$JAVA_HOME/bin/}java"
OUT=".tmp_java_test"; rm -rf "$OUT" && mkdir -p "$OUT/main" "$OUT/test"
find src -name "*.java" ! -name "*Test.java" > "$OUT/srcs.txt"
"$JAVAC" -nowarn -encoding UTF-8 -cp "lib/*:$RH" -d "$OUT/main" @"$OUT/srcs.txt" 2>&1 | grep -v "^注\|^Note" || true
"$JAVAC" -nowarn -encoding UTF-8 -cp "$OUT/main:$RH" -d "$OUT/test" tests/java/HotReloadProbeTest.java
"$JAVA" -cp "$OUT/test:$OUT/main:$RH" Studio.runtime.HotReloadProbeTest
