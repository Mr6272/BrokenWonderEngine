package Framework;

import Core.EventBus;
import Core.GameSekai;
import Core.destroy.DestroyQueue;
import TypeStructure.Tag;

import javax.media.opengl.GLAutoDrawable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/*
*
* 游戏对象
* 游戏所有物体都属于go
*
* ---------------------------------------------------------------
* 本轮加固（审计 §2.1 / 架构 §3.3），逐条对应：
*   a) AddAbility 同一实例重复添加 → TryAddAbility 去重并返回 boolean；
*      旧的 void AddAbility 保留（旧调用方 Xia/Kuwu/SunAttack 仍可用），内部同样去重。
*   b) OnInit 现在在 OnAdded **之后**调用，能力在 OnInit 里可以通过 getHost() 拿到宿主。
*   c) 新增 Destroy() / isDestroyed()：标记 → 帧末由 DestroyQueue.commit() 统一提交；
*      提交时对每个能力回调 OnRemove 恰好一次，并清空能力列表。
*   d) Update() / Draw() 用快照迭代：能力在 OnUpdate 里 RemoveAbility / AddAbility 均安全。
*   e) RemoveAbility 先判定对象是否在列表里：不在则不回调 OnRemove（幂等）。
*   f) 能力按 AbilityOrder 稳定排序执行；TransformAbility 恒为第 0 位。
*
* 兼容性红线（审计 §5）：Abilitys 仍是 public List<IAbility>，transform 仍是
* public TransformAbility 字段，构造时仍自动创建 Transform 并加入 GameSekai.GameObjects。
* */
public class GameObject {
    public TransformAbility transform = null;
    public Tag tag = new Tag("unset");
    public List<IAbility> Abilitys;
    public boolean isEnabled = true;

    /** 缺陷 c：Destroy() 后置 true，同帧不真正移除（延迟到帧末 commit）。 */
    private boolean destroyed = false;

    /** 缺陷 c：commit 只会把对象从全局列表摘一次。 */
    private boolean removedFromScene = false;

    public GameObject()
    {
        Abilitys = new java.util.ArrayList<IAbility>();
        TransformAbility tr = new TransformAbility();
        tr.OnAdded(this);
        tr.OnInit();
        AbilityOrder.set(tr, AbilityOrder.TRANSFORM_FIRST);
        Abilitys.add(tr);
        transform = tr;
        GameSekai.GameObjects.add(this);
    }

    // ---------------- 更新 / 绘制 ----------------

    /**
     * 缺陷 d：快照迭代。能力在 OnUpdate 里移除自己或别的能力不会抛
     * ConcurrentModificationException；本帧被移出的能力也不再收到 OnUpdate。
     * 缺陷 c：已标记销毁的对象不再执行 OnUpdate。
     */
    public void Update()
    {
        if (!isEnabled || destroyed)
            return;
        IAbility[] snapshot = Abilitys.toArray(new IAbility[0]);
        for (IAbility tg : snapshot)
        {
            if (tg == null)
                continue;
            if (indexOfIdentity(tg) < 0)
                continue; // 本帧已被移除
            tg.OnUpdate();
        }
    }

    public void Draw(GLAutoDrawable glAutoDrawable)
    {
        if (!isEnabled || destroyed)
            return;
        // 遍历全部能力，按类型判断是否渲染（修复：旧实现硬编码跳过索引 0）
        IAbility[] snapshot = Abilitys.toArray(new IAbility[0]);
        for (int i = snapshot.length - 1; i >= 0; i--)
        {
            IAbility tg = snapshot[i];
            if (tg == null)
                continue;
            if (indexOfIdentity(tg) < 0)
                continue;
            if (tg instanceof IRenderer)
            {
                ((IRenderer) tg).Draw(glAutoDrawable);
            }
        }
    }

    // ---------------- 能力增删（缺陷 a / e / f） ----------------

    /**
     * 缺陷 a：去重添加。同一实例重复添加返回 {@code false} 且不改变列表、不重复回调生命周期。
     *
     * <p>顺序约定（缺陷 b）：先 {@code OnAdded(host)} 再 {@code OnInit()}。
     */
    public boolean TryAddAbility(IAbility ability)
    {
        if (ability == null || destroyed)
            return false;
        if (indexOfIdentity(ability) >= 0)
            return false; // 缺陷 a：同一实例已在列表里

        if (ability instanceof TransformAbility)
            AbilityOrder.set(ability, AbilityOrder.TRANSFORM_FIRST); // 缺陷 f：Transform 永远最先

        Abilitys.add(ability);
        reorderAbilities();
        try {
            ability.OnAdded(this);
            ability.OnInit();
        } catch (RuntimeException e) {
            // 半初始化状态不留在列表里
            Abilitys.remove(indexOfIdentity(ability));
            AbilityOrder.forget(ability);
            throw e;
        }
        return true;
    }

    /**
     * 旧入口，签名保留（UserUsage/xia_demo 的 Xia / Kuwu / SunAttack 依赖它）。
     * 行为与 {@link #TryAddAbility(IAbility)} 一致：同样去重（缺陷 a）。
     */
    public void AddAbility(IAbility ability)
    {
        TryAddAbility(ability);
    }

    /**
     * 缺陷 e：先判定在不在列表里。不在列表里返回 {@code false} 且**不**回调 OnRemove，
     * 避免同一能力收到多次 OnRemove。
     */
    public boolean RemoveAbility(IAbility tg)
    {
        if (tg == null)
            return false;
        int idx = indexOfIdentity(tg);
        if (idx < 0)
            return false; // 缺陷 e：不在列表 → 不回调 OnRemove
        Abilitys.remove(idx);
        AbilityOrder.forget(tg);
        tg.OnRemove();
        return true;
    }

