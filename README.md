# 9Router AutoPatch

独立维护[官方9Router](https://github.com/decolua/9router)的定制补丁与自动更新流程。官方代码和镜像继续作为上游，补丁在构建时自动应用，验证后发布本仓库的镜像。

## 自动更新

GitHub Actions每6小时检查一次，也支持Actions页手动运行。每次固定官方镜像的SHA256摘要和上游master源码提交，运行回归测试，构建linux/amd64镜像，严格验证源码、实际服务端打包代码、页面控件和应用用户依赖，再测试全新数据卷启动、管理接口鉴权与容器重启。

全部通过后才发布 `ghcr.io/alanbacker/9router-autopatch:stable`，同时保留包含本仓库提交和官方镜像摘要的版本标签，并写入 `upstream.lock.json`。上游源码提交与官方镜像摘要分别记录，不假设两者来自同一次构建。上游或补丁没有变化时不重复构建。

检查、补丁、测试或构建失败会让工作流失败，并保留上一次已经验证的stable镜像。未知代码布局会明确报错，需要维护者适配；自动流程不能保证任意未来版本都兼容。CI不会为了测试向OpenCode免费推理端点发送请求。

流程使用仓库自带的GITHUB_TOKEN，不需要额外保存GitHub或DockerHub密码。仓库默认私有，GHCR包首次发布也默认私有；服务器拉取需要具有read:packages权限的登录凭据，Watchtower也需要对应registry认证。若希望公开镜像，可在GitHub包设置中单独调整可见性。

## 包含功能

- DeepSeek明确请求low时的窄范围修复，以及OpenCode思考参数适配。
- OpenCode Free匿名连接批量创建、固定会话隔离与持久化。
- 公共HTTP(S)代理源自动更新、连通检查、出口去重、故障补充及重启优先复检。
- 限流、代理拒绝、网关或连接故障，冷却后最多切换重试一次；没有备用出口时返回错误。
- 明确会话失效时仅修复对应会话；鉴权/账号异常隔离对应线路，保留状态并到期允许复查。

这些连接是匿名会话，不代表多个独立账号或独立免费额度。代理的HTTPS连通性不代表模型推理可用。真实账号Key和其他供应商不走此匿名恢复逻辑。

## 运行

已有官方9Router部署迁移时，保留原端口、环境和数据卷，将镜像改为本仓库stable镜像，并移除之前为热修复设置的entrypoint以及 `/opt/9router-hotfix` 外部挂载，使用镜像自带的入口和补丁。外部旧目录会遮住镜像内的新补丁，不能继续挂载。请先备份原Compose文件与数据库。

`deploy/compose.yaml`是单独部署示例，默认复用已存在的 `9router-data` 卷；不是直接合并进旧Compose的覆盖文件。新安装先执行 `docker volume create 9router-data`，填写 `.env` 后：

```bash
docker login ghcr.io
docker compose --env-file .env -f deploy/compose.yaml up -d
```

已有Watchtower可继续监控stable镜像更新。只给本服务保留更新标签；本仓库不新增第二个Watchtower实例。定制镜像已经内置补丁，不再依赖服务器本地补丁文件。设置、代理冷却与匿名会话保留在原数据卷中。页面变更后Ctrl+Shift+R刷新。

目前仅发布linux/amd64镜像。CI通过不代表已经迁移任何现有服务器；服务器切换应在首次发布成功后进行。

## 开发与排错

```bash
git clone --depth 1 https://github.com/decolua/9router.git _upstream
npm ci --prefix patches/runtime --ignore-scripts
npm test
docker build --build-arg UPSTREAM_IMAGE=decolua/9router:latest -t 9router-autopatch:ci .
npm run smoke
```

依赖Undici版本及完整性记录在 `patches/runtime/package-lock.json`，由npm ci安装；构建时显式修复目录访问权限，并用应用用户验证，避免root检查掩盖权限问题。调节来源和维护频率见 `patches/opencode-public-proxy.json`，客户端思考参数见 [AstrBot说明](docs/astrbot-reasoning.md)。修改后推送即可触发重新测试和发布。

在Actions中查看失败步骤；`upstream.lock.json`只记录成功发布的版本。需要回退时，在Compose中使用上一次Actions摘要给出的 `sha-...-base-...` 标签；若要固定版本，还需暂停该容器Watchtower更新。CI不进行生产数据恢复或修改。

## 许可

MIT。保留上游许可，Undici的MIT许可随npm依赖安装保留。本仓库不包含数据库、会话文件、服务器SSH密钥、GitHub凭据或生产配置。
