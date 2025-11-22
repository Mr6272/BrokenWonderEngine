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
* */
public interface IAbility {
    public void SetIndex(int index);
    public int GetIndex();
    public void OnAdded(GameObject gameObject);
    public void OnInit();
    public void SetEnable(boolean value);
    public void OnUpdate();
    public boolean GetEnable();
    public void OnRemove();
}