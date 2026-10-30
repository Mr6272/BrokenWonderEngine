package Studio.runtime;

import Core.GameSekai;
import Core.destroy.DestroyQueue;
import Framework.GameObject;
import Framework.IAbility;

import java.util.ArrayList;
import java.util.List;

/**
 * 旧核心 Ability / 对象生命周期加固测试（对应审计 {@code docs/open-world-engine-audit.md} §2.1 的六条缺陷）。
 *
 * <p>本测试是「先写测试、后改实现」的产物：每条断言在加固前都会失败（编译失败或断言失败），
 * 断言名里标注了它对应的缺陷编号 a/b/c/d/e/f：
 * <ul>
 *   <li><b>a</b> {@code AddAbility} 同一实例重复添加 → 去重 + 返回是否真的加入</li>
 *   <li><b>b</b> {@code OnInit()} 在 {@code OnAdded()} 之前调用，能力在 OnInit 里拿不到宿主</li>
 *   <li><b>c</b> {@code GameObject} 没有 {@code Destroy()}；销毁要走帧末延迟提交，且能力各回调一次 OnRemove</li>
 *   <li><b>d</b> {@code Update()} 遍历中 {@code RemoveAbility} 抛 {@code ConcurrentModificationException}</li>
 *   <li><b>e</b> {@code RemoveAbility} 对不在列表里的对象也回调 {@code OnRemove}（重复 OnRemove）</li>
 *   <li><b>f</b> 能力执行顺序不确定 → 加 order、稳定排序，Transform 永远最先</li>
 * </ul>
 *
 * <p>纯 headless：不创建窗口、不调用 GL、不写工程文件；只用旧核心的公开 API。
 * 全部通过退出码 0，任一失败退出码 1。
 */
