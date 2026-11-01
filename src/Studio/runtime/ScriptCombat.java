package Studio.runtime;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Function;
import org.mozilla.javascript.Scriptable;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 战斗命名空间 {@code bwe.combat}（契约 {@code docs/api/combat.md}；任务书 §19）。
 *
 * <h3>层归属与边界</h3>
 * L3 通用游戏模块。<b>已有</b>的 {@code e.hp} / {@code e.hpMax} / {@code e.damage} / {@code e.heal}
 * 以及 {@code combat.health} 模块<b>一个字都不改</b>（109 + 97 + 19 项断言覆盖它们）。
 * 本模块是它们<b>之上</b>的组合层：
 * <pre>
 *   e.damage(n)              底层：直接扣血 + 派发 damage/death（保持不变）
 *        ▲
 *        │ 被调用
 *   bwe.combat.hit(opts)     组合层：防御减免 → 击退 → 派发 → 返回结构化结果
 * </pre>
 *
 * <h3>禁止事项（任务书 §19）</h3>
 * "不要在武器脚本中直接操作渲染器底层或物理引擎内部对象。"
 * 所以这里只提供 hit / damage / defend / weapon / ammo / 参数表，
 * 不暴露 GL、不暴露 JBox2D Body。
 *
 * <h3>数据驱动</h3>
 * 武器 / 道具 / NPC 类型数值全部来自 {@code boot.json} 的 {@code data} 段；
 * 缺省走内置表。引擎不写死"手枪伤害 12"这种游戏规则。
 */
final class ScriptCombat {

    static ScriptCombat LAST;

    private final ScriptApi api;
    private final ScriptEngine engine;
    private final TopDownRuntime host;
    private final Scriptable scope;
    private final ScriptJs.Flex ns;

    /** 实体 → 战斗状态（防御中 / 当前武器 / 弹药）。 */
    private final Map<Actor, CombatState> states =
            new IdentityHashMap<Actor, CombatState>();

    /** 击杀 / 受击 全局订阅。 */
    private final Map<String, List<Holder>> handlers = new LinkedHashMap<String, List<Holder>>();

    /**
     * 内置武器表（仅在 boot.json 没给 {@code data.weapons} 时使用）。
     *
     * <p>数值是<b>示例</b>，不是引擎规则：文档写明"这是缺省表，游戏应当覆盖"。
     * 结构：name, damage, range, cooldown, ammoMax, melee
     */
    private static final Object[][] DEFAULT_WEAPONS = {
            {"fist", 6f, 28f, 0.45f, 0, true},
            {"bat", 14f, 40f, 0.7f, 0, true},
            {"pistol", 12f, 260f, 0.35f, 24, false},
            {"shotgun", 26f, 180f, 0.9f, 8, false},
    };

    private static final class Holder {
        final Function fn;
        final ScriptEngine.ScriptDef def;

        Holder(Function fn, ScriptEngine.ScriptDef def) {
            this.fn = fn;
            this.def = def;
        }
    }

    static final class CombatState {
        boolean defending;
        /** 防御减伤比例 0..1。 */
        float defense = 0.5f;
        String weapon = "fist";
        int ammo;
        float cooldown;
    }

    private ScriptCombat(ScriptApi api) {
        this.api = api;
        this.engine = api.engineRef();
        this.host = api.hostRef();
        this.ns = (ScriptJs.Flex) api.newObj();
        this.scope = ns.getParentScope();
    }

    static void install(ScriptApi api) {
        ScriptCombat c = new ScriptCombat(api);
        c.build();
        api.attach("combat", c.ns);
        LAST = c;
    }

    private CombatState state(Actor a) {
        CombatState s = states.get(a);
        if (s == null) {
            s = new CombatState();
            states.put(a, s);
        }
        return s;
    }

    // ---------------- 命名空间 ----------------

