package Core.SceneManageTool;

import java.util.HashMap;
import java.util.Map;

import Core.GameSekai;
import Framework.MapData.MapObjectData;
import Tool.Log;

public class SceneObjReg {

    private static final Map<String, SceneObjectFactory> factories = new HashMap<>();

    public static void register(String type, SceneObjectFactory factory) {
        factories.put(type, factory);
    }

    public static void createObject(String type, GameSekai scene, MapObjectData obj) {
        SceneObjectFactory factory = factories.get(type);
        if (factory != null) {
            factory.create(scene, obj);
        } else {
            Log.e("Unknown map object type: " + type);
        }
    }
}
