import { test } from 'node:test'
import assert from 'node:assert/strict'

const T = '../lib/task-queue.js'
const silentLog = { warn() {} }
const deferred = () => { let resolve, reject; const p = new Promise((res, rej) => { resolve = res; reject = rej }); return { p, resolve, reject } }
const tick = () => new Promise((r) => setImmediate(r)) // 任务启动经 setImmediate 排水（让 pending I/O 先服务）——settle→下一个 start 需两拍

test('并发=1：第二个任务排队等位，第一个 settle 后按序接棒', async () => {
  const { createTaskQueue } = await import(T)
  const q = createTaskQueue({ limit: () => 1, log: silentLog })
  const order = []
  const g1 = deferred(), g2 = deferred()
  const t1 = q.enqueue({ id: 'a', kind: 'topic', label: 'A', queuedAt: 1, start: () => { order.push('a-start'); return g1.p.then(() => order.push('a-end')) } })
  const t2 = q.enqueue({ id: 'b', kind: 'fetch', label: 'B', queuedAt: 2, start: () => { order.push('b-start'); return g2.p.then(() => order.push('b-end')) } })
  assert.equal(t1, 'started'); assert.equal(t2, 'queued')
  await tick(); assert.deepEqual(order, ['a-start'])
  assert.equal(q.isRunning('a'), true); assert.equal(q.isQueued('b'), true); assert.equal(q.waitingCount(), 1)
  g1.resolve(); await tick(); await tick() // 收尾排水→b.start 是下一个 check 阶段的事
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start'])
  g2.resolve(); await tick()
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'])
  assert.equal(q.waitingCount(), 0); assert.equal(q.isRunning('b'), false)
})

test('并发=2：两个任务并行开跑，第三个等位；同类任务互斥不占空位', async () => {
  const { createTaskQueue } = await import(T)
  const q = createTaskQueue({ limit: () => 2, log: silentLog })
  const g1 = deferred(), g2 = deferred(), g3 = deferred()
  q.enqueue({ id: 't1', kind: 'topic', label: 'T1', queuedAt: 1, start: () => g1.p })
  q.enqueue({ id: 'f1', kind: 'fetch', label: 'F1', queuedAt: 2, start: () => g2.p })
  // 同 kind 的 t2：有空位逻辑上该插，但同类互斥——等 t1 完才上
  const r3 = q.enqueue({ id: 't2', kind: 'topic', label: 'T2', queuedAt: 3, start: () => g3.p })
  assert.equal(r3, 'queued'); assert.equal(q.isRunning('t2'), false)
  g2.resolve(); await tick() // fetch 完→空出一个槽，但 t2 是 topic 与 t1 互斥→仍等
  assert.equal(q.isRunning('t2'), false); assert.equal(q.waitingCount(), 1)
  g1.resolve(); await tick() // t1 完→t2 接棒
  assert.equal(q.isRunning('t2'), true); await tick()
  g3.resolve(); await tick()
  assert.equal(q.waitingCount(), 0)
})

test('同 id 重复入队返回 dup（定时抓取撞手动抓取合并）', async () => {
  const { createTaskQueue } = await import(T)
  const q = createTaskQueue({ limit: () => 1, log: silentLog })
  const g = deferred()
  assert.equal(q.enqueue({ id: 'fetch', kind: 'fetch', label: 'F', queuedAt: 1, start: () => g.p }), 'started')
  assert.equal(q.enqueue({ id: 'fetch', kind: 'fetch', label: 'F', queuedAt: 2, start: () => Promise.resolve() }), 'dup')
  assert.equal(q.waitingCount(), 0); assert.equal(q.has('fetch'), true)
  g.resolve(); await tick()
})

test('waiting 态取消：撤队+onCancelQueued+settle 兑现，不占槽', async () => {
  const { createTaskQueue } = await import(T)
  const q = createTaskQueue({ limit: () => 1, log: silentLog })
  const g1 = deferred()
  const sideFx = []
  const settled = deferred()
  q.enqueue({ id: 'a', kind: 'topic', label: 'A', queuedAt: 1, start: () => g1.p })
  q.enqueue({ id: 'b', kind: 'topic', label: 'B', queuedAt: 2, start: () => Promise.resolve('should-not-run'), onCancelQueued: () => sideFx.push('b-cancelled'), settle: { resolve: (v) => settled.resolve(v), reject: () => {} } })
  assert.equal(q.cancel('b'), 'waiting')
  assert.deepEqual(sideFx, ['b-cancelled'])
  assert.deepEqual(await settled.p, { cancelled: 'waiting' })
  assert.equal(q.waitingCount(), 0); assert.equal(q.has('b'), false)
  g1.resolve(); await tick() // 队列空了，a 正常收尾不复活 b
})

test('running 态取消：调 cancel 钩子，任务本体仍在跑到 settle', async () => {
  const { createTaskQueue } = await import(T)
  const q = createTaskQueue({ limit: () => 1, log: silentLog })
  const g = deferred()
  let aborted = false
  q.enqueue({ id: 'a', kind: 'fetch', label: 'A', queuedAt: 1, start: () => g.p, cancel: () => { aborted = true } })
  q.enqueue({ id: 'b', kind: 'digest', label: 'B', queuedAt: 2, start: () => Promise.resolve('b-done') })
  await tick() // 先让 a 发射（间隙中取消按 waiting 口径——running 取消要在 start() 之后）
  assert.equal(q.cancel('a'), 'running'); assert.equal(aborted, true)
  assert.equal(q.isRunning('a'), true) // abort 是请求——任务收尾才释放槽位
  g.resolve(); await tick() // a 收尾→b 接棒
  await tick()
  assert.equal(q.isRunning('b'), false) // b 已跑完
})

