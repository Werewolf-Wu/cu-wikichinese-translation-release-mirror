# 未知伤亡 · 维基中文网站

Astro + TypeScript 静态网站。网站内容、版本清单和下载文件均保存在本项目中，访客浏览时不需要请求 GitHub API。

调整布局、文案或添加图片前，可参考 [设计与维护约定](DESIGN.md)，了解当前单栏结构和可灵活扩展的部分。

## 本地开发

使用 Node.js 24 或更新的受支持版本：

```sh
npm ci
npm run dev
```

访问终端给出的地址，默认是 `http://127.0.0.1:4321/`。

```sh
npm run sync       # 同步上游已发布的官方翻译 JSON
npm run verify     # 检查清单、文件大小、SHA-256 和站点体积
npm test           # 同步、版本排序、持久分支和部署重试测试
npm run check      # Astro 与 TypeScript 检查
npm run build      # 生成 dist/ 静态网站
npm run preview    # 查看构建结果
```

`npm run sync` 会修改 `data/releases.json`、`data/sync-state.json` 和 `public/downloads/`。本地调用无需配置 token；可选的 `GITHUB_TOKEN` 仅发送给 GitHub API，用于提高 API 配额。不要把 token 提交到仓库。

本项目只负责读取已发布产物。翻译内容的生成、适配和审阅继续由翻译项目自己的流程负责。

## 目录

- `src/pages/`、`src/components/`：页面及组件。
- `src/styles/global.css`：电脑、平板、手机样式。
- `src/content/project.ts`：介绍、贡献者、制作组及外部链接。
- `src/lib/catalog.ts`：版本数据类型、排序和展示格式。
- `data/releases.json`：可下载版本与附件的清单。
- `data/sync-state.json`：最后成功检查时间及待完成的 tag。
- `public/downloads/`：与网站一起托管的下载文件及上游许可证。
- `scripts/`：同步、校验、数据分支持久保存和部署状态处理。
- `tests/`：离线回归测试及浏览器测试。
- `legacy/`：重构前的原站文件，保留供对照；不发布到新网站。

原站历史文件保留原始字节，并明确标注为历史归档。上游发布文件单独记录来源，不以同名或近似版本号覆盖历史文件。

## 同步规则

上游为 `dodo23333/cu-chinese-wiki-translations`。同步脚本分页读取全部 tag 和 Release，补齐尚未收录且已具备官方翻译附件的版本。附件通过文件名中的 `official` 或“基于官方翻译”标签识别，兼容早期命名。

只有 tag 或暂时没有附件的版本会留待下次重试；不会因为一次没有产物就永久跳过。预发布版本显示标记，首页推荐最高的正式版本。版本排序采用数字和预发布标识比较。站点的补丁版本号取自 tag，不从翻译 JSON 内部的 `version` 字段推导，以兼容语言文件自身的游戏版本信息。

文件下载后验证 UTF-8、JSON 结构、大小和 GitHub 提供的 SHA-256（如有），并自行记录 SHA-256。文件内容保持不变。附件替换后保存新的校验值路径；缺失或损坏的镜像会重新下载。所有待下载文件通过校验后才更新清单。

## 下载区域

默认显示最新 5 个版本，其余放在“历史版本”。历史列表超过 10 条时固定最大高度并在区域内滚动，完整保留所有版本。搜索覆盖版本号、tag、日期及更新记录；清空后恢复原来的历史展开状态。关闭 JavaScript 时仍可展开记录和下载文件。

## 未来启用 GitHub Pages

仓库和域名暂不绑定。准备上线时：

1. 将本项目推送到站点仓库的默认分支，保留 `.github/workflows/`、依赖锁文件和现有下载资源。
2. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
3. 确认仓库允许 Actions 写入内容分支；如有分支规则，允许机器人更新 `site-data`。
4. 在 Actions 中手动运行“同步翻译并部署网站”，或向默认分支提交一次变更。

工作流通过 `actions/configure-pages` 获取站点 origin 和 base path，自动适配普通项目站点、`用户名.github.io` 仓库及 Pages 自定义域名。不要在组件中硬编码用户名或仓库路径。自定义域名仍需由站点所有者在 Pages 设置和 DNS 中配置。

北京时间每天 **09:00、21:00** 各检查一次，对应 UTC cron `0 1,13 * * *`。整点执行可能因 GitHub 排队而延迟，平台也可能跳过一次计划任务；下次成功执行会补齐缺失版本。

同步数据保存到自动创建的 `site-data` 分支；它只保存 `data/` 与 `public/downloads/`。每次成功检查更新状态记录，源码分支保持独立。无需个人访问令牌、独立服务器或数据库。

网站内容或源码变化时才构建和部署。发布成功后记录版本签名；发布失败不推进成功标记，下次运行会再次尝试。失败的检查不会覆盖已上线网站。工作流不发送邮件、Webhook 或 Issue；GitHub 自带的 Actions 通知需要在个人通知设置中选择 **Don't notify**。

GitHub 对公开仓库的长期闲置计划任务有自动停用规则，若任务停用可在 Actions 页面重新启用。Pages 站点上限 1 GB；本项目在静态文件超过 700 MiB 时中止校验，以便在达到平台上限前调整归档存储。

## 浏览器验证

```sh
npx playwright install chromium
npm run build
npm run test:browser
```

测试会在 `.cache/browser-fixture/` 生成仅供测试的大版本列表，并验证 320/390/768/1440 像素布局、搜索、无脚本下载、真实下载校验、长历史滚动和仓库子路径。测试数据不进入正式清单，也不发布。可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定本机已有的 Chromium 可执行文件。

Astro CLI 遥测默认关闭。站点使用系统字体，无统计脚本。
