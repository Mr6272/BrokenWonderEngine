package UserUsage.xia_demo;


import AbstractLayer.MainWindow;
import UI.UIButton;
import UI.UIManager;
import UI.UIPanel;
import UI.UITweens;

public class gameWindow extends MainWindow {
    
    static boolean isInitialized = false;
    public static void main(String[] args) {
        new Map("Data/level_01.json");
        MainWindow.main(args);
        // Load example UI group from JSON and enable F5 hot reload on that group.
        UIManager.getInstance().loadGroupFromJson("Data/ui_layout copy.json", "example");
        UIManager.getInstance().setHotReloadTarget("Data/ui_layout copy.json", "example");
        UIButton reload = (UIButton) UIManager.getInstance().findElement("reload_button");
        if (reload != null) {
            reload.setOnClick(() -> System.out.println("clicked!"));
        }
    }
}
