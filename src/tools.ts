/** ctx.tools 注册：news_* 前缀防撞名。值即契约 + render 投影。 */
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { FeedSource, FetchCycleResult } from './core/types.js'

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]
const err = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 插件对外操作的统一门面（index.ts 注入，避免 tools.ts 直接绑 store） */
export interface NewsService {
  listSources(): FeedSource[]
  addSource(opts: { url: string; title?: string; category?: string }): Promise<FeedSource>
  setEnabled(urlOrId: string, enabled: boolean): Promise<void>
  removeSource(urlOrId: string): Promise<boolean>
  importOpml(opmlText: string): Promise<{ added: number; duplicated: number; skipped: number; details?: Array<{ url: string; action: string; reason?: string }> }>
  exportOpml(): Promise<string>
  runFetch(): Promise<FetchCycleResult>
  status(): { sources: number; enabled: number; items: number; lastFetchAt: string; lastDigestDay: string; failures: Array<{ name: string; error: string }> }
  tune(text: string): Promise<{ ok: boolean; actions: string[]; error?: string }>
}

const sourceSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    url: { type: 'string' },
    title: { type: 'string' },
    category: { type: 'string' },
    enabled: { type: 'boolean' },
    builtin: { type: 'boolean' },
  },
  additionalProperties: false,
} as const

const pick = (s: FeedSource) => ({ id: s.id, url: s.url, title: s.title, category: s.category, enabled: s.enabled, builtin: s.builtin })

// ---------------------------------------------------------------- tools

function newsSources(svc: NewsService) {
  return defineTool({
    name: 'news_sources',
    description: 'List effective RSS sources (builtin catalog ∪ user sources), with enabled state and last error if any.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, count: { type: 'integer' }, sources: { type: 'array', items: sourceSchema } },
        additionalProperties: false,
      },
      render: (_a, v) => {
        const list = (v.sources || []) as Array<{ title?: string; enabled?: boolean; category?: string }>
        return text(`Sources (${v.count}):\n` + list.map((s) => `- [${s.enabled ? 'on' : 'off'}] ${s.title} (${s.category})`).join('\n'))
      },
    },
    execute: async () => ({ ok: true, count: svc.listSources().length, sources: svc.listSources().map(pick) }),
  })
}

function newsAdd(svc: NewsService) {
  return defineTool({
    name: 'news_add',
    description: 'Subscribe to an RSS/Atom feed URL. The feed is fetched and validated before saving; invalid feeds are rejected.',
    parameters: {
      url: { type: 'string', required: true, description: 'Feed URL (public http/https)' },
      title: { type: 'string', description: 'Optional label' },
      category: { type: 'string', description: 'Optional category' },
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, error: { type: 'string' }, source: sourceSchema },
        additionalProperties: false,
      },
      render: (_a, v) => v.ok
        ? text(`Subscribed: ${v.source?.title} (${v.source?.url})`)
        : text(`Add failed: ${v.error}`),
    },
    execute: async (args: { url: string; title?: string; category?: string }) => {
      try {
        return { ok: true, source: pick(await svc.addSource(args)) }
      } catch (e) {
        return { ok: false, error: err(e) }
      }
    },
  })
}

function newsRemove(svc: NewsService) {
  return defineTool({
    name: 'news_remove',
    description: 'Remove a source by id/url (builtin sources are disabled via override, not deleted).',
    parameters: {
      url: { type: 'string', required: true, description: 'Source id or feed URL' },
      disable_only: { type: 'boolean', description: 'true = 仅停用（推荐用于内置源）' },
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, error: { type: 'string' } }, additionalProperties: false },
      render: (_a, v) => text(v.ok ? 'Done.' : `Remove failed: ${v.error}`),
    },
    execute: async (args: { url: string; disable_only?: boolean }) => {
      try {
        if (args.disable_only) await svc.setEnabled(args.url, false)
        else if (!await svc.removeSource(args.url)) return { ok: false, error: 'not found (内置源请用 disable_only)' }
        return { ok: true }
      } catch (e) {
        return { ok: false, error: err(e) }
      }
    },
  })
}

