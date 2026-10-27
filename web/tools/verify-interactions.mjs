/**
 * 三个交互功能的真实浏览器验证（CDP 驱动 headless Chrome）。
 *
 * 验证目标：
 *   1. 点击选中 —— 原地按下+松开会选中；按住拖动会位移，两者不互相污染
 *   2. 同位置重复点击轮换选择 —— 叠放的对象逐个切换，到底回到最上面
 *   3. 对象右键菜单包含「上移一层 / 下移一层」，且真的改变绘制顺序
 *
 * 运行：node web/tools/verify-interactions.mjs
 * 前置：headless Chrome 带 --remote-debugging-port=9222 打开编辑器页面
 */

const CDP = "http://127.0.0.1:9222";
const PAGE_URL = "http://127.0.0.1:5273/";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("timeout " + method));
        }
      }, 15000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error("eval: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
    }
    return r.result.value;
  }
  async mouse(type, x, y, opts = {}) {
    await this.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: opts.button ?? "left",
      buttons: opts.buttons ?? (type === "mouseReleased" ? 0 : 1),
      clickCount: opts.clickCount ?? 1,
      modifiers: opts.modifiers ?? 0
    });
  }
  async click(x, y, opts = {}) {
    await this.mouse("mousePressed", x, y, opts);
    await wait(30);
    await this.mouse("mouseReleased", x, y, opts);
    await wait(60);
  }
  async drag(x1, y1, x2, y2) {
    await this.mouse("mousePressed", x1, y1);
    await wait(30);
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      await this.mouse("mouseMoved", x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
      await wait(20);
    }
    await this.mouse("mouseReleased", x2, y2);
    await wait(120);
  }
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`);
}

/** 在页面里造一个可控的测试场景：两个完全重叠的对象。 */
const SEED = `
(async () => {
  const { store } = await import("/dist/studio.js");
  return "no-direct-import";
})()
`;

async function main() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.startsWith(PAGE_URL));
  if (!page) throw new Error("编辑器页面没打开");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener("open", r);
    ws.addEventListener("error", j);
  });
  const s = new Session(ws);
  await s.send("Runtime.enable");

  // 等编辑器挂载完成
  for (let i = 0; i < 60; i++) {
    const ok = await s.eval(`!!document.querySelector(".canvas-wrap canvas") && !!document.querySelector(".app-root")`);
    if (ok) break;
    await wait(200);
  }

  // 载入示例工程（有对象可点）：通过顶部「文件」菜单里的「新建示例工程」
  await s.eval(`
    (() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const file = btns.find((b) => b.textContent.trim() === "文件" || b.textContent.includes("文件"));
      if (file) file.click();
      return !!file;
    })()
  `);
  await wait(300);
  const clickedExample = await s.eval(`
    (() => {
      const items = Array.from(document.querySelectorAll(".ctx-menu *, [role=menuitem], .menu *"));
      const ex = items.find((el) => (el.textContent || "").trim().split(/Ctrl|⌘/)[0].trim() === "新建示例工程");
      if (ex) { ex.click(); return true; }
      return false;
    })()
  `);
  await wait(1200);
  const objCount = await s.eval(`window.__BWE__?.store?.scene?.objects?.length ?? -1`);
  record("载入示例工程", clickedExample && objCount > 0, `点击=${clickedExample} 对象数=${objCount}`);

  const hasCanvas = await s.eval(`!!document.querySelector(".canvas-wrap canvas")`);
  record("编辑器加载", hasCanvas, hasCanvas ? "" : "canvas 不存在");

  // 首次打开会弹「快速上手」引导，它带全屏遮罩、会吞掉所有鼠标事件。
  // 不关掉的话后面每个点击测试都会假性失败（看起来像"点不中对象"，其实是被遮住了）。
  const dismissed = await dismissModals(s);
  record("关闭引导弹窗", dismissed, dismissed ? "" : "没有遮罩（已关闭或本来就无）");

  await verifyClickVsDrag(s);
  await verifyCycle(s);
  await verifyZOrder(s);

  console.log("\n==== 汇总 ====");
  const fail = results.filter((r) => !r.pass).length;
  console.log(`${results.length - fail} / ${results.length} 通过`);
  ws.close();
  process.exit(fail ? 1 : 0);
}

/** 关掉所有会挡鼠标的遮罩/弹窗（引导、模态框）。 */
async function dismissModals(s) {
  const closed = await s.eval(`
    (() => {
      let n = 0;
      // 先点"跳过引导"
      for (const b of Array.from(document.querySelectorAll("button"))) {
        if (b.textContent.trim() === "跳过引导") { b.click(); n++; break; }
      }
      // 再兜底：把残留遮罩上的关闭/取消按一遍，仍不行就直接移除节点
      for (const m of Array.from(document.querySelectorAll(".modal-mask"))) {
        const btn = m.querySelector("button");
        if (btn) { btn.click(); n++; }
        else { m.remove(); n++; }
      }
      return n;
    })()
  `);
  await wait(300);
  const still = await s.eval(`
    (() => {
      const m = document.querySelector(".modal-mask");
      if (m) { m.remove(); return 1; }
      return 0;
    })()
  `);
  return closed + still > 0 || (await s.eval(`!document.querySelector(".modal-mask")`));
}

/** 用 canvas 上的真实对象做点击/拖动测试。 */
async function verifyClickVsDrag(s) {
  const target = await objectScreenPoint(s);
  if (!target) return record("点击命中对象", false, "场景里没有对象");

  await s.click(target.x, target.y);
  const sel = await s.eval(`window.__BWE__.store.selection.map(o => o.name || o.kind)`);
  record("点击选中对象", sel.length === 1, `选中=${JSON.stringify(sel)}`);

  // 拖动：从对象位置拖走 60px，位置应改变
  const before = await s.eval(`
    (() => { const o = window.__BWE__.store.selection[0]; return o ? {x:o.x,y:o.y} : null; })()
  `);
  await s.drag(target.x, target.y, target.x + 60, target.y + 30);
  const after = await s.eval(`
    (() => { const o = window.__BWE__.store.selection[0]; return o ? {x:o.x,y:o.y} : null; })()
  `);
  const moved = before && after && (before.x !== after.x || before.y !== after.y);
  record("拖动改变位置", moved, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
}

/** 取一个"画布上确实有对象"的屏幕坐标。 */
async function objectScreenPoint(s) {
  return await s.eval(`
    (() => {
      const st = window.__BWE__.store;
      const scene = st.scene;
      if (!scene || !scene.objects.length) return null;
      const c = document.querySelector(".canvas-wrap canvas");
      const r = c.getBoundingClientRect();
      const t = st.project.tileSize;
      // 优先挑可见、未锁定、面积最大的对象
      const cands = scene.objects.filter(o => o.visible && !o.locked);
      if (!cands.length) return null;
      const o = cands[0];
      const cam = window.__BWE__.editor.canvas;
      // 用编辑器自己的 worldToScreen 才是准的；没有就手算
      let sx, sy;
      if (cam && typeof cam.worldToScreen === "function") {
        const p = cam.worldToScreen(o.x, o.y);
        sx = r.x + p.x; sy = r.y + p.y;
      } else {
        const z = st.zoom, cx = st.camX, cy = st.camY;
        sx = r.x + (o.x - cx) * z + r.width / 2;
        sy = r.y + (o.y - cy) * z + r.height / 2;
      }
      return { x: sx, y: sy, name: o.name || o.kind, objId: o.id };
    })()
  `);
}

/** 同位置重复点击 → 轮换选择。先造两个完全重叠的对象再点。 */
async function verifyCycle(s) {
  const seeded = await s.eval(`
    (() => {
      const st = window.__BWE__.store;
      const scene = st.scene;
      if (!scene) return null;
      const t = st.project.tileSize;
      const layer = scene.layers[Math.max(0, scene.layers.length - 1)];
      const mk = (name) => {
        const o = {
          id: "cyc-" + name + "-" + Math.random().toString(36).slice(2),
          name, kind: "PROP", x: 5 * t, y: 5 * t, z: scene.objects.length,
          rotation: 0, scaleX: 1, scaleY: 1, halfW: 0, halfH: 0,
          layerId: layer.id, visible: true, locked: false,
          assetId: "", animMode: "默认", animFps: 8,
          modules: [], props: {}, tags: [], parentId: null
        };
        scene.objects.push(o);
        return o;
      };
      const a = mk("叠层A");
      const b = mk("叠层B");
      st.setScene(scene);
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
      return { a: a.id, b: b.id, x: a.x, y: a.y };
    })()
  `);
  if (!seeded) return record("同位置轮换选择", false, "无法造测试对象");

  // 让编辑器缩放到能看见叠层对象
  await s.eval(`window.__BWE__.editor.canvas.zoomToFit?.()`);
  await wait(200);

  const pt = await s.eval(`
    (() => {
      const st = window.__BWE__.store;
      const c = document.querySelector(".canvas-wrap canvas");
      const r = c.getBoundingClientRect();
      const o = st.scene.objects.find(x => x.name === "叠层A");
      const cam = window.__BWE__.editor.canvas;
      let sx, sy;
      if (cam && typeof cam.worldToScreen === "function") {
        const p = cam.worldToScreen(o.x, o.y);
        sx = r.x + p.x; sy = r.y + p.y;
      } else {
        const z = st.zoom;
        sx = r.x + (o.x - st.camX) * z + r.width / 2;
        sy = r.y + (o.y - st.camY) * z + r.height / 2;
      }
      return { x: sx, y: sy };
    })()
  `);

  const names = [];
  for (let i = 0; i < 4; i++) {
    await s.click(pt.x, pt.y);
    const n = await s.eval(`(window.__BWE__.store.selection[0]?.name) || ""`);
    names.push(n);
  }

  // 期望：点满一圈能看到两个不同的名字（轮换生效）
  const uniq = new Set(names.filter(Boolean));
  record("同位置重复点击轮换", uniq.size >= 2, `依次选中=${JSON.stringify(names)}`);

  // 清理测试对象
  await s.eval(`
    (() => {
      const st = window.__BWE__.store;
      st.scene.objects = st.scene.objects.filter(o => !String(o.name || "").startsWith("叠层"));
      st.clearSelection();
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
    })()
  `);
}

/** 右键菜单是否包含层级项，且「上移一层」真的改变绘制顺序。 */
async function verifyZOrder(s) {
  // 清掉上一步可能残留的测试对象，保证每次从干净状态开始
  await s.eval(`
    (() => {
      const st = window.__BWE__.store;
      st.scene.objects = st.scene.objects.filter(
        (o) => !String(o.name || "").startsWith("叠层") && !String(o.name || "").startsWith("层级")
      );
      st.clearSelection();
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
    })()
  `);
  await wait(150);

  // 造两个同层对象：下层在前，上层在后（z 相邻且远离其他对象，保证有交换空间）
  const seeded = await s.eval(`
    (() => {
      const st = window.__BWE__.store;
      const scene = st.scene;
      if (!scene) return null;
      const t = st.project.tileSize;
      const layerId = scene.objects[0]?.layerId ?? scene.layers[0].id;
      const mk = (name, z) => {
        const o = {
          id: "zo-" + name + "-" + Math.random().toString(36).slice(2),
          name, kind: "PROP", x: 3 * t, y: 3 * t, z,
          rotation: 0, scaleX: 1, scaleY: 1, halfW: 0, halfH: 0,
          layerId, visible: true, locked: false,
          assetId: "", animMode: "默认", animFps: 8,
          modules: [], props: {}, tags: [], parentId: null
        };
        scene.objects.push(o);
        return o;
      };
      mk("层级下层", 900);
      mk("层级上层", 901);
      st.setScene(scene);
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
      return true;
    })()
  `);
  if (!seeded) return record("右键层级菜单", false, "无法造测试对象");
  await wait(250);

  const target = await s.eval(`
    (() => {
      const st = window.__BWE__.store;
      const c = document.querySelector(".canvas-wrap canvas");
      const r = c.getBoundingClientRect();
      const o = st.scene.objects.find(x => x.name === "层级上层");
      const cam = window.__BWE__.editor.canvas;
      const p = cam.worldToScreen(o.x, o.y);
      return { x: r.x + p.x, y: r.y + p.y, objId: o.id };
    })()
  `);

  await s.mouse("mousePressed", target.x, target.y, { button: "right", buttons: 2 });
  await wait(40);
  await s.mouse("mouseReleased", target.x, target.y, { button: "right", buttons: 0 });
  await wait(300);

  const menu = await s.eval(`
    (() => {
      const m = document.querySelector(".menu");
      return m ? m.innerText : "";
    })()
  `);
  const hasUp = /上移一层/.test(menu);
  const hasDown = /下移一层/.test(menu);
  record("右键菜单含「上移一层/下移一层」", hasUp && hasDown,
    hasUp && hasDown ? "" : `菜单=${menu.replace(/\n/g, " | ").slice(0, 160)}`);

  // 比较"整张场景的绘制顺序里，这两个对象的相对位置"。
  // 不能直接比 z 数值：nudgeZ 会把同层所有对象的 z 重排成 0..n，
  // 编号整体平移看起来像"变了"也可能"没变"。比相对次序才准确。
  const ORDER_EXPR = `
    (() => {
      const st = window.__BWE__.store;
      const scene = st.scene;
      const li = new Map();
      scene.layers.forEach((l, i) => li.set(l.id, i));
      const sorted = scene.objects.slice().sort((a, b) => {
        const la = li.get(a.layerId) ?? scene.layers.length;
        const lb = li.get(b.layerId) ?? scene.layers.length;
        if (la !== lb) return la - lb;
        if (a.z !== b.z) return a.z - b.z;
        return a.y - b.y;
      });
      return sorted.map((o) => o.name).filter((n) => String(n || "").startsWith("层级"));
    })()
  `;
  const orderBefore = await s.eval(ORDER_EXPR);

  const btnText = "下移一层";
  const clicked = await s.eval(`
    (() => {
      const btns = Array.from(document.querySelectorAll(".menu button"));
      const target = ${JSON.stringify(btnText)};
      const b = btns.find((x) => {
        const first = Array.from(x.childNodes).find((n) => n.nodeType === 3);
        return ((first && first.textContent) || x.textContent || "").trim().startsWith(target);
      });
      if (b) { b.click(); return true; }
      return false;
    })()
  `);
  await wait(350);
  const orderAfter = await s.eval(ORDER_EXPR);
  const changed = JSON.stringify(orderBefore) !== JSON.stringify(orderAfter);
  record("「下移一层」改变绘制顺序", clicked && changed,
    `before=${JSON.stringify(orderBefore)} after=${JSON.stringify(orderAfter)} clicked=${clicked}`);

  // 清理
  await s.eval(`
    (() => {
      const st = window.__BWE__.store;
      st.scene.objects = st.scene.objects.filter(o => !String(o.name||"").startsWith("层级"));
      st.clearSelection();
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
    })()
  `);
  await s.click(20, 20);
}

main().catch((e) => {
  console.error("验证失败:", e.message);
  process.exit(1);
});
