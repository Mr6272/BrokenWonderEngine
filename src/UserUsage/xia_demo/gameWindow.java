package UserUsage.xia_demo;

import AbstractLayer.MainWindow;

public class gameWindow extends MainWindow {
    
    static boolean isInitialized = false;
    public static void main(String[] args) {
        new Map("Data/level_01.json");
        MainWindow.main(args);
    }
}
