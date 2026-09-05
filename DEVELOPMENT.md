# Luma Todo 开发入口

## 打开工程

使用 VS Code 打开 `luma-todo.code-workspace`。工程不依赖特殊插件，安装 Node.js 后即可运行。

## 启动

首次运行：

```powershell
npm install
npm start
```

之后可以直接按 `F5` 调试。

## 修改界面

主要修改以下三个文件：

1. `index.html`：增加或调整界面区域。
2. `src/theme-graphite.css`：颜色、透明度、字号、间距和组件外观。
3. `src/app.js`：待办、项目、日期解析和交互逻辑。

保存代码后，重新启动应用即可看到变化。

## 窗口缩放

鼠标移动到窗口任意边缘或四角时会显示缩放光标。拖动即可调整窗口，应用会分别记住小组件模式和展开月历模式的尺寸。


## 修改前

先阅读仓库根目录的 `AGENTS.md`。其中的稳定性、数据安全、Todo/Event 语义和发布规则适用于所有修改。

功能开发和 cleanup 不直接在 `main` 上进行。维护性修改也应使用独立分支，并避免顺手重构无关代码。

## 提交前检查

至少运行：

```powershell
npm run check
```

该命令检查主进程、preload 和 renderer JavaScript 的语法。涉及打包配置的修改还需要实际执行 Windows 打包；涉及日历、Todo、Pin 或同步的修改需要做对应的手工 smoke test。
