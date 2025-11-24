package UserUsage.FighjtMengpo;

import Core.GameSekai;
import Core.Scene;
import Core.SceneManageTool.SceneObjReg;
import Framework.MapData.MapData;
import Tool.Log;

public class mengpomap extends Scene {

    public mengpomap(String path)
    {
        super(path);
    }
    @Override
    public void build(GameSekai scene, MapData data) {
        SceneObjReg.register("keyctrl", (s, obj) -> {
            keyCtrl kc = new keyCtrl();
            Log.d("keyctrl");
        });
        super.build(scene, data);
    }
}