function newsFetch(svc: NewsService) {
  return defineTool({
    name: 'news_fetch',
    description: 'Run a fetch cycle over all effective sources now. Returns per-source stats.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, added: { type: 'integer' }, fetched: { type: 'integer' }, errors: { type: 'integer' } },
        additionalProperties: false,
      },
      render: (_a, v) => text(`Fetch done: +${v.added} items / ${v.fetched} fetched / ${v.errors} errors`),
    },
    execute: async () => {
      const r = await svc.runFetch()
      return { ok: true, added: r.totalAdded, fetched: r.totalFetched, errors: r.errors }
    },
  })
}

function newsStatus(svc: NewsService) {
  return defineTool({
    name: 'news_status',
    description: 'Report fetch/digest status: source/item counts, last run times, failing sources.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' }, sources: { type: 'integer' }, enabled: { type: 'integer' },
          items: { type: 'integer' }, lastFetchAt: { type: 'string' }, lastDigestDay: { type: 'string' },
          failures: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, error: { type: 'string' } }, additionalProperties: false },
          },
        },
        additionalProperties: false,
      },
      render: (_a, v) => text(
        `Status: ${v.enabled}/${v.sources} sources on, ${v.items} items\n` +
        `lastFetch=${v.lastFetchAt || 'never'} lastDigestDay=${v.lastDigestDay || 'never'}\n` +
        ((v.failures?.length ? 'Failing:\n' + v.failures.map((f) => `- ${f.name}: ${f.error}`).join('\n') : 'All sources healthy')),
      ),
    },
    execute: async () => ({ ok: true, ...svc.status() }),
  })
}

function newsImport(svc: NewsService) {
  return defineTool({
    name: 'news_import',
    description: 'Import OPML subscription text. Dedups against builtin catalog and existing sources; returns added/duplicated/skipped counts. Sources are not fetched during import — health is handled by the fetch cycle.',
    parameters: {
      opml: { type: 'string', required: true, description: 'OPML 2.0 document text' },
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, error: { type: 'string' }, added: { type: 'integer' }, duplicated: { type: 'integer' }, skipped: { type: 'integer' } },
        additionalProperties: false,
      },
      render: (_a, v) => v.ok
        ? text(`Imported: +${v.added} added, ${v.duplicated} duplicated, ${v.skipped} skipped`)
        : text(`Import failed: ${v.error}`),
    },
    execute: async (args: { opml: string }) => {
      try {
        return { ok: true, ...(await svc.importOpml(args.opml)) }
      } catch (e) {
        return { ok: false, error: err(e) }
      }
    },
  })
}

function newsExport(svc: NewsService) {
  return defineTool({
    name: 'news_export',
    description: 'Export enabled sources as OPML 2.0 text (grouped by category).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, error: { type: 'string' }, opml: { type: 'string' } },
        additionalProperties: false,
      },
      render: (_a, v) => text(v.ok ? (v.opml ?? '') : `Export failed: ${v.error}`),
    },
    execute: async () => {
      try {
        return { ok: true, opml: await svc.exportOpml() }
      } catch (e) {
        return { ok: false, error: err(e) }
      }
    },
  })
}

function newsTune(svc: NewsService) {
  return defineTool({
    name: 'news_tune',
    description: 'Tune RSS recommendation preferences via natural language, e.g. "多推 AI、少推币圈、屏蔽裁员" or "重置". Applies immediately to the next digest.',
    parameters: {
      text: { type: 'string', required: true, description: 'Tuning instruction in natural language' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
          actions: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      render: (_a, v) => text(v.ok ? `Tuning applied: ${(v.actions ?? []).join('; ')}` : `Tune failed: ${v.error}`),
    },
    execute: async (args) => svc.tune(String(args.text ?? '')),
  })
}

/** 注册全部 news_* 工具；返回 disposer。 */
export function registerTools(ctx: Context, svc: NewsService): () => void {
  const ds = [
    ctx.tools.register(newsSources(svc)),
    ctx.tools.register(newsAdd(svc)),
    ctx.tools.register(newsRemove(svc)),
    ctx.tools.register(newsFetch(svc)),
    ctx.tools.register(newsStatus(svc)),
    ctx.tools.register(newsImport(svc)),
    ctx.tools.register(newsExport(svc)),
    ctx.tools.register(newsTune(svc)),
  ]
  return () => ds.forEach((d) => d())
}