test('start 抛错：任务失败不堵队列，下一个照样接棒', async () => {
  const { createTaskQueue } = await import(T)
  const warns = []
  const q = createTaskQueue({ limit: () => 1, log: { warn: (s) => warns.push(s) } })
  let bRan = false
  q.enqueue({ id: 'a', kind: 'topic', label: 'A', queuedAt: 1, start: () => Promise.reject(new Error('boom')) })
  q.enqueue({ id: 'b', kind: 'fetch', label: 'B', queuedAt: 2, start: () => { bRan = true; return Promise.resolve() } })
  await tick(); await tick()
  assert.equal(bRan, true)
  assert.equal(warns.length, 1); assert.match(warns[0], /boom/)
  assert.equal(q.waitingCount(), 0); assert.equal(q.isRunning('a'), false)
})

test('启动间隙取消：任务已占 running 位但 start() 未发——按 waiting 口径撤，不发 start', async () => {
  const { createTaskQueue } = await import(T)
  const q = createTaskQueue({ limit: () => 1, log: silentLog })
  const sideFx = []
  const settled = deferred()
  let started = false
  q.enqueue({ id: 'a', kind: 'fetch', label: 'A', queuedAt: 1,
    start: () => { started = true; return Promise.resolve() },
    onCancelQueued: () => sideFx.push('a-cancelled'),
    settle: { resolve: (v) => settled.resolve(v), reject: () => {} } })
  // 任务已进 running 表（占槽+同类互斥生效）但 start() 要等 setImmediate——此刻取消
  assert.equal(q.isRunning('a'), true)
  assert.equal(q.cancel('a'), 'waiting')
  assert.deepEqual(sideFx, ['a-cancelled'])
  assert.deepEqual(await settled.p, { cancelled: 'waiting' })
  for (let i = 0; i < 3; i++) await tick()
  assert.equal(started, false); assert.equal(q.isRunning('a'), false)
})

test('启动间隙 removeQueued：发射台跳过且不调 onCancelQueued（meta 由删除方处理）', async () => {
  const { createTaskQueue } = await import(T)
  const q = createTaskQueue({ limit: () => 1, log: silentLog })
  const sideFx = []
  let started = false
  q.enqueue({ id: 'topic:x', kind: 'topic', label: 'X', queuedAt: 1,
    start: () => { started = true; return Promise.resolve() },
    onCancelQueued: () => sideFx.push('x') })
  assert.equal(q.removeQueued('topic:x'), true)
  assert.deepEqual(sideFx, [])
  for (let i = 0; i < 3; i++) await tick()
  assert.equal(started, false); assert.equal(q.isRunning('topic:x'), false)
})

test('启动间隙撤下后槽位正常释放，等待任务按序接棒', async () => {
  const { createTaskQueue } = await import(T)
  const q = createTaskQueue({ limit: () => 1, log: silentLog })
  const g = deferred()
  const ran = []
  q.enqueue({ id: 'a', kind: 'fetch', label: 'A', queuedAt: 1, start: () => g.p })
  q.enqueue({ id: 'b', kind: 'digest', label: 'B', queuedAt: 2, start: () => { ran.push('b'); return Promise.resolve() } })
  q.enqueue({ id: 'c', kind: 'topic', label: 'C', queuedAt: 3, start: () => { ran.push('c'); return Promise.resolve() } })
  q.cancel('a') // 间隙取消——a 永不发射；b/c 依次接棒跑完
  for (let i = 0; i < 8; i++) await tick()
  assert.deepEqual(ran, ['b', 'c'])
  assert.equal(q.waitingCount(), 0); assert.equal(q.runningList().length, 0)
})

test('removeQueued 只摘不调副作用；waitingIds/runningList 快照', async () => {
  const { createTaskQueue } = await import(T)
  const q = createTaskQueue({ limit: () => 1, log: silentLog })
  const g = deferred()
  const sideFx = []
  q.enqueue({ id: 'topic:x1', kind: 'topic', label: 'X1', queuedAt: 1, start: () => g.p })
  q.enqueue({ id: 'topic:x2', kind: 'topic', label: 'X2', queuedAt: 2, start: () => Promise.resolve(), onCancelQueued: () => sideFx.push('x2') })
  q.enqueue({ id: 'digest', kind: 'digest', label: 'D', queuedAt: 3, start: () => Promise.resolve() })
  assert.deepEqual(q.waitingIds('topic'), ['topic:x2'])
  assert.deepEqual(q.waitingIds(), ['topic:x2', 'digest'])
  assert.equal(q.removeQueued('topic:x2'), true); assert.deepEqual(sideFx, [])
  assert.equal(q.removeQueued('topic:x2'), false)
  assert.deepEqual(q.runningList().map((t) => t.id), ['topic:x1'])
  g.resolve(); await tick()
})
