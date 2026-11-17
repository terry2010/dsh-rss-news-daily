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

## API 面（apiVersion 3，进 semver）

`ctx.inject(['rndSources'])` 或 `export const inject = ['rndSources']` 后：

| 成员 | 签名 | 说明 |
|---|---|---|
| `apiVersion` | `number` | 当前 `3`。首行检查，版本不符优雅退出；`≥2` 起 `registerBriefType` 支持 `opts.items` 供给器；`≥3` 起 `registerBriefPool`/`BriefType.poolId` |
| `registerMethod` | `(name, handler) => void` | 注册抓取 handler；约定 `'<包名>:<方法>'` 命名空间；**重名抛错** |
| `addSources` | `(provider, defs) => void` | 注入源定义；`provider` 传自己的 `export const name`——卸载后遗留源可识别/清理 |
| `registerBriefType` | `(provider, def, opts?) => void` | 注册快报类型（如「快讯快报」）；同 id 时用户已存配置优先。`opts.items`（v2）= 条目供给器——糖：以 def.id/name/sourceNames 自动建同名池并挂接 |
| `registerBriefPool` | `(provider, pool, supplier) => void` | v3。注册快报条目池（`{id,name,sourceNames}` + `(since)=>FeedItem[]`）；任意快报类型经 `poolId` 挂接，用户 UI 新增快报也能选到本池 |
| `registerView` | `(provider, view) => void` | 给阅读器顶栏贡献 iframe tab；页自己挂 `webServer` 路由 |
| `notify` | `(title, body, path?) => void` | 桌面通知（与时段快报同一通道，受 `notifyDesktop` 偏好门控）；`path` 为阅读器内路径，点击通知打开对应页面 |
| `removeSources` | `(provider) => Promise<number>` | 删除自己注入过的源及其全部条目（幂等）；伴随插件转向独立存储时调用清理主库 |

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
  sourceIds?: string[]         // 显式点名源 id——stream 源只能这样进快报；
                               //   供给器类型此处是「允许名单」：空表时供给器条目会被 stream 剔除
  keywords?: string[]
  minScore?: number            // 入选分阈值；stream 源未评分条目按 0 计，要收就传 0
  maxItems?: number
  focus?: string               // 给 LLM 的写作侧重提示（追加在概括指令前）
  sourceNames?: Record<string, string>  // 供给器条目的来源显示名（源不在主库源表时节内标注用；registerBriefType+items 时并入同名池）
  prompt?: string              // 整段替换概括指令（≤500字；保留「不要解释」外壳）——快讯等异构条目换骨架
  itemTime?: boolean           // 渲染行加逐条 HH:mm（按 config.timezone）——时序类条目用
  poolId?: string              // v3。条目池 id（registerBriefPool 注册）；空=主库候选池。
                               //   挂池类型 sourceIds 空=全池（不做 stream 剔除），非空=池内允许名单
}

interface ViewDef {
  id: string                   // tab id（前缀 view- 加在 DOM 上）
  title: string                // 顶栏显示名
  url: string                  // 本插件 webServer 挂载路径，如 '/dsh-news-kuaixun/'
}
```

视图页由伴随插件经 `ctx.inject(['webServer'], ...)` 自挂路由提供，主阅读器 iframe 载入。
主题同步：首帧 URL 带 `?theme=light|dark`，运行时经 `postMessage({type:'rnd-theme', theme})` 跟随。

### 条目池 / 供给器（apiVersion ≥ 2；池复用 ≥3）

自管存储的伴随插件（如 dsh-news-kuaixun：高频轮询 + 独立 SQLite，条目不进主库）想复用快报产线时，
给 `registerBriefType` 第三参挂供给器（糖：自动建同名池）：

```ts
ctx.rndSources.registerBriefType(name, {
  id: 'kx-flash', name: '快讯快报',
  schedule: { kind: 'hourly', minute: 0 },
  sourceNames: { '<源id>': '显示名' },  // 节内来源标注（v3 起并入同名池，同池多类型共享）
  minScore: 6, maxItems: 40, itemTime: true,
  prompt: '概括本时段快讯：…',          // 可整段换掉「总起+分点」模板
}, {
  items: async (since) => /* 返回 FeedItem[]——since 是窗口起点 ISO（上次出报时刻或今日零时） */,
})
```

一池多类型（v3）：池可被任意类型 `poolId` 挂接——用户也能在「快报列表→新增快报→条目池」
下拉里选到你的池自建快报（改频率/阈值/关键字互不影响）：

```ts
ctx.rndSources.registerBriefPool(name, {
  id: 'kx-flash', name: '快讯快报', sourceNames: { '<源id>': '显示名' },
}, supplier)
// 之后任意 BriefType { poolId: 'kx-flash' } 的条目都由 supplier 供
```

语义契约：

- **时机**：供给器在挂池类型槽位到期时由主插件任务队列调用（高峰期同享 holdInPeak 挂起），
  `since` = `briefWindowStart`（上次台账或今日零时）——窗口/台账语义与主库类型完全一致
- **条目形状**：返回 `FeedItem[]`（已导出类型）。主库才有的字段（`hash`/`digestedDay`）填空即可；
  `state.hidden`/`dupOf` 参与入选过滤，`topic` 决定分节
- **自评分**：供给器条目不经过主库评分管线——把重要性写进 `llmScore`（及 `llmReason` 显示理由），
  否则按 `heuristicScores` 兜底可能恒为 0
- **去重自管**：跨条合并由供给器决定——非代表条挂 `dupOf: rep.id` 即被快报剔除
- **sourceIds**：挂池类型空=全池（v3 起不再被 stream 剔除）；非空=池内允许名单
- **失败**：供给器抛错 → warn + 本轮跳过且**不盖台账**，下一槽位用同一窗口重试；
  池缺失（插件卸载）→ warn + 盖台账跳过，不写文件
- **隔离**：池条目不落主库、不进「时段快报」通配候选池；渲染出的 `## HH:mm <name>` 节
  照常进「今日快报·全部」合并视图

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
