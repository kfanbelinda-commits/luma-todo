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
