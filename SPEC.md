# 手机酒馆离线 HTML 导出

目标：在 SillyTavern 的扩展菜单中导出当前完整聊天为一个含图片的离线 HTML，适配 st-chatu8，不需要手机额外安装运行库。

已由用户选择页面内导出并授权开发。默认现代 Android 浏览器、当前选中的消息分支；不把其他 swipe、密钥、世界书或插件配置写入结果。

验收：
- 从完整 chat 数组读取，包括未滚动加载的消息；不修改源聊天、不触发生图、不写插件数据库。
- 渲染 Markdown 和安全的静态 HTML，人物名、消息顺序、日期、插图位置正确；支持可访问 iframe 的静态内容，移除脚本和交互控件。
- 读取 st-chatu8 当前仓库的 extra.images[swipe_id]、chatMetadata['st-chatu8'].data.image_groups、自定义提示词标记、jiuguanStorage 与 chatu8_gallery/tupianhuancun 缓存；严格匹配当前选图索引。
- 只读取本次聊天引用的媒体；图片内嵌为 data URI，重复资源复用；支持酒馆原生图片附件。
- 缺图和无法定位的插图有可见说明；不静默选择其他历史图片替代；外部图片默认不请求，可由用户启用。
- 输出没有可执行脚本或在线依赖，断网仍可阅读、搜索和复制；提供亮/暗随系统配色与手机排版。
- 提供进度、取消、完成后手动下载链接，适应手机长任务与下载限制。

结构：index.js（酒馆入口）、model.js（快照与选图）、chatu8.js（只读缓存）、render.js（排版与插图）、assets.js（媒体内嵌）、document.js（离线文档）、style.css、manifest.json、tests/、README.md。

命令：npm test（Node 单元测试）；npm run test:browser（Edge/Chromium 浏览器集成测试）；npm run check（语法检查）。运行时复用酒馆的 DOMPurify 和 messageFormatting，无新增服务。

实现次序：先验证选图/标记与完整快照，再完成只读图片解析，再实现渲染与离线内嵌，最后菜单、安装包、手机排版和断网测试。

安全边界：聊天/模型 HTML 不可信，先净化再使用；图片请求仅限同源 images/user/images 或 blob/data，外链需明确选择且不附加酒馆凭据，禁止调用 API 类 URL；导出仅包含可见消息字段和媒体，不保存全量设置。取消/切换聊天会停止任务。

已知边界：静态归档不会运行角色卡脚本；跨域 iframe、浏览器已清除缓存的图片不可恢复；超大单文件受手机内存限制，需要在进度处说明体积。
