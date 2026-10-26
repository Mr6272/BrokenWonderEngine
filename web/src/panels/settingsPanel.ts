/**
 * 工程设置与账号面板。
 *
 * 放在左栏最后一页：这里的东西不常改，但每次新建工程都要看一眼
 * （格子尺寸决定整张地图的尺度，改晚了所有对象的位置都要重摆）。
 */

import { store } from "../core/store.ts";
import { Session, PLANS } from "../account/session.ts";
import { el, input, button, select, fieldRow } from "../core/dom.ts";
import { I } from "../ui/icons.ts";
import { info, ok, warn } from "../ui/toast.ts";
import { cleanupAssets, downloadProject, showExportComingSoon } from "../app/project.ts";

export function renderSettingsPanel(host: HTMLElement): void {
  host.replaceChildren();
  const wrap = el("div", { class: "col" });
  wrap.style.padding = "10px";

  const p = store.project;
  if (!p) {
    wrap.appendChild(el("div", { class: "hint" }, "还没有打开工程"));
    host.appendChild(wrap);
    return;
  }

  // ---- 工程 ----
  wrap.appendChild(el("div", { class: "group-label" }, "工程 Project"));

  const nameI = input(p.name, {
    onChange: (v) => {
      const t = v.trim();
      if (t) {
        p.name = t;
        store.markDirty();
        store.emitProject();
      }
    }
  });
  wrap.appendChild(fieldRow("工程名 Name", nameI));

  const authorI = input(p.author ?? "", {
    onChange: (v) => {
      p.author = v;
      store.markDirty();
    }
  });
  wrap.appendChild(fieldRow("作者 Author", authorI));

  const tileI = input(String(p.tileSize), {
    numeric: true,
    hint: "一格多少像素。俯视角常用 16 / 32 / 48，改这个会影响全部对象的尺度感",
    onChange: (v) => {
      const n = Math.max(4, Math.min(256, Number(v) || p.tileSize));
      p.tileSize = n;
      store.markDirty();
      window.dispatchEvent(new CustomEvent("bwe:repaint"));
    }
  });
  wrap.appendChild(fieldRow("格子尺寸 Tile Size", tileI, "像素，决定整张地图的尺度"));

  const gwI = input(String(p.gridW), {
    numeric: true,
    onChange: (v) => {
      p.gridW = Math.max(4, Math.min(500, Number(v) || p.gridW));
      store.markDirty();
    }
  });
  wrap.appendChild(fieldRow("默认地图宽 Width", gwI, "新建场景时使用的宽度（格）"));

  const ghI = input(String(p.gridH), {
    numeric: true,
    onChange: (v) => {
      p.gridH = Math.max(4, Math.min(500, Number(v) || p.gridH));
      store.markDirty();
    }
  });
  wrap.appendChild(fieldRow("默认地图高 Height", ghI, "新建场景时使用的高度（格）"));

  const volI = input(String(p.masterVolume), {
    numeric: true,
    onChange: (v) => {
      const n = Math.max(0, Math.min(1, Number(v) || 0));
      p.masterVolume = n;
      store.markDirty();
    }
  });
  wrap.appendChild(fieldRow("主音量 Master Volume", volI, "0 到 1"));

  wrap.appendChild(
    el(
      "div",
      { class: "hint" },
      `当前工程：${p.scenes.length} 张地图　${p.assets.length} 个素材　${Object.keys(p.scripts).length} 段剧本　${p.packs.length} 个规则包`
    )
  );

  // ---- 导出 ----
  wrap.appendChild(el("div", { class: "group-label" }, "导出 Export"));
  const expRow = el("div", { class: "row tight" });
  expRow.appendChild(
    button("导出 .bwproj", () => downloadProject(), { size: "sm", iconPath: I.exportImg, title: "下载工程文件，可拷给同事或用桌面版打开" })
  );
  expRow.appendChild(
    button("导出 Web 游戏包", () => showExportComingSoon(), { size: "sm", iconPath: I.play, title: "生成可上传到网页的自包含游戏包" })
  );
  wrap.appendChild(expRow);

  // ---- 账号与订阅 ----
  wrap.appendChild(el("div", { class: "group-label" }, "账号与订阅 Account"));

  if (Session.loggedIn()) {
    const a = Session.currentUser();
    wrap.appendChild(el("div", { class: "hint" }, `已登录：${a?.displayName ?? ""}（${a?.email ?? ""}）`));
    wrap.appendChild(el("div", { class: "hint" }, `订阅计划：${Session.plan().cn}`));
    const row = el("div", { class: "row tight" });
    row.appendChild(button("查看订阅计划", () => Session.openPlansDialog(), { size: "sm", variant: "primary", iconPath: I.crown }));
    row.appendChild(
      button("退出登录", () => {
        Session.logout();
        ok("已退出登录");
        window.dispatchEvent(new CustomEvent("bwe:refresh"));
      }, { size: "sm", variant: "ghost" })
    );
    wrap.appendChild(row);
  } else {
    wrap.appendChild(
      el(
        "div",
        { class: "hint" },
        "不登录也能完整使用全部编辑功能。登录只用于同步订阅计划与团队素材库。"
      )
    );
    const row = el("div", { class: "row tight" });
    row.appendChild(button("登录 / 注册", () => Session.openLoginDialog(), { size: "sm", variant: "primary", iconPath: I.account }));
    row.appendChild(button("查看订阅计划", () => Session.openPlansDialog(), { size: "sm", iconPath: I.crown }));
    wrap.appendChild(row);
  }

  wrap.appendChild(
    el(
      "div",
      { class: "hint" },
      `当前可用计划：${PLANS.map((x) => x.cn.split(" ")[0]).join(" / ")}　·　免费版包含全部地图编辑与基础模块`
    )
  );

  // ---- 本地数据 ----
  wrap.appendChild(el("div", { class: "group-label" }, "本地数据 Data"));
  wrap.appendChild(
    el(
      "div",
      { class: "hint" },
      "素材与工程保存在你这台机器的浏览器本地（IndexedDB）。清理浏览器数据会一并清掉，重要工程请用「导出 .bwproj」备份。"
    )
  );
  wrap.appendChild(
    button("清理未使用的素材文件", () => void cleanupAssets(), { size: "sm" })
  );

  // ---- 无障碍 ----
  wrap.appendChild(el("div", { class: "group-label" }, "无障碍 Accessibility"));

  const themeSel = select(
    [
      { value: "default", label: "默认主题" },
      { value: "high-contrast", label: "高对比度" }
    ],
    document.documentElement.classList.contains("theme-high-contrast") ? "high-contrast" : "default",
    {
      onChange: (v) => {
        document.documentElement.classList.remove("theme-high-contrast");
        if (v === "high-contrast") document.documentElement.classList.add("theme-high-contrast");
        try { localStorage.setItem("bwe.theme", v); } catch { /* ignore */ }
      }
    }
  );
  wrap.appendChild(fieldRow("界面主题", themeSel));

  const scaleSel = select(
    [
      { value: "100", label: "100%" },
      { value: "125", label: "125%" },
      { value: "150", label: "150%" }
    ],
    localStorage.getItem("bwe.uiScale") ?? "100",
    {
      onChange: (v) => {
        document.body.style.zoom = `${Number(v) / 100}`;
        try { localStorage.setItem("bwe.uiScale", v); } catch { /* ignore */ }
      }
    }
  );
  wrap.appendChild(fieldRow("界面缩放", scaleSel));

  // ---- 快捷键 ----
  wrap.appendChild(el("div", { class: "group-label" }, "快捷键 Shortcuts"));
  const keys = [
    "V 选择　B 画笔　E 橡皮　Z 触发区　H 抓手",
    "F 缩放到整张地图　Ctrl+S 保存　Ctrl+O 打开",
    "Ctrl+Z 撤销　Ctrl+Y 重做　Ctrl+D 复制对象",
    "空格+拖动 / 右键拖动 / 中键拖动：平移画布",
    "滚轮：以光标为锚点缩放",
    "方向键 微调 1px　Shift+方向键 走一格",
    "Delete 删除选中　Esc 取消当前拖动 / 清空选择",
    "F1 快速上手"
  ];
  for (const k of keys) wrap.appendChild(el("div", { class: "hint" }, k));

  host.appendChild(wrap);
}

void info;
void warn;
