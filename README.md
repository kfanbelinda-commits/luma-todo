# Luma Todo

Luma Todo 是一个 Windows 桌面待办与月历小组件，采用半透明玻璃界面。默认以紧凑组件显示，点击日历按钮后向左展开月历。

## 下载

从 [GitHub Releases](https://github.com/kfanbelinda-commits/luma-todo/releases/latest) 下载最新版 Windows 安装包。安装后，Luma Todo 会自动检查并下载后续更新。

## 已实现

- 今日待办、未来节点和项目分组
- 项目名称与颜色、任务拖拽归类
- 中文日期时间快速解析
- 带时间任务创建后的提醒选择
- 月历展开与收起
- 未完成任务顺延天数提示
- 完成进度和已完成折叠
- 本地持久化、每日自动备份、手动导出
- Windows 开机启动开关和系统托盘
- 四边与四角拖拽缩放，并自动记住紧凑态和日历态尺寸
- Google Tasks 双向同步、Google Calendar 日程同步与跨设备分类恢复
- 深浅色模式、透明度记忆、窗口置顶和分类折叠

## 用 VS Code 打开

双击项目根目录中的 `luma-todo.code-workspace`，或在 VS Code 中选择“文件 → 打开文件夹”并选择当前目录。

第一次打开后，在 VS Code 终端运行：

```powershell
npm install
npm start
```

也可以按 `F5`，选择“运行 Luma Todo”。

## 代码位置

- `main.cjs`：Windows 窗口、托盘、开机启动、缩放与本地文件
- `preload.cjs`：桌面窗口和页面之间的安全接口
- `index.html`：界面结构
- `src/app.js`：待办、项目、月历和快速输入逻辑
- `src/theme-graphite.css`：当前石墨玻璃主题
- `src/styles.css`：基础样式

## 打包 Windows 安装包

```powershell
npm run dist
```

生成结果位于 `dist` 文件夹。

## Google 同步说明

Google 同步需要 OAuth 2.0 授权。账号令牌和待办数据仅保存在用户电脑的应用数据目录，不会提交到本仓库。

推荐的数据规则：

- 普通任务和仅含日期的任务 ↔ Google Tasks
- 选择同步到日历的 Luma 日程 ↔ Google Calendar
- Google 中原有的日历事件 → Luma 只读显示
- Luma 分类名称、颜色和顺序通过隐藏的同步元数据跨设备恢复

## 隐私

- 本地任务、备份、Google 令牌和 OAuth 凭据不会进入 Git。
- 项目不收集遥测数据。
- Google 数据仅用于用户主动启用的 Tasks 与 Calendar 同步。

## 发布

推送形如 `v0.4.0` 的版本标签后，GitHub Actions 会在 Windows 构建 NSIS 安装包并发布到 Releases。正式构建所需的 OAuth 配置从仓库 Secret `GOOGLE_OAUTH_CREDENTIALS_B64` 临时注入。
