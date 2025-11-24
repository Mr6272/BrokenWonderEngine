package UserUsage.FighjtMengpo;

import java.awt.event.KeyEvent;

import AbstractLayer.MainWindow;
import Framework.GameObject;
import Tool.Log;
import UI.UIManager;
import UI.UIPanel;
import UI.UITweens;

public class keyCtrl extends GameObject {

    public keyCtrl() {
        super();
    }
    @Override
    public void Update() {
        super.Update();
        if (MainWindow.keyManager.isKeyDown(KeyEvent.VK_F2)) {
            Log.d("keyctrl");
            UIPanel up = (UIPanel) UIManager.getInstance().findElement("totaldia");
            UITweens.moveTo(up, up.getX() + 300, up.getY(), 0.35f);
        }
    }
}
