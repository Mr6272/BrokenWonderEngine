package Framework;

import Core.Vector2;

/*
* 变换组件：位置/旋转/缩放。
* 每个 GameObject 构造时自动附带一个，通常位于能力列表第 0 位。
*
* 缺陷 f：Transform 的执行顺序恒为 {@link AbilityOrder#TRANSFORM_FIRST}（最先执行），
* 且 SetAbilityOrder 无法把它排到后面。
* 缺陷 b：getHost() 返回宿主，Transform 也遵守统一的宿主访问方式。
* */
public class TransformAbility implements IAbility {
    public Vector2 position = new Vector2(0,0);
    public float rotation = 0;
    public Vector2 scale = new Vector2(1, 1);
    public boolean enable = true;

    /** 缺陷 b：宿主引用（由 OnAdded 写入，getHost() 返回）。 */
    private GameObject gameObject;

    public TransformAbility()
    {
        position = new Vector2(0, 0);
    }

    @Override
    public void OnAdded(GameObject gameObject) {
        this.gameObject = gameObject;
    }

    @Override
    public void OnInit() {

    }

    @Override
    public void SetEnable(boolean value) {
        enable = value;
    }

    @Override
    public void OnUpdate() {

    }

    @Override
    public boolean GetEnable() {
        return enable;
    }

    @Override
    public void OnRemove() {
        // 宿主这里的引用保留：能力被移除后仍可从 getHost() 读到原宿主做清理判断
    }

    /** 缺陷 b：统一宿主访问入口。 */
    @Override
    public GameObject getHost() {
        return gameObject;
    }

    /** 缺陷 f：Transform 永远最先执行。 */
    @Override
    public int GetOrder() {
        return AbilityOrder.TRANSFORM_FIRST;
    }
}
