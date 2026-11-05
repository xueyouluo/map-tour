# 服务器运行与配置

当前生产地址为 `https://map-tour.followllm.online`。应用位于 `/opt/map-tour`，由 `map-tour.service` 运行；Express 仅监听 `127.0.0.1:8787`，由 Nginx 代理 HTTPS。Nginx 必须保留原始 Host、转发协议和来源 IP，上传上限设为 `32m`。

持久数据保留在服务器，不从开发机覆盖：

- `.env`：初始服务配置与密钥，权限 `0600`。
- `data/local-settings.json`：管理员网页保存的覆盖配置，优先于 `.env`。
- `data/map-tour.sqlite`：账号、额度、会话与行程；升级会自动添加表和字段。
- `data/video-exports/`、`data/video-cache/`：后台任务、上传音乐及地图素材。
- `assets/music/`：内置完整音乐、试听文件与 `catalog.json`，需要单独部署和保留。

解析模型使用 `deepseek-flash`，文字和截图共享配置。视频运行时使用 `/usr/bin/chromium-browser`、FFmpeg、ffprobe 和 curl；Linux 需要中文字体。素材采集使用卫星地图原生整数缩放，避免 SDK 对小数缩放取整造成影像边界错位。

2 核 2 GB 的服务器以素材准备为主，完整视频优先在浏览器生成。编码不支持、预览加载失败或本机导出失败都不自动创建后台视频；用户可查看失败原因、重试或手动转后台。后台仍保持单任务串行，避免增加并发；完整三维视频在此规格上可能较慢。本次仅更新前端时无需重启 API，也不打断已有任务。

首次管理员可通过 SSH 本地转发访问服务端 `/admin/setup`，用户自行输入账号密码。也可按 [账号文档](AUTH.md) 使用临时初始化令牌走公网 HTTPS。普通注册不创建管理员；管理员在 `/admin` 中管理账号、个人额度与服务设置。

部署时先锁定部署操作，在独立暂存目录安装依赖、运行测试和构建，并用生产数据库副本演练迁移。备份代码、依赖、配置、Nginx 配置和一致的 SQLite 快照，短暂停止服务后更新代码及依赖。不要将本地 `.env`、测试数据库、账号或视频任务覆盖到生产。保留旧代码、依赖和数据库备份供回滚；回滚应用一般不需要覆盖新增的线上数据。

浏览器直接准备素材的版本需要同步 `dist/.vite/manifest.json` 与所有新构建 chunk，再更新服务端并重启 `map-tour`。浏览器预览不再依赖服务器 Chromium/FFmpeg；这些只用于手动后台制作、旧任务或试听缩略图工具。音乐 CDN 可选：在已有对象存储中上传同名哈希 MP3，配置 `VIDEO_MUSIC_CDN_URL`（HTTPS 目录，允许浏览器 CORS），未配置时保留受权限保护的压缩 MP3 下载。禁止将 `.env`、生成的地图/音乐/视频或 SQLite 随源码覆盖。

浏览器事件通过 `/api/diagnostics/events` 入库并写入日志，失败筛选 `client.error`，成功等结果筛选 `client.event`；API、地图代理和后台制作异常筛选 `server.error`。主 SQLite 新增 `analytics_events` / `analytics_meta`，保留 90 天，可在管理员「使用报表」查看导出、分享、账号和额度拦截统计。字段、权限、限额及查询命令见 [使用报表与诊断](DIAGNOSTICS.md)。此功能需要同时更新前端构建及服务端；构建时指定 `MAP_TOUR_BUILD_ID` 并写入 `RELEASE`，方便关联发布版本。

服务器共享地图缓存默认 512 MiB、7 天未使用过期，启动和每小时自动检查，并在素材读取/后台任务结束后检查。配置 `VIDEO_CACHE_MAX_MB`、`VIDEO_CACHE_TTL_DAYS` 可调整；具体保护和跳过规则见 [视频缓存策略](VIDEO_EXPORT.md#服务器共享地图缓存)。首次部署会清理符合规则的旧公共缓存，需先在副本演练，保留任务素材、用户数据及回滚备份；共享缓存无需随应用回滚恢复。
