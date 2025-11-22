## Getting Started

Welcome to the VS Code Java world. Here is a guideline to help you get started to write Java code in Visual Studio Code.

## Folder Structure

The workspace contains two folders by default, where:

- `src`: the folder to maintain sources
- `lib`: the folder to maintain dependencies

Meanwhile, the compiled output files will be generated in the `bin` folder by default.

> If you want to customize the folder structure, open `.vscode/settings.json` and update the related settings there.

## Dependency Management

The `JAVA PROJECTS` view allows you to manage your dependencies. More details can be found [here](https://github.com/microsoft/vscode-java-dependency#manage-dependencies).

## UI System

This project includes a complete UI system with the following components:
- UIButton: Button component with hover and click effects
- UIPanel: Container for grouping UI elements
- UILabel: Text display component with alignment options
- UIProgressBar: Progress bar with customizable colors
- UIManager: Singleton manager for handling UI components and events
- UIIntegration: Integration class connecting the UI system with the game engine

To use the UI system, refer to the UIExamples.java and UIUsageGuide.java files in the src/UI directory.

打包方法：CTRL+SHIFT+B后，按 Ctrl+Shift+P 打开命令面板，输入“Tasks: Run Task”，选择“package”任务即可打包。