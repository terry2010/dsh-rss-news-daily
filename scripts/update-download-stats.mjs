#!/usr/bin/env node
// 拉取 npm 每日下载量，累计存入 docs/stats/downloads-<year>.json，
// 并渲染 docs/downloads-<year>.md（年度文档，含 Mermaid 图表）。
//
// npm 下载统计有 1~3 天结算延迟，近期天数可能暂时返回 0。
// 因此采用 max(旧值, 新值) 合并：已记录的非零值不会被延迟的 0 覆盖，
// 最近 PENDING_DAYS 天在文档中标记为"待结算"，每天重拉直到结算。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const YEAR = new Date().toISOString().slice(0, 4);
const PENDING_DAYS = 5;
const API = `https://api.npmjs.org/downloads/range/${YEAR}-01-01:${today()}/${pkg.name}`;
const DATA_PATH = join(ROOT, 'docs', 'stats', `downloads-${YEAR}.json`);
const DOC_PATH = join(ROOT, 'docs', `downloads-${YEAR}.md`);

function today() {
  return new Date().toISOString().slice(0, 10);
}

function ageDays(day) {
  return Math.round((Date.parse(today()) - Date.parse(day)) / 86400000);
}

async function fetchJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (i < retries - 1) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    else throw new Error(`npm API ${res.status}: ${url}`);
  }
}

async function loadData() {
  try {
    return JSON.parse(await readFile(DATA_PATH, 'utf8'));
  } catch {
    return { package: pkg.name, year: Number(YEAR), days: {} };
  }
}

function render(data) {
  const entries = Object.entries(data.days).sort(([a], [b]) => a.localeCompare(b));
  const settled = entries.filter(([d]) => ageDays(d) >= PENDING_DAYS);
  const last30 = entries.slice(-30);
  const last7settled = settled.slice(-7);
  const sum = list => list.reduce((s, [, v]) => s + v, 0);
  const best = settled.length ? settled.reduce((a, b) => (b[1] > a[1] ? b : a)) : null;

  const months = {};
  for (const [d, v] of entries) {
    const m = d.slice(0, 7);
    months[m] = (months[m] || 0) + v;
  }
  const monthEntries = Object.entries(months);
  const monthMax = Math.max(1, ...monthEntries.map(([, v]) => v));
  const dayMax = Math.max(1, ...last30.map(([, v]) => v));

  const bar = list => `[${list.map(([, v]) => v).join(', ')}]`;
  const labels = list => `[${list.map(([d]) => `"${d.slice(5)}"`).join(', ')}]`;

  const rows = [...entries].reverse()
    .map(([d, v]) => `| ${d} | ${v} | ${ageDays(d) < PENDING_DAYS ? '待结算 *' : ''} |`)
    .join('\n');

  return `<!-- 本文件由 scripts/update-download-stats.mjs 自动生成，请勿手改 -->
# ${pkg.name} npm 下载量统计 — ${YEAR}

> 数据源：api.npmjs.org。npm 下载统计有约 1–3 天结算延迟，
> 最近 ${PENDING_DAYS} 天标记为"待结算"，数值会在 npm 结算后自动修正。

## 概览

| 指标 | 下载量 |
| --- | ---: |
| 最近已结算日（${settled.at(-1)?.[0] ?? '—'}） | ${settled.at(-1)?.[1] ?? '—'} |
| 近 7 天（已结算） | ${sum(last7settled)} |
| 近 30 天（含待结算） | ${sum(last30)} |
| 本年度累计 | ${sum(entries)} |
| 最高单日 | ${best ? `${best[1]}（${best[0]}）` : '—'} |

## 近 30 天每日下载量

\`\`\`mermaid
xychart-beta
    title "daily downloads (last 30 days)"
    x-axis ${labels(last30)}
    y-axis "downloads" 0 --> ${dayMax}
    bar ${bar(last30)}
\`\`\`

## 每月下载量

\`\`\`mermaid
xychart-beta
    title "monthly downloads"
    x-axis [${monthEntries.map(([m]) => `"${m}"`).join(', ')}]
    y-axis "downloads" 0 --> ${monthMax}
    bar ${bar(monthEntries)}
\`\`\`

## 每日明细

| 日期 | 下载量 | 备注 |
| --- | ---: | --- |
${rows}

\\* 待结算：npm 尚未结算该日数据，当前值可能为 0 或偏低，结算完成后自动更新。
`;
}

const api = await fetchJson(API);
const data = await loadData();
for (const { day, downloads } of api.downloads) {
  data.days[day] = Math.max(data.days[day] ?? 0, downloads);
}

// 去掉首个有下载量日期之前的全零记录（包发布前的年份天数无意义）
const firstActive = Object.keys(data.days).sort().find(d => data.days[d] > 0);
if (firstActive) {
  for (const d of Object.keys(data.days)) if (d < firstActive) delete data.days[d];
}

data.updated = new Date().toISOString();

await mkdir(dirname(DATA_PATH), { recursive: true });
await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
await writeFile(DOC_PATH, render(data));
console.log(`updated ${DOC_PATH}: ${Object.keys(data.days).length} days, latest = ${api.downloads.at(-1)?.day}`);
