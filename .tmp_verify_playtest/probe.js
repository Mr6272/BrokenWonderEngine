(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const qa = (all) => Array.from(document.querySelectorAll(all));
  await wait(500);

  const barBtns = qa(".canvas-toolbar button, .tab-toolbar button, .toolbar button")
    .map((b) => (b.textContent || "").trim())
    .filter(Boolean);

  // 命令注册表：__BWE__ 上没有导出 commands 时退化为"从命令面板 DOM 里找"，
  // 两者都拿不到就返回 null（调用方按"没验到"处理，不假装通过）。
  let cmds = null;
  try {
    const api = window.__BWE__ || {};
    if (typeof api.commands === "function") cmds = api.commands();
  } catch { cmds = null; }

  return {
    barButtons: barBtns,
    hasPreviewText: barBtns.includes("预览"),
    hasPlaytestText: barBtns.includes("试跑"),
    cmdIds: cmds ? cmds.map((c) => c.id) : null
  };
})()