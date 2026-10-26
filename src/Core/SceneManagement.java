package Core;

import Framework.*;
import TypeStructure.SpriteType;

import java.util.ArrayList;
import java.util.List;

public class SceneManagement {
    static boolean isLoading;

    public static void Reduce(Scene scene)
    {
        if (isLoading)
            return;
        isLoading = true;
        // 快照迭代：清理过程中 RecycleTex/OnRemove 会改动 GameObjects，避免边遍历边删
        List<GameObject> snapshot = new ArrayList<>(GameSekai.GameObjects);
        for (GameObject t : snapshot) {
            if (t == null) continue;
            for (int j = t.Abilitys.size() - 1; j >= 0; j--) {
                IAbility ia = t.Abilitys.get(j);
                ia.OnRemove();
                if (ia instanceof ICollider) {
                    CollisionSystem.get().unregister((ICollider) ia);
                }
                if (ia instanceof Renderer2DAbility) {
                    Renderer2DAbility ir = (Renderer2DAbility) ia;
                    if (ir.SpriteObj != null) {
                        if (ir.SpriteObj.SpType == SpriteType.Single) {
                            GameRenderer.DeleteTexture(ir.SpriteObj.texture);
                        } else if (ir.SpriteObj.SpType == SpriteType.Multiple && ir.SpriteObj.textures != null) {
                            for (int tex : ir.SpriteObj.textures) {
                                GameRenderer.DeleteTexture(tex);
                            }
                        } else if (ir.SpriteObj.SpType == SpriteType.Atlas && ir.SpriteObj.Atlas != null) {
                            GameRenderer.DeleteTexture(ir.SpriteObj.Atlas.textureId);
                        }
                    }
                }
            }
            t.Abilitys.clear();
        }
        GameSekai.GameObjects.clear();
        scene.build(GameRenderer.sekai, scene.data);
        isLoading = false;
    }
}
