# 伴随插件开发（Companion Plugins）

`dsh-rss-news-daily` 通过 **`rndSources` 服务**对外开放源扩展点：独立的 cordis 插件包可以注册自定义抓取方式（method handler）并注入源定义，主插件继续负责调度、解析归一、跨源去重、健康度冷却、存储与日报/快报编排——伴随插件只「给数据」。

## 快速开始

```ts
// your-plugin/src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import type { MethodHandler, SourceDef } from 'dsh-rss-news-daily'

export const name = 'my-source-pack'          // 与 cordis.patch.yml 的 id 一致
export const inject = ['rndSources']          // 静态依赖：服务未就位不执行

const handler: MethodHandler = async (src, ctx) => {
  const doc = await ctx.fetch('https://api.example.com/feed.json', ctx.signal, {
    accept: 'application/json',
    headers: { Referer: 'https://example.com/' },
  })
  if ('error' in doc) throw new Error(doc.error)
  const rows = JSON.parse(doc.body).items
  return rows.map((r) => ({ id: `my_${r.id}`, title: r.t, link: r.u, content: r.c, publishedAt: r.ts }))
}

export function apply(ctx: Context) {
  if (ctx.rndSources.apiVersion < 1) return   // 契约检查放首行
  ctx.rndSources.registerMethod('my-source-pack:json-feed', handler)  // 命名约定 '<包名>:<方法>'
  ctx.rndSources.addSources(name, [{
    url: 'https://example.com/feed-page',      // 展示用源主页（真实端点写在 handler 里）
    title: 'Example Flash',
    method: 'my-source-pack:json-feed',
    category: '快讯', tier: 2, lang: 'zh', summarize: false, enabled: true,
  }])
}
```

```yaml
# cordis.patch.yml —— id 与 export const name 一致
- insert:
    - id: my-source-pack
      name: 'my-source-pack'
      config: {}
```

## API 面（apiVersion 1，进 semver）

`ctx.inject(['rndSources'])` 或 `export const inject = ['rndSources']` 后：

| 成员 | 签名 | 说明 |
|---|---|---|
| `apiVersion` | `number` | 当前 `1`。首行检查，版本不符优雅退出 |
| `registerMethod` | `(name, handler) => void` | 注册抓取 handler；约定 `'<包名>:<方法>'` 命名空间；**重名抛错** |
| `addSources` | `(provider, defs) => void` | 注入源定义；`provider` 传自己的 `export const name`——卸载后遗留源可识别/清理 |
| `registerBriefType` | `(provider, def) => void` | 注册快报类型（如「快讯快报」）；同 id 时用户已存配置优先 |
| `registerView` | `(provider, view) => void` | 给阅读器顶栏贡献 iframe tab；页自己挂 `webServer` 路由 |

### MethodHandler

```ts
type MethodHandler = (src: FeedSource, ctx: MethodCtx) => Promise<RawItem[]>

interface MethodCtx {
  fetch(url, signal?, init?): Promise<FetchedDocument | FetchFailure> // 主插件策略 fetcher：
  //   SSRF 防护/超时/大小限制/代理/重试全继承；init 可传 { proxy, headers, accept }
  log: LogSink
  signal?: AbortSignal
  kv: { get(k): string | undefined; set(k, v): void }  // 私有状态持久化（游标/令牌缓存）
}

interface RawItem {
  id?: string        // 建议带源前缀（my_…）防跨源撞 guid；缺省回退 link/title
  title: string
  link?: string
  summary?: string
  content?: string
  publishedAt?: string  // ISO；isStaleItem 依赖——快讯源务必给真实发布时间
}
```

### SourceDef

```ts
interface SourceDef {
  url: string                  // 源主页/展示 URL（源 id 由它归一化派生；查重键）
  title: string
  method?: string              // 'direct'（缺省）= RSS/Atom 常规抓取；否则走注册 handler
  category?: string            // 分类（列表/快报分组依据）
  tier?: 1 | 2 | 3             // 质量权重：1 最高
  lang?: 'zh' | 'en'
  enabled?: boolean            // 缺省 true
  summarize?: boolean          // 缺省 true；快讯类建议 false（单条即完整信息，省 token）
  stream?: boolean             // 缺省 false；true=纯流源：正常入库/展示，但不进 LLM 评分、
                               //   翻译、正文补抓、日报与 wildcard 快报——只能被快报类型
                               //   经 sourceIds 显式点名（见 registerBriefType）
  proxy?: string | boolean     // 'url'=指定代理；true=走全局代理
  cooldownHours?: number       // 连续失败时的源级冷却（覆盖默认 24h）
}
```

