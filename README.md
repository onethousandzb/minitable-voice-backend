# Minitable Voice Backend(中间层)

语音 AI(ElevenLabs)和 Minitable SAAS API 之间的中间层。把 AI 侧的简单请求(store_id、"7:00 PM"、party_size)翻译成 Minitable 真实 API 格式,处理查位、预约、改约、取消、等位、call-ahead。

已连正式环境验证:真电话、真预约、真短信。

---

## 部署(给开发)

这是一个纯 Node.js 服务(无框架依赖),单文件 `real-backend.js`,监听一个端口提供若干 POST 接口。

**要求:**

1. **从这个 GitHub 仓库部署到云服务器**,区域尽量靠近 Minitable 后端以降低延迟。
2. **配置为自动部署**:仓库有新提交(push)时自动重新部署 —— 这样代码维护方 push 后无需人工介入即可更新。多数平台(Railway / Render / Fly.io,或 AWS + GitHub Actions)原生支持连接 GitHub 仓库自动部署。
3. **固定 https 域名**:给一个稳定的对外网址(如 `https://voice-api.minitable.com`),替代临时隧道,地址不随重启变化。
4. **常驻运行**:崩溃自动重启、开机自启(平台通常自带,或用 pm2 / systemd)。
5. **环境变量**:在平台的环境变量设置里配置凭证(见下),**不要**写进代码。
6. **Node.js** ≥ 18。

**环境变量**(参考 `.env.example`):

| 变量 | 值 | 必填 |
|---|---|---|
| `MINITABLE_API_BASE` | `https://ai.minitable.net`(正式) | 是 |
| `MINITABLE_USER` | Minitable 账号 | 是 |
| `MINITABLE_PASS` | Minitable 密码 | 是 |
| `PORT` | 监听端口(默认 3000) | 否 |

缺少必填变量时,服务会在启动时报错退出并打印缺哪个,不会用空值静默连接。

**验证部署:**

```bash
# 健康检查
curl https://<固定域名>/health
# 期望返回 service: minitable-real-backend、api_base: ai.minitable.net

# 查位
curl -X POST https://<固定域名>/check-availability \
  -H "Content-Type: application/json" \
  -d '{"store_id":"<merchant_id>","date":"08/10/2026","time":"7:00 PM","party_size":2}'
```

部署好后,把固定网址给到语音 AI 侧(用于 ElevenLabs 工具 URL)。

---

## 更新流程(代码维护方)

代码由这边维护。改动后:

```bash
git add .
git commit -m "描述改动"
git push
```

push 到 GitHub 后,云端自动部署会拉取并更新(前提:开发已按上面第 2 点配好自动部署)。**日常改中间层逻辑,push 即可,无需开发再操作。**

> 若某次改动涉及新的环境变量,需要在部署平台补配该变量 —— 这种情况才需要知会开发一次。

---

## 本地运行(可选,自测用)

```bash
cp .env.example .env      # 填入真实值(.env 不会进仓库)
# 用支持 .env 的方式加载,或直接 export 环境变量后:
node real-backend.js
```

---

## 安全

- 凭证只存在环境变量 / 部署平台,**绝不提交到仓库**。`.env` 已在 `.gitignore` 中排除。
- 提交前确认代码里没有明文账号、密码、token。
