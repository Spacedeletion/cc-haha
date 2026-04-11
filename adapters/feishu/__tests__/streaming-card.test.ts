/**
 * StreamingCard 生命周期测试
 *
 * 用 mock Lark client 覆盖:
 * - ensureCreated: 成功路径 / 降级路径
 * - appendText: 累积 + 触发 throttled flush
 * - finalize: settings(false) + update 顺序、sequence 单调递增
 * - abort: 渲染错误卡片
 * - 230020 → 跳帧
 * - 230099 table limit → 禁用流式，finalize 时仍走 CardKit
 * - 纯 patch fallback 路径
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  StreamingCard,
  buildInitialStreamingCard,
  buildRenderedCard,
  buildErrorCard,
} from '../streaming-card.js'
import { STREAMING_ELEMENT_ID } from '../cardkit.js'

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

type ApiCall = { api: string; args: any }

type MockBehavior = {
  'card.create'?: any | ((args: any) => any)
  'card.settings'?: any | ((args: any) => any)
  'card.update'?: any | ((args: any) => any)
  'cardElement.content'?: any | ((args: any, callIdx: number) => any)
  'im.message.create'?: any | ((args: any) => any)
  'im.message.reply'?: any | ((args: any) => any)
  'im.message.patch'?: any | ((args: any, callIdx: number) => any)
}

function makeMockClient(behavior: MockBehavior = {}) {
  const calls: ApiCall[] = []
  let contentCallIdx = 0
  let patchCallIdx = 0

  function handle(api: string, resp: any, args: any, idx?: number): any {
    calls.push({ api, args })
    if (typeof resp === 'function') return resp(args, idx ?? 0)
    return resp
  }

  const client: any = {
    cardkit: {
      v1: {
        card: {
          create: async (args: any) =>
            handle('cardkit.v1.card.create', behavior['card.create'] ?? {
              code: 0, data: { card_id: 'ck_default' },
            }, args),
          settings: async (args: any) =>
            handle('cardkit.v1.card.settings', behavior['card.settings'] ?? { code: 0 }, args),
          update: async (args: any) =>
            handle('cardkit.v1.card.update', behavior['card.update'] ?? { code: 0 }, args),
        },
        cardElement: {
          content: async (args: any) => {
            const idx = contentCallIdx++
            return handle('cardkit.v1.cardElement.content',
              behavior['cardElement.content'] ?? { code: 0 }, args, idx)
          },
        },
      },
    },
    im: {
      message: {
        create: async (args: any) =>
          handle('im.message.create', behavior['im.message.create'] ?? {
            data: { message_id: 'om_default' },
          }, args),
        reply: async (args: any) =>
          handle('im.message.reply', behavior['im.message.reply'] ?? {
            data: { message_id: 'om_reply_default' },
          }, args),
        patch: async (args: any) => {
          const idx = patchCallIdx++
          return handle('im.message.patch', behavior['im.message.patch'] ?? { code: 0 }, args, idx)
        },
      },
    },
  }
  return { client, calls }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Card JSON builders
// ---------------------------------------------------------------------------

describe('buildInitialStreamingCard', () => {
  it('Schema 2.0 + streaming_mode + element_id', () => {
    const card = buildInitialStreamingCard() as any
    expect(card.schema).toBe('2.0')
    expect(card.config.streaming_mode).toBe(true)
    // 第二个元素是空的 streaming_content 目标（loading 在首位以避免顶部空 padding）
    const streaming = card.body.elements[1]
    expect(streaming.tag).toBe('markdown')
    expect(streaming.content).toBe('')
    expect(streaming.element_id).toBe(STREAMING_ELEMENT_ID)
  })

  it('loading 提示元素在首位（避免空 streaming_content 挤出顶部 padding）', () => {
    const card = buildInitialStreamingCard() as any
    const elements = card.body.elements as any[]
    expect(elements.length).toBe(2)
    const loading = elements[0]
    expect(loading.tag).toBe('markdown')
    expect(loading.content).toContain('正在思考中')
    expect(loading.text_size).toBe('notation')
    // loading 元素不能有 element_id（那是给 streaming_content 独占的）
    expect(loading.element_id).toBeUndefined()
  })
})

describe('buildRenderedCard', () => {
  it('Schema 2.0, 无 streaming_mode, 单 markdown 元素', () => {
    const card = buildRenderedCard('hello world') as any
    expect(card.schema).toBe('2.0')
    expect(card.config.streaming_mode).toBeUndefined()
    expect(card.body.elements.length).toBe(1)
    const el = card.body.elements[0]
    expect(el.tag).toBe('markdown')
    expect(el.content).toBe('hello world')
    // 最终卡无需 element_id
    expect(el.element_id).toBeUndefined()
  })

  it('空字符串保底为单空格', () => {
    const card = buildRenderedCard('') as any
    expect(card.body.elements[0].content).toBe(' ')
  })
})

describe('buildErrorCard', () => {
  it('红色 header + markdown body', () => {
    const card = buildErrorCard('oops') as any
    expect((card.header as any).template).toBe('red')
    expect((card.header as any).title.content).toContain('出错')
    expect(card.body.elements[0].content).toBe('oops')
  })
})

// ---------------------------------------------------------------------------
// StreamingCard lifecycle
// ---------------------------------------------------------------------------

describe('StreamingCard: ensureCreated (CardKit 主路径)', () => {
  it('依次调用 card.create + im.message.create，sequence=1', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_main_1' } },
      'im.message.create': { data: { message_id: 'om_main_1' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'oc_chat_1' })
    await sc.ensureCreated()

    expect(sc._getPhase()).toBe('streaming')
    expect(sc._getCardId()).toBe('ck_main_1')
    expect(sc._getMessageId()).toBe('om_main_1')
    expect(sc._getSequence()).toBe(1)
    expect(sc._isCardKitStreamActive()).toBe(true)

    expect(calls[0]!.api).toBe('cardkit.v1.card.create')
    expect(calls[1]!.api).toBe('im.message.create')

    // 初始卡 JSON 包含 streaming_mode 和 element_id
    const cardJson = JSON.parse(calls[0]!.args.data.data)
    expect(cardJson.schema).toBe('2.0')
    expect(cardJson.config.streaming_mode).toBe(true)
    // loading 元素在首位，streaming_content 占位在第二
    expect(cardJson.body.elements[1].element_id).toBe(STREAMING_ELEMENT_ID)

    // IM message 引用 card_id
    const content = JSON.parse(calls[1]!.args.data.content)
    expect(content).toEqual({ type: 'card', data: { card_id: 'ck_main_1' } })
  })

  it('幂等: 重复调用 ensureCreated 不重复创建', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_1' } },
      'im.message.create': { data: { message_id: 'om_1' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    await sc.ensureCreated()
    await sc.ensureCreated()
    // 只一次 create + 一次 send
    const createCalls = calls.filter((c) => c.api === 'cardkit.v1.card.create')
    const sendCalls = calls.filter((c) => c.api === 'im.message.create')
    expect(createCalls.length).toBe(1)
    expect(sendCalls.length).toBe(1)
  })

  it('replyToMessageId 走 im.message.reply 而非 create', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.reply': { data: { message_id: 'om_reply' } },
    })
    const sc = new StreamingCard({
      larkClient: client,
      chatId: 'c',
      replyToMessageId: 'om_parent',
    })
    await sc.ensureCreated()
    expect(calls.some((c) => c.api === 'im.message.reply')).toBe(true)
    expect(calls.some((c) => c.api === 'im.message.create')).toBe(false)
    expect(sc._getMessageId()).toBe('om_reply')
  })
})

describe('StreamingCard: ensureCreated (fallback 降级路径)', () => {
  it('CardKit create 失败 → 直发 Schema 2.0 卡 + patch 模式', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 99991672, msg: 'permission denied' },
      'im.message.create': { data: { message_id: 'om_fb' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()

    expect(sc._getPhase()).toBe('streaming')
    expect(sc._getCardId()).toBeNull()
    expect(sc._getMessageId()).toBe('om_fb')
    expect(sc._isCardKitStreamActive()).toBe(false)

    // fallback 发送的是 Schema 2.0 interactive 卡
    const createCall = calls.find((c) => c.api === 'im.message.create')
    expect(createCall).toBeDefined()
    expect(createCall!.args.data.msg_type).toBe('interactive')
    const cardContent = JSON.parse(createCall!.args.data.content)
    expect(cardContent.schema).toBe('2.0')
  })

  it('CardKit send 失败（create 成功但 im.message.create 失败）也能降级', async () => {
    let sendCallCount = 0
    const { client } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.create': () => {
        sendCallCount++
        if (sendCallCount === 1) throw new Error('send failed')
        return { data: { message_id: 'om_fb2' } }
      },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    expect(sc._getPhase()).toBe('streaming')
    expect(sc._getCardId()).toBeNull()
    expect(sc._getMessageId()).toBe('om_fb2')
  })

  it('降级发送也失败 → aborted + throw', async () => {
    const { client } = makeMockClient({
      'card.create': { code: 99991672 },
      'im.message.create': () => {
        throw new Error('really broken')
      },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await expect(sc.ensureCreated()).rejects.toThrow()
    expect(sc._getPhase()).toBe('aborted')
  })
})

// ---------------------------------------------------------------------------
// appendText + flush
// ---------------------------------------------------------------------------

describe('StreamingCard: appendText + flush', () => {
  it('accumulated 文本写入 cardElement.content，sequence 单调递增', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_stream' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()

    // 第一次 appendText 进入节流窗口（刚 ready，lastUpdateTime 还新）
    sc.appendText('Hello ')
    sc.appendText('world')

    // 节流窗口 100ms + 余量
    await sleep(150)

    const contentCalls = calls.filter((c) => c.api === 'cardkit.v1.cardElement.content')
    expect(contentCalls.length).toBeGreaterThan(0)
    // 最后一次 flush 的内容应包含完整累积文本
    const lastCall = contentCalls[contentCalls.length - 1]!
    expect(lastCall.args.data.content).toContain('Hello world')
    expect(lastCall.args.path.element_id).toBe(STREAMING_ELEMENT_ID)
    // sequence 严格单调递增
    const seqs = contentCalls.map((c) => c.args.data.sequence)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!)
    }
  })

  it('内容未变化时不重复 flush（基于 lastFlushedText 对比）', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()

    sc.appendText('same')
    await sleep(150)

    // 强制再跑一次 flush（无新文本）
    await sc._getFlushController().flush()

    const contentCalls = calls.filter((c) => c.api === 'cardkit.v1.cardElement.content')
    // 应该只有一次 content 调用
    expect(contentCalls.length).toBe(1)
  })

  it('completed 之后的 appendText 被忽略', async () => {
    const { client } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    await sc.finalize()
    sc.appendText('ignored')
    expect(sc._getAccumulatedText()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

describe('StreamingCard: finalize', () => {
  it('CardKit 路径: settings(false) + card.update，sequence 连续递增', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_final' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    sc.appendText('# Title\n\nBody')
    await sleep(150)
    const contentSeqs = calls
      .filter((c) => c.api === 'cardkit.v1.cardElement.content')
      .map((c) => c.args.data.sequence)
    const lastContentSeq = contentSeqs[contentSeqs.length - 1] ?? 1

    await sc.finalize()

    expect(sc._getPhase()).toBe('completed')

    const settingsCalls = calls.filter((c) => c.api === 'cardkit.v1.card.settings')
    const updateCalls = calls.filter((c) => c.api === 'cardkit.v1.card.update')
    expect(settingsCalls.length).toBe(1)
    expect(updateCalls.length).toBe(1)

    const settingsSeq = settingsCalls[0]!.args.data.sequence
    const updateSeq = updateCalls[0]!.args.data.sequence
    expect(settingsSeq).toBeGreaterThan(lastContentSeq)
    expect(updateSeq).toBeGreaterThan(settingsSeq)

    // settings 关闭 streaming_mode
    const settings = JSON.parse(settingsCalls[0]!.args.data.settings)
    expect(settings.streaming_mode).toBe(false)

    // update 卡内容是预处理后的 markdown
    const finalCardJson = JSON.parse(updateCalls[0]!.args.data.card.data)
    const finalContent = finalCardJson.body.elements[0].content
    // H1 被降级为 H4
    expect(finalContent).toContain('#### Title')
    expect(finalContent).toContain('Body')
  })

  it('Fallback 路径: im.message.patch 发完整渲染卡', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 99991672 },
      'im.message.create': { data: { message_id: 'om_fb' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    sc.appendText('## Heading\n\nContent')
    await sleep(1600) // 等 PATCH_MS 窗口
    await sc.finalize()

    const patchCalls = calls.filter((c) => c.api === 'im.message.patch')
    expect(patchCalls.length).toBeGreaterThan(0)
    // 最后一次 patch 是 finalize 的（full final card）
    const lastPatch = patchCalls[patchCalls.length - 1]!
    const finalCard = JSON.parse(lastPatch.args.data.content)
    const finalContent = finalCard.body.elements[0].content
    // ## → ##### 降级
    expect(finalContent).toContain('##### Heading')
  })

  it('完全 idle 时 finalize 直接标记 completed 不抛错', async () => {
    const { client } = makeMockClient()
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.finalize()
    expect(sc._getPhase()).toBe('completed')
  })

  it('finalize 失败不抛出', async () => {
    const { client } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.create': { data: { message_id: 'om' } },
      'card.settings': () => {
        throw new Error('settings exploded')
      },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    sc.appendText('text')
    await sleep(150)
    // finalize 内部捕获错误不 rethrow
    await sc.finalize()
    expect(sc._getPhase()).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// Rate limit + table limit
// ---------------------------------------------------------------------------

describe('StreamingCard: 错误处理', () => {
  it('230020 rate limit → 跳帧，后续 flush 继续', async () => {
    let callIdx = 0
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.create': { data: { message_id: 'om' } },
      'cardElement.content': () => {
        const i = callIdx++
        if (i === 0) {
          const err: any = new Error('rate limit')
          err.code = 230020
          throw err
        }
        return { code: 0 }
      },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    sc.appendText('first')
    await sleep(150)
    // 第一次被限流
    sc.appendText(' second')
    await sleep(150)
    // 第二次应能成功

    // CardKit 仍然 active（没降级）
    expect(sc._isCardKitStreamActive()).toBe(true)
    const contentCalls = calls.filter((c) => c.api === 'cardkit.v1.cardElement.content')
    expect(contentCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('230099 table limit → 禁用流式但 cardId 保留，finalize 仍走 CardKit', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_tbl' } },
      'im.message.create': { data: { message_id: 'om' } },
      'cardElement.content': () => {
        const err: any = new Error('content failed')
        err.code = 230099
        err.msg = 'Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit; '
        throw err
      },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    sc.appendText('some content')
    await sleep(150)
    expect(sc._isCardKitStreamActive()).toBe(false)
    expect(sc._getCardId()).toBe('ck_tbl') // card_id 保留

    await sc.finalize()
    // finalize 仍然走 CardKit 的 settings + update（cardId 还在）
    expect(calls.some((c) => c.api === 'cardkit.v1.card.settings')).toBe(true)
    expect(calls.some((c) => c.api === 'cardkit.v1.card.update')).toBe(true)
    // 不走 patch
    expect(calls.some((c) => c.api === 'im.message.patch')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// abort
// ---------------------------------------------------------------------------

describe('StreamingCard: abort', () => {
  it('CardKit 路径: 渲染错误卡并关闭流式', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_err' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    sc.appendText('partial...')
    await sleep(150)

    await sc.abort(new Error('something went wrong'))
    expect(sc._getPhase()).toBe('aborted')

    const updateCalls = calls.filter((c) => c.api === 'cardkit.v1.card.update')
    expect(updateCalls.length).toBeGreaterThan(0)
    const errCard = JSON.parse(updateCalls[updateCalls.length - 1]!.args.data.card.data)
    expect(errCard.header.template).toBe('red')
    expect(errCard.body.elements[0].content).toContain('something went wrong')
    // 保留已累积的部分文本
    expect(errCard.body.elements[0].content).toContain('partial...')
  })

  it('idle 阶段 abort 不抛错', async () => {
    const { client } = makeMockClient()
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.abort(new Error('before any card'))
    expect(sc._getPhase()).toBe('aborted')
  })
})
