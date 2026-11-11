/**
 * UI 逻辑自检（node 里跑，不依赖浏览器、不需要起服务）。
 *
 * 为什么需要：命令面板和诊断中心都是"纯逻辑 + DOM 渲染"混在一起的东西，
 * 浏览器截图只能证明"它弹出来了"，证明不了"过滤对不对、计数会不会堆叠"。
 * 这两层是纯粹函数，单独拉出来跑最省事、也最稳定。
 *
 * 跑法：
 *   node node_modules/esbuild/bin/esbuild web/tools/ui-checks/verify-ui-logic.ts  *     --bundle --platform=node --format=esm --outfile=.tmp_ui/verify.mjs
 *   node .tmp_ui/verify.mjs
 */
import { registerCommands, allCommands, filterCommands, commandsByGroup } from "../../src/ui/commands.ts";
import { setProblems, clearProblems, allProblems, problemCounts, clearAllProblems } from "../../src/core/diagnostics.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// ---- 命令注册表：用与 editor 相同的 id 集合（实际 editor 里注册 48 条）----
const fake = [
  { id: "file.new", title: "新建工程", key: "Ctrl+N", group: "文件", run() {} },
  { id: "file.open", title: "打开工程…", key: "Ctrl+O", group: "文件", run() {} },
  { id: "file.save", title: "保存", key: "Ctrl+S", group: "文件", run() {} },
  { id: "file.saveAs", title: "另存为（保存副本 .bwproj）", group: "文件", hint: "下载一份当前工程的副本", run() {} },
  { id: "edit.undo", title: "撤销", key: "Ctrl+Z", group: "编辑", run() {} },
  { id: "edit.redo", title: "重做", key: "Ctrl+Y", group: "编辑", run() {} },
  { id: "edit.duplicate", title: "复制选中对象", key: "Ctrl+D", group: "编辑", run() {} },
  { id: "edit.delete", title: "删除选中对象", key: "Delete", group: "编辑", run() {} },
  { id: "edit.moduleEditor", title: "打开模块编辑器", key: "M", group: "编辑", run() {} },
  { id: "view.fit", title: "缩放到整张地图", key: "F", group: "视图", run() {} },
  { id: "view.zoom100", title: "缩放 100%", group: "视图", run() {} },
  { id: "view.toggleGrid", title: "切换网格显示", group: "视图", run() {} },
  { id: "view.toggleColliders", title: "切换碰撞体显示", group: "视图", run() {} },
  { id: "view.toggleNames", title: "切换对象名称显示", group: "视图", run() {} },
  { id: "view.sidebar", title: "切换侧边栏", key: "Ctrl+B", group: "视图", run() {} },
  { id: "view.panel", title: "切换底部面板", key: "Ctrl+J", group: "视图", run() {} },
  { id: "view.problems", title: "显示问题面板", key: "Ctrl+Shift+M", group: "视图", run() {} },
  { id: "view.output", title: "显示输出面板", group: "视图", run() {} },
  { id: "view.commandPalette", title: "命令面板", key: "Ctrl+Shift+P", group: "视图", run() {} },
  { id: "project.settings", title: "工程设置", group: "工程", run() {} },
  { id: "project.package", title: "打包到 BWE（Windows EXE）…", group: "工程", run() {} },
  { id: "project.preview", title: "在编辑器内预览场景", group: "工程", run() {} },
  { id: "project.exportWeb", title: "导出 Web 游戏包", group: "工程", enabled: () => false, run() {} },
  { id: "edit.prefabs", title: "预制体面板…", group: "工程", run() {} },
  { id: "project.newExample", title: "新建示例工程", group: "工程", run() {} },
  { id: "project.example.minesweeper", title: "扫雷示例（.bwproj）", group: "工程", run() {} },
  { id: "project.example.dressup", title: "换装示例（.bwproj）", group: "工程", run() {} },
  { id: "project.example.topdown", title: "俯视角 JS 示例（.bwproj）", group: "工程", run() {} },
  { id: "project.example.emergence", title: "涌现沙盘示例（.bwproj）", group: "工程", run() {} },
  { id: "project.example.vampire", title: "吸血鬼幸存者（.bwproj）", group: "工程", run() {} },
  { id: "project.example.alienShooter", title: "孤胆枪手（.bwproj）", group: "工程", run() {} },
  { id: "script.open", title: "打开剧本编辑器", group: "剧本", run() {} },
  { id: "script.jsApi", title: "JS 脚本 API 速查", group: "剧本", run() {} },
  { id: "script.goToProblems", title: "查看问题列表", group: "剧本", run() {} },
  { id: "ai.focus", title: "AI：打开助手面板", group: "AI", run() {} },
  { id: "ai.explainError", title: "AI：解释当前错误", group: "AI", run() {} },
  { id: "ai.editScript", title: "AI：改这段脚本", group: "AI", run() {} },
  { id: "ai.sceneReview", title: "AI：审一遍当前场景", group: "AI", run() {} },
  { id: "ai.reset", title: "AI：重置对话", group: "AI", run() {} },
  { id: "help.quickStart", title: "快速上手", key: "F1", group: "帮助", run() {} },
  { id: "help.modules", title: "模块速查", group: "帮助", run() {} },
  { id: "help.jsApi", title: "JS 脚本 API 速查", group: "帮助", run() {} },
  { id: "help.about", title: "关于 BWE Studio", group: "帮助", run() {} },
  { id: "project.quickRunStop", title: "停止试跑", group: "工程", hidden: true, run() {} },
  { id: "project.reveal", title: "在文件管理器中显示工程", group: "工程", hidden: true, run() {} },
  { id: "script.openInVscode", title: "用 VS Code 打开当前脚本", group: "剧本", hidden: true, run() {} },
  { id: "script.checkAll", title: "检查全部 JS 脚本", group: "剧本", hidden: true, run() {} }
];
registerCommands(fake as never);

