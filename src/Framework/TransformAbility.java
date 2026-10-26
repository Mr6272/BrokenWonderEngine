package Framework;

import Core.Vector2;

/*
* 变换组件：位置/旋转/缩放。
* 每个 GameObject 构造时自动附带一个，通常位于能力列表第 0 位。
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
