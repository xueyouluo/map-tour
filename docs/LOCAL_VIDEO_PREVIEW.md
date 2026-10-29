# 本地路线视频原型

这个工具直接读取 map-tour 行程，自动生成单张连续卫星地图上的 3D 路线视频。它独立运行，不需要启动应用，不新增 HTTP 导出接口，不接正式导出队列，也不写入行程数据库。

## 使用

安装项目依赖后，列出本地 SQLite 中的行程：

```bash
npm run video:list
```

只计算路线、时间线、镜头高度和地图范围，不访问地图服务：

```bash
npm run video:plan -- --itinerary YOUR_ID
```

生成完整预览视频（默认输出到新的 `outputs/video-preview-.../`）：

```bash
npm run video:preview -- --itinerary YOUR_ID
```

指定目标时长、音乐和新的输出目录：

```bash
npm run video:preview -- --itinerary YOUR_ID --duration 40 --music '/absolute/path/music.mp3' --out outputs/my-new-preview
```

也可以读取导出的原始行程 JSON，或 `{ "itinerary": ... }` 格式的接口响应：

```bash
npm run video:preview -- --input /absolute/path/itinerary.json
```

没有 ID 的本地 JSON 会按内容生成稳定的本地 ID，原文件不修改。

查看完成目录中的可编辑 Three.js 场景和视频：

```bash
npm run video:serve -- --out outputs/my-new-preview
```

工具会打印本次本地地址；用 Ctrl+C 关闭该次服务。直接打开 `preview.mp4` 无需服务。HTML 场景需要通过此命令打开，以加载项目安装的 Three.js 模块。

## 输入与自动处理

- 使用现有 `Itinerary` 数据契约。读取每日主路线地点和坐标，保留已规划路线几何及交通方式；不把备选地点自动加入主路线。
- 所有主路线地点必须已匹配坐标；未匹配时指出地点名称并停止，不编造坐标或静默删除地点。
- 复用有效的完整路线或原有示意路线；缺少路线或规划失败时使用直线兜底并写入警告。所有示意几何均用虚线和“路线为示意”标注。缺少跨天路线时同样处理，不假定具体火车班次、酒店或道路。
- 步行用小人，驾车用小车。`transit` 用公共交通位置标记，避免凭公交模式猜测公交车或地铁；显式 `rail` / `ferry` 数据支持列车 / 小船。
- 根据路线长度自动分配移动时间，抵达停留 0.5 秒；片头 3 秒，片尾 4 秒。默认时长随路线段数调整，最长默认 120 秒；显式时长上限为 180 秒。时长不足时提示最短时长。
- 镜头根据交通方式、路程长短和地理范围计算，长距离路段自动拉远；跨天连续移动，保留每天足迹。远景高度按竖屏实际可见区域计算，避免某个城市出画。
- 地图按行程实际范围生成区域层。低空视野通过实际相机采样决定 zoom 16 / 17 高清卫星补片范围；缓存纹理按位置加载，编码前等待该帧所需纹理完成。
- 使用 Terrarium 公共高程数据和近似 GCJ02/WGS84 显示对齐，垂直比例 1×。地形不包含真实建筑模型；不同区域的原始卫星清晰度可能不同。

## 依赖与配置

- Node.js 使用项目要求的版本；需要本机已安装 Chrome/Chromium、`ffmpeg`、`ffprobe` 和 `curl`。
- Three.js、Playwright Core 和 PNG 解码器属于项目开发依赖；不会下载或安装浏览器，也不依赖历史样片目录或个人技能目录。
- 完整生成需要根目录 `.env` 中的 `AMAP_JSAPI_KEY`、`AMAP_SECURITY_JS_CODE`。浏览器仅取得 JSAPI key；安全码留在本地服务代理中，不嵌入成片工程。
- `--plan-only` 不需要地图配置、浏览器或 FFmpeg。
- 可用 `--db` 指定现有数据库，默认读取 `SQLITE_DB_PATH` 或 `data/map-tour.sqlite`。数据库以 `readOnly: true` 打开，绕过可能创建或迁移数据库的 `ItineraryStore`。
- 可用 `--chrome` 或环境变量 `CHROME_PATH` 指定浏览器可执行文件。
- 未指定 `--music` 时生成无音轨视频。指定时使用音乐的连续片段，淡入淡出并降低 2 dB，不变速；当前阶段不做自动节拍识别。音乐短于视频会明确报错。

## 缓存和输出保护

共享素材缓存位于 `outputs/.video-preview-cache/`，可用 `--cache-dir` 更改。缓存记录采集坐标、像素误差和 SHA256；复用前校验。新工程复制需要的素材，可以保留结果后删除共享缓存。无需保留旧样片目录。

输出目录必须不存在，工具不会覆盖历史成片。每次生成有自己的 `.preview.lock` 和 `manifest.json`；缓存资产使用排他锁。发现其他任务占用时不接管、不清理其锁。异常时保留诊断和已有素材，释放本次拥有的锁和本次浏览器 / 服务。该原型暂不支持在原目录断点续跑；新目录重跑会复用已完成缓存。

高清补片默认最多 300 张，超过时在采集前停止，可通过 `--max-detail-tiles` 调整（上限 2000）。高程瓦片上限为 600 张。工具不会为了通过这些限制而静默降低清晰度。

主要文件：

| 文件 | 用途 |
| --- | --- |
| `itinerary.json` | 本次读取的原行程快照 |
| `plan.json` / `storyboard.md` | 自动计算的路线、时间线、镜头和分镜 |
| `detail-plan.json` | 实际相机视野对应的高清底图范围 |
| `terrain-data.json` / `atlas-*.jpg` / `detail-tiles/` | 本次渲染素材 |
| `film.js` / `film.html` | 可编辑的连续地图场景 |
| `preview.mp4` | 完整编码后的成片；失败的编码保留为 `preview.partial.mp4` |
| `animation-check.json` | 跳转一致性、角色构图和全程地点构图检查 |
| `verification.json` | 最终文件帧数、解码、音轨和浏览器播放检查 |
| `manifest.json` | 本次来源指纹、阶段、耗材缓存统计和状态 |

自动生成成功与人工视觉验收分别记录。工具会从最终 MP4 抽取封面、抵达、步行、全程远景和接触表；`visualInspectionPending` 默认为 `true`，需要实际看过后再记录结果。自动解码通过不代表画面或路线语义已被人工确认。

## 实现入口

- `src/shared/videoPlan.ts`：纯函数行程适配、镜头参数、时间分配和高清范围规划。
- `tools/video-preview/cli.mjs`：独立本地命令。
- `tools/video-preview/input.mjs`：只读输入。
- `tools/video-preview/assets.mjs`：真实高程、卫星影像和带指纹的缓存。
- `tools/video-preview/browser/film.js`：沿用样片效果并去除固定城市和天数。
- `tools/video-preview/render.mjs`：确定性逐帧编码和最终文件自动检查。

验证命令沿用 `npm run test` 和 `npm run build`。命令本身独立运行；应用页面、任务队列、上传音乐和下载功能见 [旅程视频](VIDEO_EXPORT.md)。当前不包含自动补 POI 或自动音乐节拍编排。
