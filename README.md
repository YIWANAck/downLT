# SillyTavern 离线聊天 HTML 导出 · 1.0.0

在酒馆页面导出当前聊天为一个 `.html` 文件。文字可搜索、复制；能读取到的插图直接存进网页，关闭 Termux、断网、或把文件发到另一台设备都可以阅读。

## 手机安装（Termux）

1. 把 `st-html-export.zip` 下载到手机的 **Download / 下载**，保留 ZIP 文件名。
2. 第一次让 Termux 访问下载目录时，运行 `termux-setup-storage`，在 Android 弹窗中允许访问文件。若运行 `unzip` 时提示命令不存在，先运行 `pkg install unzip`。
3. 在 Termux 执行以下命令。若你的酒馆安装位置不同，将第一行的路径换成实际位置。可以逐行执行：

   ```sh
   cd "$HOME/SillyTavern"
   mkdir -p data/default-user/extensions
   unzip -n "$HOME/storage/downloads/st-html-export.zip" -d data/default-user/extensions
   ```

   如果你改过 `config.yaml` 的 `dataRoot`，或酒馆用了其他账户，把 `data/default-user/extensions` 换成实际的 **数据目录/账户名/extensions**。解压后应有 `extensions/st-html-export/manifest.json`，不要套两层文件夹。`-n` 会跳过同名文件；首次安装可以直接用。扩展使用酒馆已有的前端组件，手机上不需要运行 `npm install`。

4. 在手机浏览器刷新酒馆。如果扩展列表仍没出现，按你的原方式重启酒馆再刷新。扩展列表中应出现 **离线聊天 HTML 导出**；如显示停用，启用即可。

## 导出与打开

1. **用平时看得到 st-chatu8 图片的同一个浏览器、同一个酒馆网址**打开聊天。`localhost` 和 `127.0.0.1`、不同端口或无痕窗口可能看不到同一份浏览器图片缓存。
2. 点输入框旁的 **魔杖／扩展菜单 → 导出聊天为 HTML**。也可从扩展设置里打开同名入口。
3. 点 **生成 HTML**，等进度完成，再点 **下载 HTML**。默认只读取酒馆本地图片；如确实需要尝试保存消息里的外链图片，可勾选相应选项，图片网站需要允许浏览器读取。
4. 从下载目录用浏览器打开保存的 `.html`。若文件管理器默认把它当文本预览，使用 **打开方式 → 浏览器**。建议第一次先拿一段有几张图的聊天试用，关闭酒馆后再打开 HTML 检查。

## 导出范围

- 读取当前聊天完整的消息列表，不用滚动加载旧消息。每条保存当前选中的回复版本；不会打包备用回复、世界书、API 密钥或插件配置。
- 支持常用 Markdown 与静态 HTML、酒馆原生图片，以及 st-chatu8 的服务器图片与浏览器 IndexedDB 缓存。优先保留已渲染图片的位置；历史消息按保存的插图标记或段落定位恢复，定位不确定时放到该条消息末尾并注明。
- 不重新生成图片。如果源图片已删除、存放在另一个浏览器中、或无法访问，导出文件会保留文字和缺图标记。生成界面和归档页首均显示缺图数量。
- 归档页面不会执行角色卡脚本。当前页面中可读取的嵌入内容会保留静态排版；复杂交互、跨域嵌入和酒馆主题样式不会复刻。
- 单个媒体最大 24 MiB，内嵌媒体合计最大 96 MiB（按内嵌后大小计算），避免超大聊天使手机浏览器内存不足。达到限制会标记未能保存的媒体。外链图片不保证可下载。HTML 用于阅读，若还想重新导入酒馆，请另外保留原始 JSONL。

## 兼容性与验证

按照 [SillyTavern 1.19.0 release 分支](https://github.com/SillyTavern/SillyTavern/tree/release) 的扩展接口及 [st-chatu8 3.2.1](https://github.com/damoshen123/st-chatu8) 的缓存结构实现。使用现代 Chromium 浏览器在手机尺寸下验证了完整聊天、两种图片存储、已显示的 blob 图片、插图位置、取消导出、下载和断网打开。测试使用模拟聊天，尚未连接你的手机；旧版或改版扩展的存储方式可能不同。

卸载时，停用此扩展并移走 `extensions/st-html-export` 文件夹即可。扩展不改动聊天记录或生图缓存。
