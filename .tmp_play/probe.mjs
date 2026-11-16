(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  await wait(400);
  const barBtns = qa(".canvas-toolbar button, .tab-toolbar button, .toolbar button")
    .map((b) => b.textContent.trim()).filter(Boolean);
  const allBtns = qa("button").map((b) => b.textContent.trim()).filter((t) => t === "试跑" || t === "预览");
  // 命令面板里的命令
  const cmds = (window.__BWE__ && window.__BWE__.commands) ? window.__BWE__.commands() : null;
  return {
    toolbarButtons: barBtns.slice(0, 12),
    playtestButtons: allBtns,
    hasPreviewButton: allBtns.includes("预览"),
    hasPlaytestButton: allBtns.includes("试跑"),
    cmdHasPlaytest: cmds ? cmds.some((c) => c.id === "project.playtest") : "no-api",
    cmdHasPreview: cmds ? cmds.some((c) => c.id === "project.preview") : "no-api"
  };
})()
