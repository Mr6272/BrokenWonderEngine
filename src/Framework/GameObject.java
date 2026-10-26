package Framework;

import Core.GameRenderer;
import Core.GameSekai;
import TypeStructure.Tag;

import javax.media.opengl.GLAutoDrawable;
import java.util.List;

/*
*
* 游戏对象
* 游戏所有物体都属于go
* */
public class GameObject {
    public TransformAbility transform = null;
    public Tag tag = new Tag("unset");
    public List<IAbility> Abilitys;
    public boolean isEnabled = true;

    public GameObject()
    {
        Abilitys = new java.util.ArrayList<IAbility>();
        TransformAbility tr = new TransformAbility();
        tr.OnInit();
        tr.OnAdded(this);
        Abilitys.add(tr);
        transform = tr;
        GameSekai.GameObjects.add(this);
    }

    public void Update()
    {
        if (!isEnabled)
            return;
        for (IAbility tg : Abilitys)
        {
            tg.OnUpdate();
        }
    }

    public void Draw(GLAutoDrawable glAutoDrawable)
    {
        if (!isEnabled)
            return;
        // 遍历全部能力，按类型判断是否渲染（修复：旧实现硬编码跳过索引 0）
        for (int i = Abilitys.size() - 1; i >= 0; i--)
        {
            IAbility tg = Abilitys.get(i);
            if (tg instanceof IRenderer)
            {
                ((IRenderer) tg).Draw(glAutoDrawable);
            }
        }
    }

    public void AddAbility(IAbility ability)
    {
        ability.OnInit();
        ability.OnAdded(this);
        Abilitys.add(ability);
    }

    public void RemoveAbilityByIndex(int t)
    {
        Abilitys.get(t).OnRemove();
        Abilitys.remove(t);
    }

    public boolean RemoveAbility(IAbility tg)
    {
        tg.OnRemove();
        return Abilitys.remove(tg);
    }

    public void OnCollision(GameObject other) {
    }

}