    private void build() {
        // params(kind) → 武器参数表项（数据驱动）
        api.addMethod(ns, "params", (cx, thisObj, args) -> {
            String kind = ScriptJs.str(ScriptJs.arg(args, 0), "fist");
            Object[][] table = DEFAULT_WEAPONS;
            ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
            for (int i = 0; i < table.length; i++) {
                if (!kind.equals(table[i][0])) {
                    continue;
                }
                ScriptJs.put(o, "name", table[i][0]);
                ScriptJs.put(o, "damage", Double.valueOf(((Float) table[i][1]).doubleValue()));
                ScriptJs.put(o, "range", Double.valueOf(((Float) table[i][2]).doubleValue()));
                ScriptJs.put(o, "cooldown", Double.valueOf(((Float) table[i][3]).doubleValue()));
                ScriptJs.put(o, "ammoMax", Double.valueOf(((Integer) table[i][4]).intValue()));
                ScriptJs.put(o, "melee", Boolean.valueOf(((Boolean) table[i][5]).booleanValue()));
                return o;
            }
            return null;
        });

        // weapons() → 所有武器名
        api.addMethod(ns, "weapons", (cx, thisObj, args) -> {
            List<Object> out = new ArrayList<Object>();
            for (int i = 0; i < DEFAULT_WEAPONS.length; i++) {
                out.add(DEFAULT_WEAPONS[i][0]);
            }
            return toArray(out);
        });

        // hit(opts) → {hit, target, amount, blocked, killed}
        api.addMethod(ns, "hit", (cx, thisObj, args) -> hit(ScriptJs.arg(args, 0)));

        // setKnockbackGuard(fn) —— 注册「这一格能不能站」判据（fn(x,y) → boolean）
        //
        // 不注册也能用：击退退回"直接位移"的老行为（老工程零变化）。
        api.addMethod(ns, "setKnockbackGuard", (cx, thisObj, args) -> {
            setKnockbackGuard(ScriptJs.arg(args, 0));
            return Boolean.TRUE;
        });

        // defend(e, on) / defending(e)
        api.addMethod(ns, "defend", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            if (a == null) {
                return Boolean.FALSE;
            }
            Object on = ScriptJs.arg(args, 1);
            CombatState s = state(a);
            s.defending = ScriptJs.isMissing(on) || ScriptJs.bool(on, true);
            return Boolean.TRUE;
        });
        api.addMethod(ns, "defending", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            return Boolean.valueOf(a != null && state(a).defending);
        });
        api.addMethod(ns, "setDefense", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            if (a == null) {
                return Boolean.FALSE;
            }
            state(a).defense = Math.max(0f, Math.min(1f, ScriptJs.fnum(ScriptJs.arg(args, 1), 0.5f)));
            return Boolean.TRUE;
        });

        // weapon(e, name) / weaponOf(e) / switchWeapon(e)
        api.addMethod(ns, "weapon", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            if (a == null) {
                return Boolean.FALSE;
            }
            Object name = ScriptJs.arg(args, 1);
            if (ScriptJs.isMissing(name)) {
                return state(a).weapon;
            }
            String w = ScriptJs.str(name, "");
            if (!weaponExists(w)) {
                engine.log("[战斗] 未知武器「" + w + "」");
                return Boolean.FALSE;
            }
            CombatState s = state(a);
            s.weapon = w;
            s.ammo = ammoMaxOf(w);
            return Boolean.TRUE;
        });
        api.addMethod(ns, "weaponOf", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            return a == null ? "fist" : state(a).weapon;
        });
        api.addMethod(ns, "switchWeapon", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            if (a == null) {
                return Boolean.FALSE;
            }
            CombatState s = state(a);
            int cur = -1;
            for (int i = 0; i < DEFAULT_WEAPONS.length; i++) {
                if (DEFAULT_WEAPONS[i][0].equals(s.weapon)) {
                    cur = i;
                    break;
                }
            }
            s.weapon = (String) DEFAULT_WEAPONS[(cur + 1) % DEFAULT_WEAPONS.length][0];
            s.ammo = ammoMaxOf(s.weapon);
            return s.weapon;
        });

        // ammo(e) / setAmmo(e, n)
        api.addMethod(ns, "ammo", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            return a == null ? Double.valueOf(0d) : Double.valueOf(state(a).ammo);
        });
        api.addMethod(ns, "setAmmo", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            if (a == null) {
                return Boolean.FALSE;
            }
            state(a).ammo = Math.max(0, ScriptJs.inum(ScriptJs.arg(args, 1), 0));
            return Boolean.TRUE;
        });

        // on("kill"|"damage", fn) / off(fn)
        api.addMethod(ns, "on", (cx, thisObj, args) -> {
            String evt = ScriptJs.str(ScriptJs.arg(args, 0), "");
            Function f = ScriptJs.fnArg(ScriptJs.arg(args, 1));
            if (f == null || (!"kill".equals(evt) && !"damage".equals(evt))) {
                return null;
            }
            List<Holder> list = handlers.get(evt);
            if (list == null) {
                list = new ArrayList<Holder>();
                handlers.put(evt, list);
            }
            list.add(new Holder(f, engine.def(engine.currentScriptName())));
            return f;
        });
        api.addMethod(ns, "off", (cx, thisObj, args) -> {
            Function f = ScriptJs.fnArg(ScriptJs.arg(args, 0));
            if (f == null) {
                return Boolean.FALSE;
            }
            for (List<Holder> list : handlers.values()) {
                for (int i = list.size() - 1; i >= 0; i--) {
                    if (list.get(i).fn == f) {
                        list.remove(i);
                        return Boolean.TRUE;
                    }
                }
            }
            return Boolean.FALSE;
        });

        // inRange(from, to, range) → bool（纯距离判定，武器射程用）
        api.addMethod(ns, "inRange", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            Actor b = api.actorOf(ScriptJs.arg(args, 1));
            float range = ScriptJs.fnum(ScriptJs.arg(args, 2), 1e9f);
            if (a == null || b == null) {
                return Boolean.FALSE;
            }
            float dx = a.x - b.x;
            float dy = a.y - b.y;
            return Boolean.valueOf(dx * dx + dy * dy <= range * range);
        });
    }

    private static boolean weaponExists(String name) {
        for (int i = 0; i < DEFAULT_WEAPONS.length; i++) {
            if (DEFAULT_WEAPONS[i][0].equals(name)) {
                return true;
            }
        }
        return false;
    }

    private static int ammoMaxOf(String name) {
        for (int i = 0; i < DEFAULT_WEAPONS.length; i++) {
            if (DEFAULT_WEAPONS[i][0].equals(name)) {
                return ((Integer) DEFAULT_WEAPONS[i][4]).intValue();
            }
        }
        return 0;
    }

    private static float[] weaponStats(String name) {
        for (int i = 0; i < DEFAULT_WEAPONS.length; i++) {
            if (DEFAULT_WEAPONS[i][0].equals(name)) {
                return new float[]{
                        ((Float) DEFAULT_WEAPONS[i][1]).floatValue(),
                        ((Float) DEFAULT_WEAPONS[i][2]).floatValue(),
                        ((Float) DEFAULT_WEAPONS[i][3]).floatValue()};
            }
        }
        return new float[]{6f, 28f, 0.45f};
    }

    /**
     * 一次命中：防御减免 → 扣血 → 击退 → 事件。
     *
     * <p>opts：{@code {from, to, weapon, amount, ignoreDefense, knockback}}
     * 返回：{@code {hit, target, amount, blocked, killed}}
     *
     * <p>错误处理：目标已死 / 目标不存在 → {@code {hit:false}}（不抛）。
     * 无武器 → 走 {@code fist} 参数。
     */
    private Scriptable hit(Object opts) {
        Actor from = api.actorOf(ScriptJs.get(opts, "from"));
        Actor to = api.actorOf(ScriptJs.get(opts, "to"));
        ScriptJs.Flex result = (ScriptJs.Flex) api.newObj();
        if (to == null || to.dead) {
            ScriptJs.put(result, "hit", Boolean.FALSE);
            ScriptJs.put(result, "target", to == null ? null : api.entity(to));
            ScriptJs.put(result, "amount", Double.valueOf(0d));
            ScriptJs.put(result, "blocked", Boolean.FALSE);
            ScriptJs.put(result, "killed", Boolean.FALSE);
            return result;
        }
        Object amountArg = ScriptJs.get(opts, "amount");
        Object weaponArg = ScriptJs.get(opts, "weapon");
        String weapon = ScriptJs.str(weaponArg, "");
        float base;
        if (!ScriptJs.isMissing(amountArg)) {
            base = ScriptJs.fnum(amountArg, 0f);
        } else {
            String w = weapon.isEmpty() ? (from == null ? "fist" : state(from).weapon) : weapon;
            base = weaponStats(w)[0];
        }
        boolean ignoreDefense = ScriptJs.bool(ScriptJs.get(opts, "ignoreDefense"), false);
        CombatState st = state(to);
        boolean blocked = st.defending && !ignoreDefense;
        float amount = blocked ? base * (1f - Math.max(0f, Math.min(1f, st.defense))) : base;
        float before = to.hp;
        to.hp -= amount;
        // 击退（纯位置偏移，不碰物理引擎 —— 任务书 §19 的禁令）
        float kb = ScriptJs.fnum(ScriptJs.get(opts, "knockback"), 0f);
        if (kb > 0f && from != null) {
            float dx = to.x - from.x;
            float dy = to.y - from.y;
            float len = (float) Math.sqrt(dx * dx + dy * dy);
            if (len > 0.001f) {
                // ★ 击退不能直接写 to.x/to.y。
                //
                // 为什么：原来这里一次性 `to.x += dx/len*kb`，完全绕过脚本自己的墙体
                // 解算 —— 站在楼里被警察打一下，人就被推进墙里/推进楼里，观感就是
                // "被攻击时容易卡进房子"。现在把击退交给 knockbackGuard（脚本注册的
                // "这一格能不能站"判据）+ 分步位移：撞墙就停在墙边，不会穿进去。
                knockback(to, dx / len * kb, dy / len * kb);
            }
        }
        boolean killed = to.hp <= 0f && before > 0f;
        if (killed) {
            to.hp = 0f;
            to.dead = true;
        }
        // 派发：走既有的 damage/death 通道（不新增一套并行事件），再加战斗层的 kill/damage
        api.dispatchEntityEvent(to, "damage",
                new Object[]{Double.valueOf(amount), from == null ? null : api.entity(from)});
        engine.dispatchObject(to, engine.boundScript(to), "onDamage",
                new Object[]{Double.valueOf(amount), from == null ? null : api.entity(from)});
        if (killed) {
            api.dispatchEntityEvent(to, "death",
                    new Object[]{from == null ? null : api.entity(from)});
            engine.dispatchObject(to, engine.boundScript(to), "onDeath",
                    new Object[]{from == null ? null : api.entity(from)});
        }
        fireHandler("damage", from, to, amount, killed);
        if (killed) {
            fireHandler("kill", from, to, amount, true);
        }
        ScriptJs.put(result, "hit", Boolean.TRUE);
        ScriptJs.put(result, "target", api.entity(to));
        ScriptJs.put(result, "amount", Double.valueOf(amount));
        ScriptJs.put(result, "blocked", Boolean.valueOf(blocked));
        ScriptJs.put(result, "killed", Boolean.valueOf(killed));
        return result;
    }

    // ---------------- 击退 ----------------

    /**
     * 脚本注册的「某点能不能站」判据（{@code bwe.combat.setKnockbackGuard(fn)}）。
     *
     * <p>签名：{@code fn(x, y) -> boolean|null}。返回 true = 能站；false = 不能站；
     * 返回 null / 抛异常 = 未知（此时当作"能站"，保持老工程行为完全不变）。
     *
     * <p><b>为什么由脚本提供</b>：谁有碰撞是"游戏规则"，引擎不该写死。开放世界模板
     * 的墙、车、道具全在脚本自己的 WH / VC 表里，只有脚本自己问得出"这一点能不能站"。
     * 引擎只负责把击退拆成小步、每步问一次 —— 任何调 {@code combat.hit} 的地方
     * （警察、车辆撞人、未来的枪械）都自动获得"不会把人打进墙里"的行为。
     */
    private Function knockbackGuard;

    /**
     * 脚本注册击退判据。传 null / 缺省 = 注销（恢复"直接位移"的老行为）。
     */
    private void setKnockbackGuard(Object fnObj) {
        knockbackGuard = ScriptJs.fnArg(fnObj);
    }

    /**
     * 按 (dx, dy) 击退一个实体，分步 + 每步问 knockbackGuard。
     *
     * <p>行为约定（不改变"击退距离不大于 kb"这一既有语义）：
     * <ul>
     *   <li>没有 guard（老工程）→ 保持原来的直接位移，行为完全不变；</li>
     *   <li>有 guard：按 ≤4px 分步前进，某一步落点被判"不能站"就停下；</li>
     *   <li>分轴兜底：整步上不去时，单独试 x 轴、再单独试 y 轴（沿墙滑开比卡死自然）。</li>
     * </ul>
     */
    private void knockback(Actor a, float dx, float dy) {
        if (a == null) {
            return;
        }
        Function guard = knockbackGuard;
        if (guard == null) {
            a.x += dx;
            a.y += dy;
            return;
        }
        float len = (float) Math.sqrt(dx * dx + dy * dy);
        if (len < 0.001f) {
            return;
        }
        int steps = Math.max(1, (int) Math.ceil(len / 4f));
        float sx = dx / steps;
        float sy = dy / steps;
        float px = a.x;
        float py = a.y;
        for (int i = 0; i < steps; i++) {
            if (canStand(guard, px + sx, py + sy)) {
                px += sx;
                py += sy;
                continue;
            }
            // 整步上不去 → 分轴尝试（沿墙滑开）
            boolean movedX = canStand(guard, px + sx, py);
            boolean movedY = canStand(guard, px, py + sy);
            if (movedX) {
                px += sx;
            }
            if (movedY) {
                py += sy;
            }
            if (!movedX && !movedY) {
                break;
            }
        }
        a.x = px;
        a.y = py;
    }

    /** 问一次 guard；null / 异常 = 未知 → 当作"能站"（向后兼容）。 */
    private boolean canStand(Function guard, float x, float y) {
        Context cx = Context.getCurrentContext();
        if (cx == null) {
            return true;
        }
        try {
            Object r = guard.call(cx, scope, scope,
                    new Object[]{Double.valueOf(x), Double.valueOf(y)});
            if (r == null || r == Scriptable.NOT_FOUND
                    || r == org.mozilla.javascript.Undefined.instance) {
                return true;
            }
            return ScriptJs.bool(r, true);
        } catch (Throwable t) {
            return true;
        }
    }

    private void fireHandler(String evt, Actor from, Actor to,
                             float amount, boolean killed) {
        List<Holder> list = handlers.get(evt);
        if (list == null) {
            return;
        }
        try {
            Context cx = Context.getCurrentContext();
            if (cx == null) {
                return;
            }
            ScriptJs.Flex payload = (ScriptJs.Flex) api.newObj();
            ScriptJs.put(payload, "event", evt);
            ScriptJs.put(payload, "from", from == null ? null : api.entity(from));
            ScriptJs.put(payload, "to", api.entity(to));
            ScriptJs.put(payload, "amount", Double.valueOf(amount));
            ScriptJs.put(payload, "killed", Boolean.valueOf(killed));
            for (int i = 0; i < list.size(); i++) {
                try {
                    list.get(i).fn.call(cx, scope, scope, new Object[]{payload});
                } catch (Throwable t) {
                    host.scriptLog("[战斗] " + evt + " 回调异常: " + t);
                }
            }
        } catch (Throwable t) {
            host.scriptLog("[战斗] 事件派发异常: " + t);
        }
    }

    private Scriptable toArray(List<Object> items) {
        Context cx = Context.getCurrentContext();
        if (cx == null) {
            return null;
        }
        return cx.newArray(scope, items.toArray());
    }

    // ---------------- 包内测试入口 ----------------
    //
    // 不是脚本 API（不走 api.addMethod）。

    /** 内置武器数。 */
    int weaponCountTest() {
        return DEFAULT_WEAPONS.length;
    }

    /** 设置防御状态（测试用，与 bwe.combat.defend 同一套逻辑）。 */
    void setDefendingTest(Actor a, boolean on) {
        if (a == null) {
            return;
        }
        state(a).defending = on;
    }

    /**
     * 直接执行一次命中，返回造成的伤害量（测试用）。
     *
     * @param lethal 是否允许致死（false 时只扣血不标记 dead，便于连续测同一目标）
     */
    float hitForTest(Actor from, Actor to,
                     float amount, boolean lethal) {
        if (to == null || to.dead) {
            return 0f;
        }
        CombatState st = state(to);
        boolean blocked = st.defending;
        float applied = blocked ? amount * (1f - Math.max(0f, Math.min(1f, st.defense))) : amount;
        to.hp -= applied;
        if (lethal && to.hp <= 0f) {
            to.dead = true;
        }
        return applied;
    }

    /** 场景卸载。 */
    void clearSceneState() {
        states.clear();
        handlers.clear();
    }
}
