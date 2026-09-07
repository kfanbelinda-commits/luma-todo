# Mobile Life Log

手机端日记入口，给桌面 Luma / Obsidian 用。页面看起来每天都是新的一天，实际始终更新同一个文件。

## 为什么单独放这个目录

Safari / PWA **不能静默写入 iCloud Drive**。CloudKit JS 需要付费开发者账号，Shortcuts 也要手动点一次。所以这版不假装能后台同步，只做三件能用的事：

1. 本地记住当天的天气、心情、絮语、照片（最多 9 张，压成 JPEG）
2. 导出 **一个** `lifelog.md`（给 Obsidian 库）
3. 同时导出 `lifelog-inbox.json`（字段对齐桌面 `lifelog.js`：`weather` / `mood` / `note` / `photos` / `coverPhotoId` / `updatedAt`）

iPhone 用法：Safari 打开 → 分享到「文件」 → 选 iCloud Drive 里的 Obsidian 库（或 Luma 之后会监听的目录）。桌面 Luma 读这个单文件即可，不必每天复制。

## 天气 / 心情 id（与桌面一致）

- weather: `sunny` `cloudy` `rainy` `foggy` `snowy` `storm`
- mood: `great` `good` `okay` `calm` `low` `awful`

## 还没做

- Electron 监听 iCloud / Obsidian 目录自动导入（桌面侧另开）
- HEIC 自动转 JPEG（体积太大，先让系统相册导出 JPEG，或用能解码的浏览器）
- 静默写 iCloud（浏览器做不到）