### BriefTypeDef / ViewDef

```ts
interface BriefTypeDef {
  id: string                   // 唯一；用户在同 id 上已存的配置优先（启停/改名/改频率生效）
  name: string
  enabled?: boolean            // 缺省 true
  schedule: { kind: 'minutes'; everyMinutes: number }
          | { kind: 'hourly'; minute: number }
          | { kind: 'daily'; time: string }   // 'HH:mm'
  sourceIds?: string[]         // 显式点名源 id——stream 源只能这样进快报
  keywords?: string[]
  minScore?: number            // 入选分阈值；stream 源未评分条目按 0 计，要收就传 0
  maxItems?: number
  focus?: string               // 给 LLM 的写作侧重提示
}

interface ViewDef {
  id: string                   // tab id（前缀 view- 加在 DOM 上）
  title: string                // 顶栏显示名
  url: string                  // 本插件 webServer 挂载路径，如 '/dsh-news-kuaixun/'
}
```

视图页由伴随插件经 `ctx.inject(['webServer'], ...)` 自挂路由提供，主阅读器 iframe 载入。
主题同步：首帧 URL 带 `?theme=light|dark`，运行时经 `postMessage({type:'rnd-theme', theme})` 跟随。

## 行为契约

- **生效时机**：源落 store 用户源层，`effectiveSources` 每轮重算——`apply` 期注册的下个抓取周期即生效，无需重启
- **失败语义**：handler 抛错或 method 未注册 → `unknown method`/fetch 错误走既有健康度：连续 3 次失败进 24h 冷却；不炸其他源
- **重复防御**：`addSources` 按规范化 URL 查重跳过；`registerMethod` 重名抛错
- **provider 卸载**：提供方插件被移除后，其源 method 查不到 → 自动降级冷却；源列表可按 `provider` 识别清理
- **`ctx.kv`**：落 `store.meta.methodState[srcId]`，跨重启持久（JSON/SQLite 后端一致），持久化随后续 `store.save()`

## 可选服务：browserFetch

[`dsh-rss-news-browser-fetch`](../dsh-rss-news-browser-fetch) 提供「专用 Chrome + CDP 页面内 fetch」传输——过 TLS 指纹/WAF、需要登录态的源可用。它是**可选依赖**：

```ts
ctx.inject(['browserFetch'], (c) => {
  const bf = c.browserFetch                    // BrowserFetchService
  bf.declareDomains(name, ['example.com', 'api.example.com'])  // 声明式域白名单
  // bf.fetch('api.example.com', url, { headers }) → { status, body }
  // bf.authRequired(domain) / bf.openForAuth(domain) / bf.markAuthRequired(domain)
})
```

缺席时回调不执行——adapter 应设计为 node fetch 优先、browser 回落。注意：`browserFetch` 只允许 JSON-safe 的 init（method/headers/body/credentials），域名单是各包声明的**并集**。

## 不暴露什么

`store`、LLM client、调度器内部——刻意不公开。伴随插件只「给数据」，编排归主插件；这是 API 稳定性的前提。

## 调试

- 日志：主插件输出 `rndSources: <provider> registered N source(s)`；源级错误进源健康度 `lastError`（面板可见）
- 本地安装：把包构建后复制进 `~/.dsh/profiles/<profile>/node_modules/`，并在该 profile `package.json` 登记 `dependencies` 与 `dsh.profile.bundles`——参考本仓 `scripts/install-to-profile.mjs`
- 测试：主插件 `test/methods.test.mjs` 展示了用 `registerMethod('test:noop')` + `runFetchCycle` 跑通全管线的最小样例

## 兼容承诺

`rndSources` 进 semver：新增成员/可选字段升 minor，签名变更或删除升 major。`apiVersion` 是伴随插件唯一需要的判断位。
