# 错误日志与排查

登录用户的浏览器错误通过同源 `POST /api/diagnostics/events` 上报，由服务端写成一行 JSON，事件名为 `client.error`。生产环境下由 `map-tour.service` 的标准错误输出进入 journald；保留时长取决于服务器 journald 配置。

已覆盖：

- `video.export`：编码能力检测、素材准备、逐帧渲染、音视频编码、MP4 检查和本机保存失败；用户主动取消不报错。
- `video.preview`：场景加载失败、长时间无进展、iframe 内未捕获异常和 WebGL 上下文丢失。
- `video.request`：视频接口失败，包括已在界面处理的异常。
- `runtime.error` / `runtime.rejection`：主页面未捕获异常和未处理的 Promise 拒绝。
- `server.error`：API 意外错误、流式解析异常、视频服务/后台制作异常以及地图代理连接失败与非成功响应。包含原始异常及原因链。

客户端日志包含服务端确认的用户 ID、接收时间、客户端时间、事件 ID、前端构建标识、操作和失败阶段。视频错误还包含场景/行程 ID、导出尝试 ID、进度和耗时；逐帧失败保留具体帧号。浏览器环境包含 User-Agent、窗口尺寸、前后台和联网状态。可用时附加绘制尺寸、高清素材待加载/已加载数和队列状态；导出异常在恢复轻量预览之前采集。

错误保留 `name`、`message`、`stack` 和最多三层原因链，兼容 iframe 中的异常。只收集白名单诊断字段，不发送行程正文、坐标、截图、视频或自选音乐；URL 去掉凭证、查询参数和片段，常见密钥字段会脱敏。服务端再次校验、脱敏、限长，不接受客户端指定用户身份。

同一导出尝试的相同错误 30 秒内合并；新的尝试单独记录。服务端按事件 ID 在十分钟内去重，每个账户最多接收每分钟 30 条，单次请求不超过 16 KiB。网络失败时最多暂存 20 条在当前页面内存，恢复网络、后续报告或离页时尝试补报；上报失败不会触发新的错误上报或打断导出。页面被关闭、系统终止或持续断网时，未送达的事件仍可能丢失。没有登录或会话过期时不接收客户端诊断。

## 查询

查看最近一小时浏览器错误：

```bash
journalctl -u map-tour --since '1 hour ago' -o cat | rg '"event":"client.error"'
```

按场景筛选（替换 `SCENE_ID`）：

```bash
journalctl -u map-tour --since today -o cat | jq -R 'fromjson? | select(.event == "client.error" and .sceneId == "SCENE_ID")'
```

查看服务端错误：

```bash
journalctl -u map-tour --since today -o cat | rg '"event":"server.error"'
```

先按用户反映的时间或场景 ID 定位，再看 `stage`、`error.cause`、队列状态和浏览器版本。`buildId` 与栈中的资源文件哈希用于区分旧页面和当前版本；构建时可通过 `MAP_TOUR_BUILD_ID` 指定发布标识，默认使用构建时间。新增上报需要同时发布前端和服务端；已发生且当时没有上报的错误无法补回。
