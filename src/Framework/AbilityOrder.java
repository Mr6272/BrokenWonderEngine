package Framework;

import java.util.IdentityHashMap;
import java.util.Map;

/*
 * 能力执行顺序注册表（审计 §2.1 缺陷 f：执行顺序不确定）。
 *
 * 为什么不在 IAbility 上加字段：接口的 6 个抽象方法签名与实现类都不能动（UserUsage/xia_demo
 * 有 3 个实现类依赖它）。在接口上加 default 方法不破坏任何实现，但接口本身不能持有状态，
 * 所以把 order 值放在这张按「对象同一性」索引的表里（IdentityHashMap，不用 equals/hashCode，
 * 避免用户自定义 equals 的能力互相覆盖顺序）。
 *
 * 生命周期：能力从 GameObject 移除或对象销毁时，用 forget() 清掉条目，避免强引用泄漏。
 * */
public final class AbilityOrder {

    /** 未显式设置时的默认顺序。 */
    public static final int DEFAULT = 0;

    /** TransformAbility 永远最先执行，任何 SetOrder 都不能覆盖它。 */
    public static final int TRANSFORM_FIRST = -1000;

    private static final Map<IAbility, Integer> ORDERS = new IdentityHashMap<IAbility, Integer>();

    private AbilityOrder() {
    }

    public static int get(IAbility ability) {
        if (ability == null) {
            return DEFAULT;
        }
        Integer v = ORDERS.get(ability);
        return v == null ? DEFAULT : v.intValue();
    }

    public static void set(IAbility ability, int order) {
        if (ability == null) {
            return;
        }
        if (order == DEFAULT) {
            ORDERS.remove(ability);
        } else {
            ORDERS.put(ability, Integer.valueOf(order));
        }
    }

    public static void forget(IAbility ability) {
        if (ability != null) {
            ORDERS.remove(ability);
        }
    }

    /** 清空整套顺序表（测试与场景卸载用）。 */
    public static void clear() {
        ORDERS.clear();
    }

    public static int size() {
        return ORDERS.size();
    }
}
