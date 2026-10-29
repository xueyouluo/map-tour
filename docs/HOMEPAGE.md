# 首页：旅行杂志与居中导入

首页 `/` 使用浅纸色、深蓝宋体标题、明信片图片，导入框居中。仅在生成行程或进入 `/s/:id` 后初始化地图；首页不创建地图实例。

文字与单张截图复用 `ImportPanel` 和现有流式解析、草稿保存流程。支持切换输入方式、直接粘贴截图、选择/拖入图片、预览、移除、错误反馈与生成进度，保持 8MB 限制。没有宣称支持多图上传。

三张示例明信片填入武汉、杭州、长沙的一日路线，用户点击生成后才调用解析接口。最近行程读取真实 API 数据，不使用假日期、假成片或虚构的视频时长；历史、设置入口保持可用。纸感与排版为 CSS，动画遵从减少动态效果设置。

## 图片资产

- 页面资产：`public/images/travel-postcards.webp`，约 397KB。
- 生成方式：内置 image_gen；用途为装饰性的旅游明信片示意，不代表实际地图或导出视频画面。
- 原始图与验收截图：`outputs/homepage-20261025/`。
- 未使用带完整界面和文字的概念图作为页面截图背景。

生成提示词：

Create a website photography asset, NOT a UI mockup. A very wide horizontal 3:1 triptych composed of THREE precisely equal square photographic panels side by side, edge to edge, no gaps, no frames, no text, no labels, no watermark. Premium travel magazine photographic aesthetic, soft natural sunlight, subdued blue sky and warm cream highlights, peaceful everyday China travel mood, high detail, photographic realism. LEFT square: Wuhan East Lake, calm blue lake in foreground, traditional lakeside Chinese pavilion and leafy trees, warm morning light, no Yellow Crane Tower landmark substitution. CENTER square: Hangzhou West Lake, the graceful Leifeng Pagoda at a distance above leafy hills, calm lake and a tiny wooden boat in foreground, gentle afternoon sun. RIGHT square: Changsha city at dusk, a lively historic pedestrian street with traditional tiled shop roofs and warm small lanterns, lively atmosphere but no legible shop signs, cool blue twilight sky. Compose each square as an independent well-balanced travel postcard photo. There are no postcards physically shown, only the three rectangular photos themselves. Keep clear visual separations exactly at 1/3 and 2/3 image width. Asset will be used behind card frames built in code; absolutely no UI controls or typography.
