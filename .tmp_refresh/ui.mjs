(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const chipText = () => { const e = q(".ai-head .model-chip"); return e ? e.textContent.trim() : "(无)"; };
  const selText = () => { const s = q("[data-ai-model-select]"); return s && s.selectedOptions[0] ? s.selectedOptions[0].textContent.trim() : "(无)"; };

  const api = window.__BWE__ || {};
  api.enterAiMode?.();
  await frame(); await wait(250); await frame();

  const before = { chip: chipText(), sel: selText() };

  // ① 点「+ 添加」（用户真实入口）
  const addBtn = q("[data-ai-add-model]");
  if (!addBtn) return { error: "找不到 [data-ai-add-model]", before };
  addBtn.click();
  await frame(); await wait(200); await frame();

  const modalOpen = Boolean(q(".modal"));
  if (!modalOpen) return { error: "弹窗没开", before };

  // ② 填表（服务地址先清空，模拟"配置一个新 provider"）
  const setVal = (sel, v) => {
    const el = q(sel); if (!el) return false;
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };
  const filled = {
    provider: setVal("[data-ai-add-provider]", "deepseek"),
    baseUrl: setVal("[data-ai-add-baseurl]", "https://api.deepseek.com"),
    model: setVal("[data-ai-add-model-name]", "deepseek-chat-uipath"),
    label: setVal("[data-ai-add-label]", "UI路径验证模型"),
    key: setVal("[data-ai-add-key]", "sk-fake-ui-path")
  };
  await frame(); await wait(120);

  // ③ 点「添加并切换」
  const okBtn = qa(".modal footer .btn").find((b) => b.textContent.includes("添加并切换"));
  if (!okBtn) return { error: "找不到「添加并切换」按钮", before, filled };
  okBtn.click();

  // ④ ⚠ 不切窗口、不切标签，只等一会儿
  await frame(); await wait(400); await frame();
  const after = { chip: chipText(), sel: selText() };
  await wait(900); await frame();
  const settled = { chip: chipText(), sel: selText() };

  return {
    before, filled, modalOpen,
    after, settled,
    chipChanged: before.chip !== settled.chip,
    selChanged: before.sel !== settled.sel
  };
})()
