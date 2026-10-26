/**
 * 账号与订阅。
 *
 * 定位：编辑器核心功能完全免费、离线可用；账号只用来同步订阅计划与团队素材库。
 * 所以登录是"可选增强"，没登录时编辑器一切照常，绝不弹登录墙。
 *
 * 当前实现是纯本地（localStorage），密码用 PBKDF2-SHA256 加盐派生后存储。
 * 将来接后端只需替换 login/register/logout 三个方法的实现，界面与调用点不用动。
 */

import { el, input, button } from "../core/dom.ts";
import { modal, ok, error, info } from "../ui/toast.ts";

export type PlanId = "FREE" | "INDIE" | "STUDIO";

export interface Plan {
  id: PlanId;
  cn: string;
  price: string;
  who: string;
  includes: string[];
}

export const PLANS: Plan[] = [
  {
    id: "FREE",
    cn: "免费版 Free",
    price: "0 元",
    who: "学习、原型、个人小作品",
    includes: ["全部地图编辑功能", "全部基础模块", "Yarn 剧本编辑", "导出 .bwproj 工程", "本地保存，离线可用"]
  },
  {
    id: "INDIE",
    cn: "独立开发者 Indie",
    price: "68 元 / 月",
    who: "打算上架售卖的小团队",
    includes: ["免费版全部功能", "高级战斗与 AI 模块", "规则包导出与分享", "整包 Web 游戏导出", "场景模板库"]
  },
  {
    id: "STUDIO",
    cn: "工作室 Studio",
    price: "198 元 / 月",
    who: "多人协作的工作室",
    includes: ["独立开发者全部功能", "团队素材库与共享规则包", "云端备份与版本历史", "优先技术支持"]
  }
];

interface Account {
  email: string;
  displayName: string;
  plan: PlanId;
  createdAt: number;
}

interface StoredAccount extends Account {
  salt: string;
  hash: string;
}

const LS_ACCOUNTS = "bwe.accounts";
const LS_SESSION = "bwe.session";

function readAccounts(): StoredAccount[] {
  try {
    const raw = localStorage.getItem(LS_ACCOUNTS);
    return raw ? (JSON.parse(raw) as StoredAccount[]) : [];
  } catch {
    return [];
  }
}

function writeAccounts(list: StoredAccount[]): void {
  try {
    localStorage.setItem(LS_ACCOUNTS, JSON.stringify(list));
  } catch {
    /* 隐私模式下写不进去，忽略即可，不影响使用 */
  }
}

function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

async function derive(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 120000, hash: "SHA-256" },
    key,
    256
  );
  return b64(bits);
}

export class SessionManager {
  private account: Account | null = null;
  private listeners = new Set<() => void>();

  constructor() {
    try {
      const raw = localStorage.getItem(LS_SESSION);
      if (raw) this.account = JSON.parse(raw) as Account;
    } catch {
      this.account = null;
    }
  }

  loggedIn(): boolean {
    return !!this.account;
  }

  /** 当前登录用户（对外只读）。 */
  currentUser(): Account | null {
    return this.account;
  }

  label(): string {
    return this.account ? `${this.account.displayName} · ${this.plan().cn.split(" ")[0]}` : "未登录";
  }

  plan(): Plan {
    const id = this.account?.plan ?? "FREE";
    return PLANS.find((p) => p.id === id) ?? PLANS[0];
  }

  /** 能力门禁：将来高级模块与导出功能据此判断，不在业务代码里散落判断。 */
  can(need: PlanId): boolean {
    const order: PlanId[] = ["FREE", "INDIE", "STUDIO"];
    return order.indexOf(this.plan().id) >= order.indexOf(need);
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  private emit(): void {
    for (const f of this.listeners) f();
  }

  async register(email: string, password: string, displayName: string): Promise<boolean> {
    const e = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) {
      error("邮箱格式看起来不对，检查一下再试");
      return false;
    }
    if (password.length < 6) {
      error("密码至少 6 位");
      return false;
    }
    const list = readAccounts();
    if (list.some((a) => a.email === e)) {
      error("这个邮箱已经注册过了，直接登录吧");
      return false;
    }
    const salt = crypto.randomUUID();
    const hash = await derive(password, salt);
    const stored: StoredAccount = {
      email: e,
      displayName: displayName.trim() || e.split("@")[0],
      plan: "FREE",
      createdAt: Date.now(),
      salt,
      hash
    };
    list.push(stored);
    writeAccounts(list);
    this.adopt(stored);
    ok(`注册成功，欢迎 ${stored.displayName}`);
    return true;
  }

  async login(email: string, password: string): Promise<boolean> {
    const e = email.trim().toLowerCase();
    const found = readAccounts().find((a) => a.email === e);
    if (!found) {
      error("没有这个账号，先去注册");
      return false;
    }
    const hash = await derive(password, found.salt);
    if (hash !== found.hash) {
      error("密码不对");
      return false;
    }
    this.adopt(found);
    ok(`欢迎回来，${found.displayName}`);
    return true;
  }

  logout(): void {
    this.account = null;
    try {
      localStorage.removeItem(LS_SESSION);
    } catch {
      /* ignore */
    }
    this.emit();
  }

