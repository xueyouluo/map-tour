# 出行规划转可视化地图

轻量 H5 工具：把文字、Markdown、表格或行程截图解析成高德地图路线页，并生成可分享链接。

## 本地运行

要求 Node.js `>=22.13.0`，服务端使用 Node 内置 SQLite 存储分享数据。

1. 安装依赖：

```bash
npm install
```

2. 创建 `.env`：

```bash
cp .env.example .env
```

3. 填写配置：

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=deepseek-flash
OPENAI_BASE_URL=https://api.deepseek.com
AMAP_JSAPI_KEY=...
AMAP_SECURITY_JS_CODE=...
PORT=8787
SQLITE_DB_PATH=data/map-tour.sqlite
```

4. 启动：

```bash
npm run dev
```

前端默认在 `http://127.0.0.1:5173/`，API 默认在 `http://127.0.0.1:8787/`。

## 网页设置与新建行程

行程页顶部的「新建行程」直接打开文字/截图导入框，成功后进入新行程，原行程保留在历史中。手机也保留文字按钮。

管理员登录后，管理后台或 `/settings` 提供统一行程解析（文字 / 截图）、高德地图及视频开关配置，以及内置音乐数量和服务就绪状态。保存采用局部更新：密钥输入留空保留，勾选清除才移除；已有密钥不回传。配置写入权限 0600 的 `data/local-settings.json`，优先于 `.env`，重启后保留。新解析/制作任务直接使用新配置；地图变更需刷新页面。端口、数据库和运行目录仍通过启动环境设置，音乐文件通过导入命令管理。

配置接口需要管理员登录，本机与服务器部署均可使用；普通用户不显示设置入口，接口也会拒绝访问。首次管理员初始化、账号管理和额度说明见 [账号与权限](docs/AUTH.md)。

首页采用浅色旅行手记与居中导入布局，不预加载大地图；支持示例路线填入与最近行程恢复。设计及图片资产说明见 [首页](docs/HOMEPAGE.md)。

## 功能

- 粘贴文字、Markdown、表格，或上传行程截图。
- 文字与截图统一使用同一套 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 配置（当前为 `deepseek-flash`），通过 OpenAI 兼容接口输出结构化 JSON。截图以图片直接发送，不单独调用方舟或其他模型；旧 `ARK_*` 配置不再用于解析。
- 解析结果包含 `tripScope`，用于区分单城市、多城市或不确定行程，辅助高德 POI 匹配。
- 浏览器端使用高德 JSAPI 匹配 POI 和规划路线。
- 按天分色显示 Marker 和路线，短距离使用步行，失败时直线兜底。
- 可切换驾车、公交、步行或自动路线，并支持跨天连接自驾环线。
- 可关闭路线显示，仅查看地点分布。
- 行程地图使用蓝色简洁底图，保留行程地点并自动避让名称；可切换卫星图、倾斜视角及按天筛选，底图选择会在本机保存。
- 支持通过 `AMAP_MAP_STYLE_ID` 接入已发布的高德自定义配色，配置步骤和设计色表见 [地图配色](docs/MAP_THEME.md)。
- 解析完成后自动保存草稿；点击分享后生成 `/s/:id` 分享页。
- 提供 `/history` 历史页，按更新时间展示草稿和已分享行程。
- 数据保存在本地 SQLite 数据库 `data/map-tour.sqlite`。
- OpenAI key 和高德安全密钥只在服务端使用；前端只拿高德 JSAPI key。

## 旅程视频

行程页采用电影工作台布局：每日章节、中央竖屏影片和配乐/时长配置直接显示在页面中，可切换到行程地图。预览连续卫星地图上的 3D 路线后，优先在用户浏览器中生成 MP4，设备不支持或导出失败时自动转入后台队列。支持默认/上传音乐、取消与重试、本机成片恢复、后台进度、预览和下载。每天的路线保留在同一张地图上，镜头和高清底图自动安排。

运行环境与队列说明见 [旅程视频](docs/VIDEO_EXPORT.md)。也可用 `npm run video:list`、`npm run video:preview -- --itinerary YOUR_ID` 独立生成，命令说明见 [本地视频预览](docs/LOCAL_VIDEO_PREVIEW.md)。

内置配乐支持五种旅行风格、每种 A/B 两版，可试听并记住选择。使用 `npm run music:import -- --source 合集目录` 导入本次十首音乐；运行时读取独立的 `assets/music/`，源音频保持不变。

## 生产运行

```bash
npm install
npm run build
npm start
```

生产模式下 Express 会同时提供 API 和 `dist/` 前端静态文件，默认监听 `PORT=8787`。

## 验证

```bash
npm run test
npm run build
```

构建后可用下面命令检查密钥没有进入前端产物：

```bash
rg "OPENAI_API_KEY|AMAP_SECURITY_JS_CODE" dist
```
