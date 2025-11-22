package Framework;

import Core.Vector2;

/*
* 这个方法必须存在于GO上，并且被渲染器识别与调用
* 必须是-1
* */
public class TransformAbility implements IAbility {
    public Vector2 position = new Vector2(0,0);
    public float rotation = 0;
    public Vector2 scale = new Vector2(1, 1);
    public boolean enable = true;

    public TransformAbility()
    {
        position = new Vector2(0, 0);
    }

    @Override
    public void SetIndex(int index) {
        //transform组件永远为-1
    }

    @Override
    public int GetIndex() {
        return -1;
    }

    @Override
    public void OnAdded(GameObject gameObject) {

    }

    @Override
    public void OnInit() {

    }

    @Override
    public void SetEnable(boolean value) {

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

    }
}