public final class EngineAbilityTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();

    private EngineAbilityTest() {
    }

    public static void main(String[] args) {
        int failures = 0;
        String fatal = null;
        try {
            runA();
            runB();
            runC();
            runD();
            runE();
            runF();
        } catch (Throwable t) {
            fatal = t.toString();
            t.printStackTrace();
        }
        if (fatal != null) {
            RESULTS.add(new String[]{"engineabilitytest caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        System.out.println("========== EngineAbilityTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            System.out.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        System.out.println("---------------------------------------");
        System.out.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        System.exit(failures == 0 ? 0 : 1);
    }

    // ---------------- a) AddAbility 重复添加 ----------------

    private static void runA() {
        GameObject go = new GameObject();
        ProbeAbility p = new ProbeAbility("a");

        boolean first = go.TryAddAbility(p);
        int sizeAfterFirst = go.Abilitys.size();

        check("a-1 首次加入返回 true", first, "");
        check("a-2 同一实例第二次加入返回 false", !go.TryAddAbility(p), "");
        check("a-3 重复加入不改变能力列表长度",
                go.Abilitys.size() == sizeAfterFirst, "size=" + go.Abilitys.size() + " 期望=" + sizeAfterFirst);
        check("a-4 重复加入不会重复回调 OnAdded", countOf(p.log, "OnAdded") == 1,
                "OnAdded 次数=" + countOf(p.log, "OnAdded"));

        // 旧 void 入口必须保留，且同样去重（旧调用方 Xia/Kuwu/SunAttack 用这个）
        ProbeAbility q = new ProbeAbility("a2");
        go.AddAbility(q);
        int sizeAfterQ = go.Abilitys.size();
        go.AddAbility(q);
        check("a-5 旧 void AddAbility 同样去重",
                go.Abilitys.size() == sizeAfterQ, "size=" + go.Abilitys.size() + " 期望=" + sizeAfterQ);

        cleanup();
    }

    // ---------------- b) OnInit / OnAdded 顺序与宿主访问 ----------------

    private static void runB() {
        GameObject go = new GameObject();
        ProbeAbility p = new ProbeAbility("b");
        go.TryAddAbility(p);

        check("b-1 OnAdded 在 OnInit 之前调用",
                p.log.size() >= 2 && "OnAdded".equals(p.log.get(0)) && "OnInit".equals(p.log.get(1)),
                p.log.toString());
        check("b-2 OnInit 里能拿到宿主", p.initSawHost, "");
        check("b-3 OnInit 只调用一次", countOf(p.log, "OnInit") == 1,
                "OnInit 次数=" + countOf(p.log, "OnInit"));
        check("b-4 getHost() 返回宿主", p.getHost() == go, "");
        check("b-5 引擎内能力（Transform）也拿得到宿主", go.transform.getHost() == go,
                "transform.getHost()=" + go.transform.getHost());

        cleanup();
    }

    // ---------------- c) Destroy / 延迟提交 / OnRemove 一次 ----------------

    private static void runC() {
        GameObject go = new GameObject();
        ProbeAbility p1 = new ProbeAbility("c1");
        ProbeAbility p2 = new ProbeAbility("c2");
        go.TryAddAbility(p1);
        go.TryAddAbility(p2);
        int beforeUpdates = p1.updateCount + p2.updateCount;

        go.Destroy();
        check("c-1 Destroy 后 isDestroyed() 为 true", go.isDestroyed(), "");
        check("c-2 延迟销毁：提交前对象仍在 GameSekai.GameObjects",
                GameSekai.GameObjects.contains(go), "");
        check("c-3 入队后 DestroyQueue.size() 增加", DestroyQueue.size() >= 1,
                "size=" + DestroyQueue.size());

        go.Update();
        check("c-4 已标记销毁的对象不再执行 OnUpdate",
                p1.updateCount + p2.updateCount == beforeUpdates,
                "update 次数=" + (p1.updateCount + p2.updateCount));

        DestroyQueue.commit();
        check("c-5 提交后从 GameSekai.GameObjects 移除", !GameSekai.GameObjects.contains(go), "");
        check("c-6 销毁时每个能力恰好回调一次 OnRemove",
                p1.removeCount == 1 && p2.removeCount == 1,
                "p1=" + p1.removeCount + " p2=" + p2.removeCount);
        check("c-7 提交后能力列表已清空", go.Abilitys.isEmpty(),
                "size=" + go.Abilitys.size());

        int removesAfterCommit = p1.removeCount + p2.removeCount;
        go.Destroy();
        DestroyQueue.commit();
        check("c-8 重复 Destroy 幂等（不再回调 OnRemove）",
                p1.removeCount + p2.removeCount == removesAfterCommit,
                "remove 次数=" + (p1.removeCount + p2.removeCount));

        cleanup();
    }

    // ---------------- d) Update 遍历中增删 ----------------

    private static void runD() {
        final GameObject go = new GameObject();
        final ProbeAbility self = new ProbeAbility("d-self");
        final ProbeAbility remover = new ProbeAbility("d-remover");
        final ProbeAbility victim = new ProbeAbility("d-victim");

        self.onUpdate = new Runnable() {
            public void run() {
                go.RemoveAbility(self);
            }
        };
        remover.onUpdate = new Runnable() {
            public void run() {
                go.RemoveAbility(victim);
            }
        };

        go.TryAddAbility(self);
        go.TryAddAbility(remover);
        go.TryAddAbility(victim);

        boolean threw = false;
        String err = "";
        try {
            go.Update();
        } catch (java.util.ConcurrentModificationException e) {
            threw = true;
            err = e.toString();
        }
        check("d-1 Update 中 RemoveAbility 不抛 ConcurrentModificationException", !threw, err);
        check("d-2 自删的能力已不在列表里", indexOfIdentity(go, self) < 0, "");
        check("d-3 本帧被移出的能力不再收到 OnUpdate", victim.updateCount == 0,
                "victim update=" + victim.updateCount);
        check("d-4 其余能力本帧仍被更新", remover.updateCount == 1,
                "remover update=" + remover.updateCount);

        cleanup();
    }

    // ---------------- e) RemoveAbility 幂等 ----------------

    private static void runE() {
        GameObject go = new GameObject();
        ProbeAbility present = new ProbeAbility("e-present");
        ProbeAbility absent = new ProbeAbility("e-absent");
        go.TryAddAbility(present);

        check("e-1 移除不在列表里的能力返回 false", !go.RemoveAbility(absent), "");
        check("e-2 不在列表里的能力不回调 OnRemove", absent.removeCount == 0,
                "remove=" + absent.removeCount);

        check("e-3 正常移除返回 true 且回调一次 OnRemove",
                go.RemoveAbility(present) && present.removeCount == 1,
                "remove=" + present.removeCount);
        check("e-4 重复移除同一能力：返回 false 且不再回调 OnRemove",
                !go.RemoveAbility(present) && present.removeCount == 1,
                "remove=" + present.removeCount);

        boolean indexOk = true;
        try {
            go.RemoveAbilityByIndex(99);
            go.RemoveAbilityByIndex(-1);
        } catch (Throwable t) {
            indexOk = false;
        }
        check("e-5 RemoveAbilityByIndex 越界安全", indexOk, "");

        cleanup();
    }

    // ---------------- f) 能力执行顺序 ----------------

    private static void runF() {
        GameObject go = new GameObject();
        ProbeAbility first = new ProbeAbility("f-first");
        ProbeAbility second = new ProbeAbility("f-second");
        go.SetAbilityOrder(first, 50);
        go.SetAbilityOrder(second, 10);
        go.TryAddAbility(first);
        go.TryAddAbility(second);

        check("f-1 能力按 order 升序排列",
                go.Abilitys.size() == 3
                        && go.Abilitys.get(1) == second
                        && go.Abilitys.get(2) == first,
                "order=" + describe(go));
        check("f-2 Transform 仍在第 0 位", go.Abilitys.get(0) == go.transform, describe(go));
        check("f-3 Transform 的 order 小于其它能力", go.transform.GetOrder() < 0,
                "Transform order=" + go.transform.GetOrder());

        go.SetAbilityOrder(first, 1);
        check("f-4 重设 order 后重新排序",
                go.Abilitys.get(1) == first && go.Abilitys.get(2) == second, describe(go));

        // 相同 order 必须保持加入顺序（稳定排序）
        GameObject go2 = new GameObject();
        ProbeAbility x = new ProbeAbility("f-x");
        ProbeAbility y = new ProbeAbility("f-y");
        go2.SetAbilityOrder(x, 7);
        go2.SetAbilityOrder(y, 7);
        go2.TryAddAbility(y);
        go2.TryAddAbility(x);
        check("f-5 order 相同时保持加入顺序（稳定排序）",
                indexOfIdentity(go2, y) < indexOfIdentity(go2, x) && indexOfIdentity(go2, y) > 0,
                describe(go2));

        // 实际执行顺序必须与排序一致
        final List<String> seq = new ArrayList<String>();
        ProbeAbility r1 = new ProbeAbility("f-run-1");
        ProbeAbility r2 = new ProbeAbility("f-run-2");
        r1.onUpdate = new Runnable() {
            public void run() {
                seq.add("r1");
            }
        };
        r2.onUpdate = new Runnable() {
            public void run() {
                seq.add("r2");
            }
        };
        GameObject go3 = new GameObject();
        go3.SetAbilityOrder(r1, 20);
        go3.SetAbilityOrder(r2, 5);
        go3.TryAddAbility(r1);
        go3.TryAddAbility(r2);
        go3.Update();
        check("f-6 OnUpdate 执行顺序与 order 一致",
                seq.size() == 2 && "r2".equals(seq.get(0)) && "r1".equals(seq.get(1)), seq.toString());

        cleanup();
    }

    // ---------------- 工具 ----------------

    /** 测试用能力：记录生命周期回调顺序、宿主可见性、回调次数。 */
    private static final class ProbeAbility implements IAbility {
        final String name;
        final List<String> log = new ArrayList<String>();
        GameObject host;
        boolean initSawHost;
        boolean enabled = true;
        int updateCount;
        int removeCount;
        Runnable onUpdate;

        ProbeAbility(String name) {
            this.name = name;
        }

        @Override
        public void OnAdded(GameObject gameObject) {
            host = gameObject;
            log.add("OnAdded");
        }

        @Override
        public void OnInit() {
            log.add("OnInit");
            initSawHost = host != null;
        }

        @Override
        public void SetEnable(boolean value) {
            enabled = value;
        }

        @Override
        public void OnUpdate() {
            updateCount++;
            log.add("OnUpdate");
            if (onUpdate != null) {
                onUpdate.run();
            }
        }

        @Override
        public boolean GetEnable() {
            return enabled;
        }

        @Override
        public void OnRemove() {
            removeCount++;
            log.add("OnRemove");
        }

        @Override
        public GameObject getHost() {
            return host;
        }

        @Override
        public String toString() {
            return name;
        }
    }

    /** 清理本轮测试在旧核心全局状态里留下的对象与队列。 */
    private static void cleanup() {
        List<GameObject> snapshot = new ArrayList<GameObject>(GameSekai.GameObjects);
        for (GameObject go : snapshot) {
            go.Destroy();
        }
        DestroyQueue.commit();
        GameSekai.GameObjects.clear();
        DestroyQueue.clear();
    }

    private static boolean containsIdentity(GameObject go, IAbility a) {
        return indexOfIdentity(go, a) >= 0;
    }

    private static int indexOfIdentity(GameObject go, IAbility a) {
        for (int i = 0; i < go.Abilitys.size(); i++) {
            if (go.Abilitys.get(i) == a) {
                return i;
            }
        }
        return -1;
    }

    private static int countOf(List<String> log, String s) {
        int n = 0;
        for (String line : log) {
            if (s.equals(line)) {
                n++;
            }
        }
        return n;
    }

    private static String describe(GameObject go) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < go.Abilitys.size(); i++) {
            if (i > 0) {
                sb.append(", ");
            }
            sb.append(go.Abilitys.get(i));
        }
        return sb.append(']').toString();
    }

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false", detail == null ? "" : detail});
    }
}