    /**
     * 按下标移除。越界（含负数）安全返回，不抛异常（缺陷 e 的一部分）。
     * 保留 void 签名，避免破坏既有调用方。
     */
    public void RemoveAbilityByIndex(int t)
    {
        if (t < 0 || t >= Abilitys.size())
            return;
        RemoveAbility(Abilitys.get(t));
    }

    /**
     * 缺陷 f：设置能力执行顺序（数值越小越先）。返回 void 以保持"写起来像赋值"。
     * TransformAbility 的 order 会被强制夹到 {@link AbilityOrder#TRANSFORM_FIRST}，永远最先。
     */
    public void SetAbilityOrder(IAbility ability, int order)
    {
        if (ability == null)
            return;
        int effective = order;
        if (ability instanceof TransformAbility) {
            effective = AbilityOrder.TRANSFORM_FIRST; // 缺陷 f：Transform 身份优先于数值
        }
        AbilityOrder.set(ability, effective);
        reorderAbilities();
    }

    public int GetAbilityOrder(IAbility ability)
    {
        return AbilityOrder.get(ability);
    }

    /** 缺陷 f：按 order 稳定排序（同 order 保持加入顺序），并保证 Transform 在第 0 位。 */
    private void reorderAbilities()
    {
        if (Abilitys.size() < 2)
            return;
        // Collections.sort 是稳定排序：order 相同的元素保持原有相对顺序
        Collections.sort(Abilitys, ORDER_COMPARATOR);
        int idx = indexOfIdentity(transform);
        if (idx > 0) {
            Abilitys.remove(idx);
            Abilitys.add(0, transform);
        }
    }

    private static final Comparator<IAbility> ORDER_COMPARATOR = new Comparator<IAbility>() {
        public int compare(IAbility a, IAbility b) {
            return Integer.compare(AbilityOrder.get(a), AbilityOrder.get(b));
        }
    };

    // ---------------- 对象销毁（缺陷 c） ----------------

    /**
     * 缺陷 c：销毁对象。立即标记 destroyed（本帧不再 Update / Draw / 参与物理同步），
     * 真正移出 {@code GameSekai.GameObjects} 与能力清理延迟到帧末 {@code DestroyQueue.commit()}。
     * 幂等：重复调用无副作用。
     */
    public void Destroy()
    {
        if (destroyed)
            return;
        destroyed = true;
        DestroyQueue.enqueue(this);
    }

    public boolean isDestroyed()
    {
        return destroyed;
    }

    /**
     * 帧末提交（由 {@link DestroyQueue#commit()} 调用，不应该手工调用）。
     * 每个仍挂在对象上的能力回调 OnRemove 恰好一次；重复提交幂等。
     */
    public void CommitDestroy()
    {
        if (!removedFromScene) {
            removedFromScene = true;
            for (int i = GameSekai.GameObjects.size() - 1; i >= 0; i--) {
                if (GameSekai.GameObjects.get(i) == this) {
                    GameSekai.GameObjects.remove(i);
                }
            }
        }
        destroyed = true;
        isEnabled = false;

        IAbility[] snapshot = Abilitys.toArray(new IAbility[0]);
        for (IAbility a : snapshot) {
            if (a == null)
                continue;
            int idx = indexOfIdentity(a);
            if (idx < 0)
                continue; // 已经被移除过 → 不再重复 OnRemove（缺陷 e 的同一原则）
            // 先摘出列表再回调：OnRemove 里再调 RemoveAbility 不会重入
            Abilitys.remove(idx);
            AbilityOrder.forget(a);
            try {
                a.OnRemove();
            } catch (RuntimeException e) {
                System.err.println("GameObject.CommitDestroy: 能力 OnRemove 失败 -> " + e);
            }
        }
        Abilitys.clear();

        // 缺陷 c + 审计 §3 第 7 条：对象销毁时自动摘掉挂在「自身作为作用域」上的全部事件订阅，
        // 避免"实体已销毁但全局总线还持有它的回调"（悬空回调）。
        EventBus.get().clearScope(this);
    }

    // ---------------- 碰撞 ----------------

    /**
     * 旧路径：每帧对「仍重叠」的每一对调用（等价于 stay）。为兼容 xia_demo 的
     * Kuwu / SunAttack 保留，签名与触发时机都不变。
     */
    public void OnCollision(GameObject other) {
    }

    /** 碰撞进入（架构 §4.3）：上一 tick 无接触、本 tick 有。每对一次。 */
    public void OnCollisionEnter(GameObject other) {
    }

    /** 碰撞保持（架构 §4.3）：连续两 tick 都有接触。每 tick 一次。 */
    public void OnCollisionStay(GameObject other) {
    }

    /** 碰撞离开（架构 §4.3）：上一 tick 有、本 tick 无。每对一次（销毁期不派发）。 */
    public void OnCollisionExit(GameObject other) {
    }

    // ---------------- 工具 ----------------

    /** 按对象同一性查下标（不用 equals，避免用户自定义 equals 的能力互相误伤）。 */
    private int indexOfIdentity(IAbility ability)
    {
        for (int i = 0; i < Abilitys.size(); i++) {
            if (Abilitys.get(i) == ability)
                return i;
        }
        return -1;
    }

    @Override
    public String toString()
    {
        return "GameObject(" + tag.TagName + (destroyed ? ",destroyed" : "") + ")";
    }
}
