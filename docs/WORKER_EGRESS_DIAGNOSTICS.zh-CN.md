# 临时 Worker 出口诊断

`GET /__diagnostics/egress` 默认关闭；不改变 `/v1/*` 的转发逻辑。
仅向 [ipify 的固定 IPv4 HTTPS 接口](https://www.ipify.org/) `https://api.ipify.org` 发一次 GET。
无模型请求，不使用 OpenAI key 或额度；不接受自定义 URL、不跟随重定向。
出站请求从零创建，只设置 Accept 和 Cache-Control，不复制入站凭证、Cookie、客户端 IP 或正文。
Cloudflare 平台仍可能添加自身网络头；本接口不能证明 OpenAI 请求的最终头或出口。

## 手动开启与调用

在你审查并自行部署代码后，于 Cloudflare 控制台选择 **ujs-ai-gateway → Settings → Variables and Secrets**：

- 添加文本变量 `EGRESS_DIAGNOSTICS_ENABLED`，值严格为 `true`。
- 添加独立的 **Secret** `EGRESS_DIAGNOSTICS_SECRET`，使用密码管理器生成的 32–256 字符高熵字母数字密钥。不要复用 OpenAI key，不要提交到 Git、写进 URL 或聊天。
- 按控制台流程使绑定生效。仅临时开启；使用完立即关闭。

以下 Bash 调用交互式读取密钥，不把密钥放进 shell 历史、curl 参数或环境变量。先关闭 shell tracing；不要使用 curl `-v`、trace 或将请求记录到日志：

```bash
set +x
read -r -s -p 'Diagnostic secret: ' diagnostic_secret
printf '\n'
printf 'Authorization: Bearer %s\n' "$diagnostic_secret" |
  curl --silent --show-error --fail-with-body --max-time 10 \
    --header @- https://aigateway.ujser.com/__diagnostics/egress
unset diagnostic_secret
```

成功 JSON 包含 `ip`、固定 `target` 和局限说明 `scope`。
关闭、缺少配置、错误凭证均返回相同 404；验证后仅允许无 query 的 GET。
上游失败、重定向、非法或超过 64 字节的响应返回精简 502；整个请求（含读正文）超过 3 秒返回 504，并取消出站请求。不重试。
所有诊断响应 `Cache-Control: no-store`，不开放 CORS；代码不日志记录或持久化诊断结果、密钥、请求头或个人内容。Cloudflare 自身的调用日志仍受平台可观测性配置控制。

## 结果局限

这是 **ipify 看到的 Worker 到该目标的 IPv4 连接来源**，不保证 OpenAI 使用相同 IP、地址族或路由；一次结果也不保证后续请求相同。
不能据此判断或绕过服务商地区限制，不能单独解释 OpenAI 的 403。
开启并调用会让 ipify 看到该连接的出口 IP；本变更的测试仅使用本地 mock，没有向 ipify 发送用户请求。

## 关闭与移除

先删除开启变量或改为 `false`，并确认配置已生效；暂时保留诊断 secret。使用此前已验证有效的凭证，按上面的安全 curl 示例再次调用，确认返回 404、不再返回诊断信息，然后删除诊断 secret。必要时在控制台核对当前生效版本的变量配置。

无凭证请求在开启和关闭状态都会返回 404，因此不能作为开关已关闭的证据。
彻底移除可回退本 PR 并按正常审查流程自行部署。无数据库、持久数据或资源绑定需要清理。

## 本地验证

Rust >=1.94.1，worker-build 0.8.5，Node >=22：

```bash
cargo fmt --all -- --check
worker-build --release
bash scripts/worker_egress_test.sh
```

测试加载真实编译后的 Wasm，在 Miniflare/workerd 中拦截**全部**出站请求；不登录 Cloudflare，不部署，不连接 ipify 或模型服务。覆盖关闭/鉴权、固定目标、敏感头隔离、上游失败/重定向/超限/非法响应、响应头及正文超时、原健康检查。
