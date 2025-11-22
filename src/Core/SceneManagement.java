package Core;

import Framework.*;

public class SceneManagement {
    static boolean isLoading;
    public static void Reduce(Scene scene)
    {
        if (isLoading)
            return;
        isLoading = true;
        for (int i = GameSekai.GameObjects.size() - 1; i >= 0; i--)
        {
            GameObject t = GameSekai.GameObjects.get(i);
            for(int j = t.Abilitys.size() - 1; j >= 0; j--)
            {
                IAbility ia = t.Abilitys.get(j);
                ia.OnRemove();
                if (ia instanceof ICollider)
                {
                    ICollider ic = (ICollider) ia;
                    CollisionSystem.get().unregister(ic);
                }
                if (ia instanceof Renderer2DAbility)
                {
                    Renderer2DAbility ir = (Renderer2DAbility) ia;
                    GameRenderer.RecycleTex(ir.SpriteObj.texture, t);
                }
                t.Abilitys.remove(j);
            }
            if (i < GameSekai.GameObjects.size())
                GameSekai.GameObjects.remove(i);
        }
        GameSekai.GameObjects.clear();
        scene.build(GameRenderer.sekai, scene.data);
        isLoading = false;
    }
}
