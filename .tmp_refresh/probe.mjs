(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const chipText = () => {
    const el = q(".ai-head .model-chip");
    return el ? el.textContent.trim() : "(无 chip)";
  };
  const selectValue = () => {
    const s = q("[data-ai-model-select]");
    return s ? s.value : "(无下拉)";
  };

  const api = window.__BWE__ || {};
  api.enterAiMode?.();
  await frame(); await wait(200); await frame();

  const before = { chip: chipText(), sel: selectValue() };

  // 模拟「配置一个新 provider」：走 IPC 门面加一条模型（正是用户报的那条路径）
  const host = window.__BWE_HOST__ || window.host || null;
  let added = null;
  try {
    added = await window.bweHost?.aiAddModel?.({
      label: "刷新验证 DeepSeek",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat-refresh-test",
      apiKey: "sk-fake-for-refresh-test"
    });
  } catch (e) {
    added = { error: String(e?.message || e) };
  }

  // ⚠ 关键：这里**不切窗口、不切标签**，只看 chip 会不会自己变
  await frame(); await wait(150); await frame();
  const afterAdd = { chip: chipText(), sel: selectValue() };

  await wait(600); await frame();
  const settled = { chip: chipText(), sel: selectValue() };

  return {
    before,
    afterAdd,
    settled,
    addedOk: added ? added.ok : "no-host",
    addedActive: added ? added.active : null,
    chipChangedWithoutReswitch: before.chip !== settled.chip,
    selChangedWithoutReswitch: before.sel !== settled.sel
  };
})()
