# 服务器运行与配置

当前生产地址为 `https://map-tour.followllm.online`。应用位于 `/opt/map-tour`，由 `map-tour.service` 运行；Express 仅监听 `127.0.0.1:8787`，由 Nginx 代理 HTTPS。Nginx 必须保留原始 Host、转发协议和来源 IP，上传上限设为 `32m`。

持久数据保留在服务器，不从开发机覆盖：

- `.env`：初始服务配置与密钥，权限 `0600`。
- `data/local-settings.json`：管理员网页保存的覆盖配置，优先于 `.env`。
- `data/map-tour.sqlite`：账号、额度、会话与行程；升级会自动添加表和字段。
- `data/video-exports/`、`data/video-cache/`：后台任务、上传音乐及地图素材。
- `assets/music/`：内置完整音乐、试听文件与 `catalog.json`，需要单独部署和保留。

解析模型使用 `deepseek-flash`，文字和截图共享配置。视频运行时使用 `/usr/bin/chromium-browser`、FFmpeg、ffprobe 和 curl；Linux 需要中文字体。素材采集使用卫星地图原生整数缩放，避免 SDK 对小数缩放取整造成影像边界错位。

首次管理员可通过 SSH 本地转发访问服务端 `/admin/setup`，用户自行输入账号密码。也可按 [账号文档](AUTH.md) 使用临时初始化令牌走公网 HTTPS。普通注册不创建管理员；管理员在 `/admin` 中管理账号、个人额度与服务设置。

部署时先锁定部署操作，在独立暂存目录安装依赖、运行测试和构建，并用生产数据库副本演练迁移。备份代码、依赖、配置、Nginx 配置和一致的 SQLite 快照，短暂停止服务后更新代码及依赖。不要将本地 `.env`、测试数据库、账号或视频任务覆盖到生产。保留旧代码、依赖和数据库备份供回滚；回滚应用一般不需要覆盖新增的线上数据。
