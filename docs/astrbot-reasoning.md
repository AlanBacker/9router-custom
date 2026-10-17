# AstrBot 的 Reasoning Effort 与 9Router

## AstrBot 预设字段

查阅版本：AstrBot 官方源码提交 `de898afe7588e1f153beec06e24f03f6ddeae2e4`。

`reasoning_effort` 是“自定义请求体参数”编辑器的预设字段，预设展示值为 `high`。在该版本中，删除字段后，输入框仍显示预设值；这不代表字段仍在保存的配置里。编辑器确认时只保存已加入的键，OpenAI 提供商把保存的 `custom_extra_body` 合并到请求。

如果要省略该参数：在该行右侧点击 ×，确认对话框，再保存提供商。重新打开时字段仍可能显示 high；右侧没有 × 时，它可能只是未加入的预设。以保存后的 `custom_extra_body` 是否实际包含 `reasoning_effort` 为准。不要仅凭输入框仍显示 high 判断请求中仍有该键。用户安装版本若不同，需要按实际保存配置确认。

例如，下面的请求体配置没有指定推理强度：

```json
{
  "custom_extra_body": {
    "max_tokens": 32000
  }
}
```

源码：

- [ObjectEditor.vue：删除、默认显示和确认逻辑](https://github.com/AstrBotDevs/AstrBot/blob/de898afe7588e1f153beec06e24f03f6ddeae2e4/dashboard/src/components/shared/ObjectEditor.vue#L451)
- [openai_source.py：合并 custom_extra_body](https://github.com/AstrBotDevs/AstrBot/blob/de898afe7588e1f153beec06e24f03f6ddeae2e4/astrbot/core/provider/sources/openai_source.py#L561)

## 9Router 上游适配

统一适配配置文件在服务器 `/home/alanbacker/9router-hotfix/thinking-compat.json`。无需给每个模型单独改代码。配置按上游主机、路径和模型家族匹配，默认只覆盖 OpenCode 的 Chat Completions 路由。

- GLM 家族发往 OpenCode 时，去掉已确认不被接受的 `thinking` 字段，保留 `reasoning_effort`。
- 模型后缀 `(low)`、`(high)` 等仍由 9Router 先解析。当前转换源码中，模型后缀优先于客户端传来的 `reasoning_effort`，因此可以覆盖 AstrBot 默认的 high。
- 若未知模型明确返回 HTTP 400/422，且错误点名一个不支持的思考控制字段，可去掉该字段后重试，最多两次。会在进程内缓存规则一小时，上限 256 条，不写入聊天数据库。
- 自动回退仅处理配置允许的顶层思考控制字段；不会删除 messages、tools、model、temperature，不会针对鉴权、限流、一般 400、非法参数值或成功响应流进行这类重试。
- 当思考控制字段被上游明确拒绝并移除时，使用上游默认行为，日志会明确提示。HTTP 200 不能单独证明上游实际采用了某个推理档位。

该适配通过启动前预加载实现，配置与脚本保存在原只读挂载目录中，沿用官方 latest 镜像与 Watchtower 更新方式。配置变更后重启 9Router 生效。
