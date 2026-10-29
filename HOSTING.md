# 托管、域名与交接

源码仓库：[Werewolf-Wu/cu-wikichinese-translation-release-mirror](https://github.com/Werewolf-Wu/cu-wikichinese-translation-release-mirror)。当前使用 GitHub Pages，发布任务见 [Actions](https://github.com/Werewolf-Wu/cu-wikichinese-translation-release-mirror/actions/workflows/pages.yml)。页面设计的修改约定见 [DESIGN.md](DESIGN.md)。

## 当前构建方式

- Node.js 24，依赖通过 `npm ci` 安装。
- `main` 保存页面、配置和同步代码；`site-data` 保存版本清单、下载文件和同步/发布状态。
- [发布工作流](.github/workflows/pages.yml) 在默认分支更新、手动触发或北京时间每天 09:00、21:00 时执行。
- 发布任务恢复持久数据、检查上游、校验文件、运行测试，再构建静态目录 `dist/`。无须常驻 Node.js 服务。
- Pages 来源为 **GitHub Actions**。工作流使用仓库自带的 `GITHUB_TOKEN`，不需要添加个人令牌。
- 若设置分支保护，保留工作流写入 `site-data` 的权限。定时任务排队可能延迟，缺失版本会在下次成功执行补齐。

确认最近一次任务成功后，可在仓库 **Settings → Pages** 查看当前站点地址。默认项目站点会继承账号主页的自定义域名；当前账号使用 `www.hao-ming.top`，因此新项目最初会位于该域名的仓库子路径。HTTPS 目前由域名前面的 Cloudflare 提供，GitHub API 的 `https_enforced` 值不代表访客连接是否已使用 HTTPS；不要为此修改其他仓库的域名设置。构建使用 Pages 返回的 host 与 base path，并为站点 origin 使用 HTTPS。

当前继承域名的 HTML 响应包含 `Cache-Control: max-age=28800`，Cloudflare 会命中缓存，访客可能在 8 小时内仍看到旧首页。绑定独立子域名时，建议为该主机或本项目 HTML 路径单独设置较短的浏览器缓存，并让 CDN 对 HTML 尊重源站缓存或绕过缓存。带内容校验值路径的下载文件和构建资源可以继续长期缓存。已有缓存的更新可能需要在 Cloudflare 清理对应路径；只重新运行 GitHub 部署不会自动清理这层缓存。

`site-data` 的成功发布记录保存在 `data/published.json` 中，不要把它当成页面配置手工修改。

## 绑定自有子域名

这里只记录操作步骤，实际域名由站点所有者决定。

1. 在 GitHub 账号的 Pages 设置中按提示验证所拥有的域名，并保留验证记录。
2. 在本仓库 **Settings → Pages → Custom domain** 保存要使用的完整子域名，例如 `wiki.example.com`。
3. 到域名 DNS 管理处，为该子域名设置 CNAME，目标为 `Werewolf-Wu.github.io`。CNAME 目标不能包含协议、斜杠或仓库路径；清除同一名称上冲突的记录。
4. 等待 Pages 的 DNS 检查及证书签发完成，然后启用 **Enforce HTTPS**。
5. 手动运行一次“同步翻译并部署网站”。工作流会读取新的 origin 和 base path，将构建从项目子路径切换到域名根路径。
6. 在新域名检查首页、样式、图标、搜索和实际下载，确认 HTTPS 正常。

无需提前在源码里写入尚未确定的域名。自定义 Actions 部署以 Pages 设置为准；不要仅添加 `CNAME` 文件就认为已经完成绑定。

## 更换托管服务

页面是静态产物，支持普通静态站点服务或 Web 服务器。更换托管时，保留以下几部分：

- 完整 Git 仓库及 `main`、`site-data` 两个分支。
- [版本清单](data/releases.json)、`public/downloads/` 内的全部文件和上游许可证。
- 上游同步、下载校验和每天两次检查的执行方式。
- 自有域名的 DNS 管理权限，以及新托管平台自己的 HTTPS 配置。

如果仍在现有 GitHub 仓库中执行同步，可在工作流中把最终部署步骤接到新平台，继续使用已有的数据恢复与校验逻辑。不能只让新平台监听 `main` 构建：自动同步数据在 `site-data` 分支，更新可能不会触发对 `main` 的构建。

如果将构建和同步也交给新平台，构建流程应包含以下步骤，并提供有权读取数据分支的仓库来源：

```sh
npm ci
npx tsx scripts/data-store.ts restore
npm run sync
npm run verify
npm test
npm run check
SITE_URL=https://wiki.example.com BASE_PATH=/ npm run build
```

`SITE_URL` 替换为实际 origin，`BASE_PATH` 使用实际部署路径；根路径是 `/`。新平台需要定时运行同步、保存更新后的版本数据，并在确认部署成功后更新发布状态。当前 [成功状态脚本](scripts/deployment-state.ts) 与 [数据分支脚本](scripts/data-store.ts) 可继续使用，但外部部署的成功条件和凭据应由新平台对接，不能照搬 Pages 的输出值。

先在新平台的临时地址验证所有版本下载的文件大小和 SHA-256、静态资源路径、手机布局及历史搜索。验证后切换 DNS，再停止旧平台的重复部署。切换完成后检查一次定时同步是否确实能更新新站点。

## 交接给其他维护者

优先通过 GitHub 的仓库协作者权限、组织权限或正式仓库转移交接，不共享个人登录凭据。若转移仓库到其他账号，Pages 的默认域名和 CNAME 目标也会变化，需要更新本说明及 DNS。

交接前核对最新源码提交、最近成功发布任务、`site-data` 状态、域名及证书状态。让接手者完成一次手动同步与部署，并验证一个真实下载。文字、布局和图片的维护继续参考 [DESIGN.md](DESIGN.md)，无需重建页面骨架。
