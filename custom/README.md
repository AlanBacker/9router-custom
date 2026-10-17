# 9Router Custom：完整源码定制版

本仓库包含完整[官方9Router](https://github.com/decolua/9router)源码和Git历史。`main`就是已经改好的应用源码，可以直接查看、修改并从Dockerfile构建；不是一个围绕官方应用镜像打补丁的小仓库。

## 分支与同步

- `main`：合并官方代码后的定制版，包含原生页面入口、固定会话、请求处理和恢复逻辑。
- `upstream`：上一次成功同步的未修改官方master源码。
- `archive/image-overlay`：上一轮方向不符的镜像叠加方案，仅保留历史，旧工作流已停用。

每6小时，工作流完整拉取并用Git合并官方master，再执行 `custom/scripts/apply-source.cjs` 幂等检查和补齐源码改动。合并冲突或源码结构不兼容会失败并保留原main和stable。测试通过后，编译完整Next应用、验证编译出的服务端/页面功能、测试容器启动/鉴权/重启，再发布源码构建的镜像并推送同步后的main与upstream分支。

原官方CI文件保留在 `.github/upstream-workflows/*.disabled`，避免在本仓库执行未配置的官方发布流程。本仓库启用的是 `.github/workflows/custom-source-sync.yml`。同步提交使用仓库GITHUB_TOKEN，不会递归触发自己。

## 已集成的定制

- OpenCode Free批量创建连接的页面、每连接固定且持久的匿名会话。
- DeepSeek指定low与OpenCode思考字段兼容。
- 自动公共代理、源列表更新、出口去重、后台补充和过期复检。
- 创建后自动开启代理并进入待验证队列。每条固定会话通过配置的目标模型真实推理（有实际输出并正常结束）后，才进入对应模型的业务轮询；失败自动冷却并换候选，空200和SSE错误不会通过。
- 默认验证DeepSeek和GLM两个当前模型。每条每轮最多3次、后台并发2、每分钟最多24次、单次12秒/最多64输出tokens；本轮失败后继续后台补充复测，遵守上游冷却。重启后重新验证，保留会话和代理冷却。
- 限流/代理/网关/连接故障最多换一次出口；明确会话失效只修复对应会话；鉴权/账号异常隔离线路并到期允许重试。

源码入口分别在 `src/shared/components/OpenCodeCustomizations.jsx`、`open-sse/providers/registry/opencode.js`、`open-sse/executors/opencode.js`、`open-sse/translator/concerns/thinkingUnified.js`、`src/sse/handlers/chat.js`。运行时会话/代理服务位于 `custom/server`，页面代码在 `custom/browser`，直接随Next源码编译。源码常量集中在 `open-sse/config/opencodeCustom.js`。

应用使用自己的源码构建，不以官方9Router应用镜像作为基底，也不在启动时改写.next编译文件。`custom/build-manifest.json`仅保存编译验证和文件哈希，用于发现损坏；没有运行时编译包替换。

## 构建与运行

```bash
node custom/scripts/apply-source.cjs --check
npm ci --prefix custom/server/runtime --ignore-scripts
npm run test:custom
docker build -t 9router-custom .
```

成功发布的镜像是 `ghcr.io/alanbacker/9router-custom:stable`，并保留 `sha-完整源码提交` 标签用于回退。仓库和镜像默认私有，服务器拉取需要GHCR登录。现有服务器迁移时保留原数据卷、环境和端口，使用新镜像的默认入口，移除旧 `/opt/9router-hotfix` 挂载与旧入口覆盖。已有Watchtower可以继续跟踪stable。

匿名连接不是多份真实账号额度；公共代理连通不保证免费推理可用。配置和冷却继续保存在原数据卷。CI使用隔离故障模拟，不向免费推理端点制造限流。

## 维护改动

可以直接修改main里的实际应用源码，正常Git合并会保留这些改动。`custom/scripts/apply-source.cjs`负责已有关键接入点的幂等验证，不会覆盖标记完整的源码。改变接入方式时，应同步更新它和 `custom/tests`，避免下一次同步重新添加旧接入点。测试失败时查看Actions日志，解决合并冲突或适配源码后重新运行。MIT许可保持不变。
