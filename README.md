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


## Google 同步说明

Google 同步需要 OAuth 2.0 授权。账号令牌和待办数据仅保存在用户电脑的应用数据目录，不会提交到本仓库。

推荐的数据规则：

- 普通任务和仅含日期的任务 ↔ Google Tasks
- 选择同步到日历的 Luma 日程 ↔ Google Calendar
- Google 中原有的日历事件 → Luma 只读显示
- Luma 分类名称、颜色和顺序通过隐藏的同步元数据跨设备恢复

