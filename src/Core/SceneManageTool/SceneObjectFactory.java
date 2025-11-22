package Core.SceneManageTool;

import Core.GameSekai;
import Framework.MapData.MapObjectData;

public interface SceneObjectFactory {
    void create(GameSekai scene, MapObjectData obj);
}