console.log("== 命令注册表 ==");
check("可进命令面板的命令数 = 43（48 注册 - 5 隐藏）", allCommands().length === 43, `实际 ${allCommands().length}`);
const groups = commandsByGroup();
check("分组数 ≥ 7", groups.length >= 7, `实际 ${groups.length}`);
check("分组首位是「文件」", groups[0]?.group === "文件", groups[0]?.group);

console.log("== 模糊过滤 ==");
check("空查询返回全部", filterCommands("").length === 43, `实际 ${filterCommands("").length}`);
const save = filterCommands("保存");
check("「保存」能筛出保存相关", save.length >= 2 && save.length <= 8, `命中 ${save.length}：${save.map((c) => c.title).join(" / ")}`);
check("「保存」第一条是保存或另存为", /保存/.test(save[0]?.title ?? ""), save[0]?.title);
const ai = filterCommands("AI");
check("「AI」筛出 AI 命令", ai.length >= 4 && ai.every((c) => /AI/.test(c.title) || c.group === "AI"), `命中 ${ai.length}`);
const multi = filterCommands("AI 脚本");
check("多关键词 AND 生效（AI + 脚本）", multi.length > 0 && multi.length < ai.length, `命中 ${multi.length}：${multi.map((c) => c.title).join(" / ")}`);
const key = filterCommands("Ctrl+Shift+P");
check("按快捷键可搜到命令面板", key.length >= 1 && key[0].id === "view.commandPalette", `命中 ${key.length}：${key[0]?.title}`);
const none = filterCommands("zzzzz");
check("无关词返回空", none.length === 0, `命中 ${none.length}`);
const cmds = filterCommands("打包");
check("「打包」能筛出打包命令", cmds.some((c) => c.id === "project.package"), cmds.map((c) => c.title).join(" / "));

console.log("== 诊断中心 ==");
const list1 = [
  { id: "js:p#0", severity: "error" as const, source: "js" as const, sourceLabel: "剧本 · p", scriptName: "p", scriptLang: "js" as const, line: 12, message: "TypeError: x is not defined" },
  { id: "js:p#1", severity: "warn" as const, source: "js" as const, sourceLabel: "剧本 · p", scriptName: "p", scriptLang: "js" as const, line: 30, message: "未使用变量 a" }
];
setProblems("js:p", list1);
check("写入 2 条诊断", allProblems().length === 2, `实际 ${allProblems().length}`);
let counts = problemCounts();
check("计数 error=1 warn=1", counts.errors === 1 && counts.warns === 1, JSON.stringify(counts));
const order = allProblems();
check("错误排在警告之前", order[0].severity === "error", order[0].severity);
// 覆盖写入不堆叠
setProblems("js:p", list1);
check("重复写入不堆叠", allProblems().length === 2, `实际 ${allProblems().length}`);
// 换一批
setProblems("js:p", [list1[0]]);
check("覆盖后只剩 1 条", allProblems().length === 1, `实际 ${allProblems().length}`);
setProblems("package", [{ id: "package#0", severity: "error" as const, source: "package" as const, sourceLabel: "打包 BWE", message: "jpackage 缺失" }]);
counts = problemCounts();
check("多来源合并计数 2 错误", counts.errors === 2, JSON.stringify(counts));
clearProblems("js:p");
check("清掉一个来源后剩 1 条", allProblems().length === 1, `实际 ${allProblems().length}`);
clearProblems("js:p");
check("清空不存在的来源不报错", true);
clearAllProblems();
check("全部清空后为 0", allProblems().length === 0, `实际 ${allProblems().length}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