  switchPlan(id: PlanId): void {
    if (!this.account) {
      warn2("先登录再切换计划");
      return;
    }
    this.account.plan = id;
    const list = readAccounts();
    const i = list.findIndex((a) => a.email === this.account!.email);
    if (i >= 0) {
      list[i].plan = id;
      writeAccounts(list);
    }
    try {
      localStorage.setItem(LS_SESSION, JSON.stringify(this.account));
    } catch {
      /* ignore */
    }
    const p = PLANS.find((x) => x.id === id);
    ok(`已切换到「${p?.cn ?? id}」`);
    this.emit();
  }

  private adopt(a: Account): void {
    this.account = { email: a.email, displayName: a.displayName, plan: a.plan, createdAt: a.createdAt };
    try {
      localStorage.setItem(LS_SESSION, JSON.stringify(this.account));
    } catch {
      /* ignore */
    }
    this.emit();
  }

  // ---------------- 界面 ----------------

  openLoginDialog(): void {
    const state = { mode: "login" as "login" | "register" };
    modal({
      title: "登录 BWE Studio",
      body: (close) => {
        const box = el("div", { class: "col" });

        const seg = el("div", { class: "segmented" });
        const mkSeg = (id: "login" | "register", label: string) => {
          const b = el("button", { type: "button", class: state.mode === id ? "active" : "" }, label);
          b.addEventListener("click", () => {
            state.mode = id;
            Array.from(seg.children).forEach((c) => c.classList.remove("active"));
            b.classList.add("active");
            nameField.style.display = id === "register" ? "" : "none";
          });
          return b;
        };
        seg.appendChild(mkSeg("login", "登录"));
        seg.appendChild(mkSeg("register", "注册"));
        box.appendChild(seg);

        const emailField = el("div", { class: "field" });
        emailField.appendChild(el("label", null, "邮箱 Email"));
        const email = input("", { placeholder: "you@example.com" });
        emailField.appendChild(email);
        box.appendChild(emailField);

        const nameField = el("div", { class: "field" });
        nameField.style.display = "none";
        nameField.appendChild(el("label", null, "昵称 Display Name"));
        const nick = input("", { placeholder: "可以留空" });
        nameField.appendChild(nick);
        box.appendChild(nameField);

        const pwField = el("div", { class: "field" });
        pwField.appendChild(el("label", null, "密码 Password"));
        const pw = el("input", { class: "input", type: "password", placeholder: "至少 6 位" });
        pwField.appendChild(pw);
        box.appendChild(pwField);

        box.appendChild(
          el(
            "div",
            { class: "hint" },
            "账号只用于同步订阅计划；不登录也能完整使用全部编辑功能。密码在本机用 PBKDF2 加盐存储，不会以明文保存。"
          )
        );

        const submit = async () => {
          const okDone =
            state.mode === "login"
              ? await this.login(email.value, pw.value)
              : await this.register(email.value, pw.value, nick.value);
          if (okDone) {
            close();
            window.dispatchEvent(new CustomEvent("bwe:refresh"));
          }
        };
        pw.addEventListener("keydown", (e) => {
          if ((e as KeyboardEvent).key === "Enter") void submit();
        });
        (close as unknown as { __submit?: () => Promise<void> }).__submit = submit;
        return box;
      },
      actions: [
        {
          label: "确定",
          variant: "primary",
          onClick: (close) => {
            const s = (close as unknown as { __submit?: () => Promise<void> }).__submit;
            void s?.();
          }
        },
        { label: "以后再说", variant: "ghost", onClick: (close) => close() }
      ]
    });
  }

  openPlansDialog(): void {
    modal({
      title: "订阅计划",
      wide: true,
      body: () => {
        const box = el("div", { class: "col" });
        box.appendChild(
          el(
            "div",
            { class: "hint" },
            `当前：${this.label()}　·　免费版可以完成一整局游戏，付费解锁的是效率、团队协作与整包发布能力。`
          )
        );
        const grid = el("div", { class: "plans" });
        const cur = this.plan().id;
        for (const p of PLANS) {
          const card = el("div", { class: "plan" + (p.id === cur ? " current" : "") });
          card.appendChild(el("div", { class: "p-name" }, p.cn));
          card.appendChild(el("div", { class: "p-price" }, p.price));
          card.appendChild(el("div", { class: "p-who" }, p.who));
          const ul = el("ul");
          for (const line of p.includes) ul.appendChild(el("li", null, line));
          card.appendChild(ul);
          if (p.id === cur) {
            card.appendChild(button("当前计划", () => {}, { variant: "outline", size: "sm", disabled: true }));
          } else {
            card.appendChild(
              button(p.id === "FREE" ? "降级到免费版" : `切换到${p.cn.split(" ")[0]}`, () => {
                this.switchPlan(p.id);
                window.dispatchEvent(new CustomEvent("bwe:refresh"));
              }, { variant: p.id === "FREE" ? "ghost" : "primary", size: "sm" })
            );
          }
          grid.appendChild(card);
        }
        box.appendChild(grid);
        box.appendChild(
          el(
            "div",
            { class: "hint" },
            "当前为本地订阅状态，接上正式计费后端之前，这里的切换只在本机生效。"
          )
        );
        return box;
      },
      actions: [{ label: "关闭", variant: "primary", onClick: (c) => c() }]
    });
  }
}

function warn2(t: string): void {
  info(t);
}

export const Session = new SessionManager();
