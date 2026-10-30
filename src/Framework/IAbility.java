package Framework;


/*
*
* 每一个游戏对象具备的组件
* 能力。
*
* 组件有生命周期
*
* 激活的时候才能用。
*
* ---------------------------------------------------------------
* 生命周期契约（审计 §2.1 缺陷 b —— 旧实现 OnInit 在 OnAdded 之前调用，
* 此时能力拿不到宿主，OnInit 里访问 gameObject 必是 null）：
*
*   new GameObject()        → 自动创建 TransformAbility，宿主在构造期间即可用
*   AddAbility(ability)     → ① OnAdded(host)  ② OnInit()  ③ 按 order 插入列表
*   OnUpdate()              → 每逻辑帧，按 order 升序
*   RemoveAbility(ability)  → OnRemove() 恰好一次（不在列表里则不调用）
*   GameObject.Destroy()    → 帧末延迟提交，逐个能力 OnRemove() 恰好一次
*
* 关键语义：
*   - **OnAdded 先于 OnInit**。能力要在初始化阶段访问宿主，用 getHost() 或 OnAdded 收到的参数。
*   - OnRemove 幂等：重复移除 / 重复销毁不会重复回调。
*
* 兼容性红线（审计 §5）：接口的 6 个抽象方法签名一个都不能改
* （UserUsage/xia_demo 的 3 个实现类依赖）。因此 order / getHost
* 只能以 default 方法形式新增，状态放在 AbilityOrder 注册表与实现类字段里。
* */
public interface IAbility {
    public void OnAdded(GameObject gameObject);
    public void OnInit();
    public void SetEnable(boolean value);
    public void OnUpdate();
    public boolean GetEnable();
    public void OnRemove();

    /**
     * 能力执行顺序（缺陷 f）。
     *
     * <p>默认取自 {@link AbilityOrder} 注册表（由 {@code GameObject.SetAbilityOrder} 写入），
     * 未设置时为 {@link AbilityOrder#DEFAULT}。数值越小越先执行；
     * {@link TransformAbility} 恒为 {@link AbilityOrder#TRANSFORM_FIRST}，永远最先。
     */
    public default int GetOrder() {
        return AbilityOrder.get(this);
    }

    /**
     * 能力所属宿主（缺陷 b 的安全访问方式）。
     *
     * <p>旧的 {@code OnInit()} 先于 {@code OnAdded()} 调用，OnInit 里没有宿主可用。
     * 现在顺序已改为 OnAdded 在前；同时提供本方法作为统一入口：
     * 未挂载时返回 {@code null}（不抛异常），已挂载时返回宿主。
     *
     * <p>默认实现返回 null 是为了不破坏任何既有实现类；引擎内建能力
     * （Transform / Renderer2D / BoxCollider / Camera）都覆盖了它。
     */
    public default GameObject getHost() {
        return null;
    }
}
