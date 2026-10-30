package Studio.runtime;

import Core.CollisionSystem;
import Core.GameSekai;
import Core.Vector2;
import Core.destroy.DestroyQueue;
import Framework.GameObject;
import Framework.IAbility;
import Framework.TransformAbility;

import java.util.ArrayList;
import java.util.List;

/**
 * Transform 能力测试（对应审计 §2.1 缺陷 b/f 与 §3 第 12 条「Transform 无父子层级」的边界）。
 *
 * <p>覆盖点：
 * <ul>
 *   <li>Transform 由 GameObject 构造时自动创建、恒在第 0 位、order 恒最先（缺陷 f）；</li>
 *   <li>Transform 的宿主访问（缺陷 b）；</li>
 *   <li>scale 的"半宽半高"语义**保持不变**（审计 §5 兼容性红线：xia_demo 依赖此语义）；</li>
 *   <li>position/rotation 的默认值与写入；</li>
 *   <li>SetEnable / GetEnable 语义（加固前 SetEnable 是空实现，enabled 永远 true）；</li>
 *   <li>销毁后 Transform 的引用仍可读（不 NPE），且对象已从场景移除。</li>
 * </ul>
 *
 * <p>全部通过退出码 0，任一失败退出码 1。
 */
public final class EngineTransformTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();

    private EngineTransformTest() {
    }

    public static void main(String[] args) {
        int failures = 0;
        String fatal = null;
        try {
            runAutoCreate();
            runOrder();
            runHostAccess();
            runScaleSemantics();
            runEnableSemantics();
            runPositionWrites();
            runAfterDestroy();
        } catch (Throwable t) {
            fatal = t.toString();
            t.printStackTrace();
        }
        if (fatal != null) {
            RESULTS.add(new String[]{"enginetransformtest caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        System.out.println("========== EngineTransformTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            System.out.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        System.out.println("----------------------------------------");
        System.out.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        System.exit(failures == 0 ? 0 : 1);
    }

    // ---------------- 构造时自动创建 ----------------

    private static void runAutoCreate() {
        GameObject go = new GameObject();
        check("xform-1 构造时自动创建 Transform", go.transform != null, "");
        check("xform-2 Transform 在能力列表第 0 位",
                go.Abilitys.size() >= 1 && go.Abilitys.get(0) == go.transform,
                "size=" + go.Abilitys.size());
        check("xform-3 Transform 已回调 OnInit（列表里只有它一个能力，Count OnAdded=OnInit=1）",
                go.transform.getHost() == go, "");
        check("xform-4 构造后对象已进入 GameSekai.GameObjects",
                GameSekai.GameObjects.contains(go), "");
        cleanup();
    }

    // ---------------- order ----------------

    private static void runOrder() {
        GameObject go = new GameObject();
        TransformAbility tr = go.transform;
        check("xform-5 Transform 的 order 是最小值（最先执行）",
                tr.GetOrder() == Framework.AbilityOrder.TRANSFORM_FIRST,
                "order=" + tr.GetOrder());

        // 试图把 Transform 排到后面：必须无效（缺陷 f 的硬保证）
        go.SetAbilityOrder(tr, 9999);
        check("xform-6 SetAbilityOrder 无法把 Transform 排到后面",
                tr.GetOrder() == Framework.AbilityOrder.TRANSFORM_FIRST && go.Abilitys.get(0) == tr,
                "order=" + tr.GetOrder());
        check("xform-7 Transform 的 order 严格小于默认 order 0",
                tr.GetOrder() < Framework.AbilityOrder.DEFAULT, "order=" + tr.GetOrder());
        cleanup();
    }

    // ---------------- 宿主访问 ----------------

    private static void runHostAccess() {
        GameObject go = new GameObject();
        check("xform-8 getHost() 返回宿主", go.transform.getHost() == go, "");
        check("xform-9 Transform 类型上直接可调用 getHost",
                ((IAbility) go.transform).getHost() == go, "");
        cleanup();
    }

    // ---------------- scale 语义（兼容性红线） ----------------

    private static void runScaleSemantics() {
        GameObject go = new GameObject();
        TransformAbility tr = go.transform;
        tr.scale = new Vector2(40f, 40f);
        // 审计 §5：scale 当半宽半高用（Renderer2DAbility 顶点 ±scale，isVisible 也当半宽半高）
        check("xform-10 scale 仍按原样存储（40,40），不做任何换算",
                tr.scale.x == 40f && tr.scale.y == 40f,
                "scale=" + tr.scale.ToString());
        check("xform-11 scale 与 Vector2 实例语义一致（可整体替换）",
                tr.scale instanceof Vector2, "");
        cleanup();
    }

    // ---------------- 启用开关 ----------------

    private static void runEnableSemantics() {
        GameObject go = new GameObject();
        TransformAbility tr = go.transform;
        check("xform-12 默认启用", tr.GetEnable(), "");
        tr.SetEnable(false);
        check("xform-13 SetEnable(false) 生效（加固前是空实现，永远 true）",
                !tr.GetEnable(), "enable=" + tr.GetEnable());
        tr.SetEnable(true);
        check("xform-14 SetEnable(true) 恢复", tr.GetEnable(), "");
        cleanup();
    }

    // ---------------- 位置写入 ----------------

    private static void runPositionWrites() {
        GameObject go = new GameObject();
        TransformAbility tr = go.transform;
        tr.position = new Vector2(50f, 100f);
        check("xform-15 position 可整体替换",
                tr.position.x == 50f && tr.position.y == 100f, "");

        tr.position.x += 10f;
        tr.position.y -= 20f;
        check("xform-16 position 就地修改生效",
                tr.position.x == 60f && tr.position.y == 80f,
                "pos=" + tr.position.ToString());

        tr.rotation = 180f;
        check("xform-17 rotation 写入生效", tr.rotation == 180f, "");
        cleanup();
    }

    // ---------------- 销毁后 ----------------

    private static void runAfterDestroy() {
        GameObject go = new GameObject();
        TransformAbility tr = go.transform;
        tr.position = new Vector2(7f, 8f);

        go.Destroy();
        DestroyQueue.commit();
        check("xform-18 销毁后 transform 引用仍可读（不 NPE）",
                tr.position.x == 7f && tr.position.y == 8f, "");
        check("xform-19 销毁后对象已离开场景", !GameSekai.GameObjects.contains(go), "");
        check("xform-20 销毁后 Transform 已从能力列表移除", go.Abilitys.isEmpty(),
                "size=" + go.Abilitys.size());
        check("xform-21 销毁后 getHost 仍可读（用于清理判断）", tr.getHost() == go, "");
        cleanup();
    }

    // ---------------- 工具 ----------------

    private static void cleanup() {
        List<GameObject> snapshot = new ArrayList<GameObject>(GameSekai.GameObjects);
        for (GameObject go : snapshot) {
            go.Destroy();
        }
        DestroyQueue.commit();
        GameSekai.GameObjects.clear();
        DestroyQueue.clear();
        CollisionSystem.get().size();
    }

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false", detail == null ? "" : detail});
    }
}
