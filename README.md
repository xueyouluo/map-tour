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
OPENAI_MODEL=...
OPENAI_BASE_URL=https://api.openai.com/v1
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

## 功能

- 粘贴文字、Markdown、表格，或上传行程截图。
- 后端使用 OpenAI client 解析行程，严格输出结构化 JSON。
- 浏览器端使用高德 JSAPI 匹配 POI 和规划路线。
- 按天分色显示 Marker 和路线，短距离使用步行，失败时直线兜底。
- 生成 `/s/:id` 分享页，数据保存在本地 SQLite 数据库 `data/map-tour.sqlite`。
- OpenAI key 和高德安全密钥只在服务端使用；前端只拿高德 JSAPI key。

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
