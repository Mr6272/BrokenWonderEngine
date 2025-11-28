package UserUsage.FightMengpo;

import AbstractLayer.MainWindow;
import UI.UIManager;

public class mengpowindow {
    
    static boolean isInitialized = false;
    public static void main(String[] args) {
        new mengpomap("Data/mengpo.json");
        MainWindow.main(args);
        // Load example UI group from JSON and enable F5 hot reload on that group.
        UIManager.getInstance().loadGroupFromJson("Data/ui_layout.json", "example");
        UIManager.getInstance().setHotReloadTarget("Data/ui_layout.json", "example");
    }
}
