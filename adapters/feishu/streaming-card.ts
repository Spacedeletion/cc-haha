/**
 * 单个 chat 的流式卡片生命周期状态机
 *
 * 负责把 LLM 的流式文本增量渲染成一张随着内容生长的飞书 CardKit 卡片。
 * 封装了：
 * - CardKit API 的 5 步调用（create → send → stream × N → settings → update）
 * - 节流 + 并发保护（FlushController）
 * - Markdown 预处理（optimizeMarkdownForFeishu + sanitizeTextForCard）
 * - 错误降级：CardKit 挂了自动切到 im.message.patch + Schema 2.0 卡
 * - 速率限制：230020 跳帧，下次重试；230099 表格超限禁用 CardKit 流式
 *
 * 每个 chatId 一个实例，由 index.ts 的 handleServerMessage 协调 lifecycle。
 */

import type * as Lark from '@larksuiteoapi/node-sdk'
import { FlushController, THROTTLE } from './flush-controller.js'
import {
  createCardEntity,
  sendCardAsMessage,
  streamCardContent,
  setCardStreamingMode,
  updateCardKitCard,
  STREAMING_ELEMENT_ID,
} from './cardkit.js'
import { isCardRateLimitError, isCardTableLimitError } from './card-errors.js'
import { optimizeMarkdownForFeishu, sanitizeTextForCard } from './markdown-style.js'

// ---------------------------------------------------------------------------
// Card JSON builders
// ---------------------------------------------------------------------------

/** 初始流式卡片：Schema 2.0 + streaming_mode + element_id。
 *
 *  包含两个 markdown 元素：
 *  - 独立的 loading 提示: "☁️ 正在思考中..." 小号灰字。放在**首位**紧贴
 *    卡片顶部 —— 否则空的 streaming_content 会占默认行高把 loading 挤到
 *    卡片中间，视觉上像大片 padding。
 *  - `streaming_content`: 流式内容目标元素，初始为空。由 cardElement.content()
 *    逐步填充。位于 loading 下方。
 *
 *  finalize 时整卡 update 替换，loading 元素自然消失。
 *
 *  openclaw-lark 用的是 `custom_icon` + 私有 img_key 做 loading 动画，
 *  我们没有那个 img_key，用 emoji + notation 文字达到相似的"仍在处理"提示。 */
export function buildInitialStreamingCard(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      update_multi: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '☁️ *正在思考中...*',
          text_size: 'notation',
        },
        {
          tag: 'markdown',
          content: '',
          text_align: 'left',
          element_id: STREAMING_ELEMENT_ID,
        },
      ],
    },
  }
}

/** 已渲染完成的卡片：Schema 2.0，无 streaming_mode，单 markdown 元素。
 *
 *  代码块的 "10 行代码 >" 手机端 bug 是通过 `optimizeMarkdownForFeishu` 把
 *  fenced code 降级成纯文字来规避的，不依赖多元素结构。这里就是最朴素的
 *  一张纯 markdown 卡片。 */
export function buildRenderedCard(renderedMarkdown: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: renderedMarkdown || ' ',
          text_align: 'left',
        },
      ],
    },
  }
}

/** 错误卡片：红色 header + 错误文本。用于 abort() 兜底。 */
export function buildErrorCard(message: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: '❌ 出错了' },
      template: 'red',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: message || '未知错误',
        },
      ],
    },
  }
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type StreamingCardPhase =
  | 'idle' // constructor 后、ensureCreated 之前
  | 'creating' // ensureCreated 进行中
  | 'streaming' // 初始卡已发出，接受 appendText
  | 'finalizing' // finalize 进行中
  | 'completed' // finalize 完成
  | 'aborted' // abort 已调用

export type StreamingCardDeps = {
  larkClient: Lark.Client
  chatId: string
  replyToMessageId?: string
}

export class StreamingCard {
  // ---- lifecycle state ----
  private phase: StreamingCardPhase = 'idle'

  // ---- CardKit state ----
  /** CardKit card_id。null = CardKit 创建失败，已退到 patch fallback 模式。 */
  private cardId: string | null = null
  /** IM message_id。始终应该有值（否则连 patch 也做不了）。 */
  private messageId: string | null = null
  /** CardKit cardElement.content() 单调递增序列号。 */
  private sequence = 0
  /** CardKit 流式还在工作。230099 之后置为 false，中间帧将跳过，
   *  最终 finalize 仍会尝试 settings+update（cardId 仍然有效）。 */
  private cardKitStreamActive = false

  // ---- text state ----
  private accumulatedText = ''
  private lastFlushedText = ''

  // ---- flush ----
  private flushController: FlushController

  constructor(private readonly deps: StreamingCardDeps) {
    this.flushController = new FlushController(() => this.performFlush())
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * 首次创建卡片（CardKit 主路径；失败则降级到直发 Schema 2.0 卡 + patch）。
   * 幂等：已创建/正在创建时直接返回。
   */
  async ensureCreated(): Promise<void> {
    if (this.phase !== 'idle') return
    this.phase = 'creating'

    try {
      // CardKit 主路径
      const cardId = await createCardEntity(
        this.deps.larkClient,
        buildInitialStreamingCard(),
      )
      const messageId = await sendCardAsMessage(
        this.deps.larkClient,
        this.deps.chatId,
        cardId,
        this.deps.replyToMessageId,
      )
      this.cardId = cardId
      this.messageId = messageId
      this.cardKitStreamActive = true
      this.sequence = 1
      this.phase = 'streaming'
      this.flushController.setCardMessageReady(true)
    } catch (cardKitErr) {
      // CardKit 不可用（权限、网络、API 兼容性等）→ 降级到直发卡片 + patch
      console.warn(
        '[Feishu StreamingCard] CardKit create/send failed, falling back to im.message.patch:',
        cardKitErr instanceof Error ? cardKitErr.message : cardKitErr,
      )
      try {
        const fallbackResp = await this.deps.larkClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: this.deps.chatId,
            msg_type: 'interactive',
            content: JSON.stringify(buildRenderedCard(' ')),
          },
        })
        const mid = fallbackResp.data?.message_id
        if (!mid) {
          throw new Error('fallback im.message.create returned no message_id')
        }
        this.cardId = null
        this.messageId = mid
        this.cardKitStreamActive = false
        this.phase = 'streaming'
        this.flushController.setCardMessageReady(true)
      } catch (fallbackErr) {
        // 兜底都失败了 —— 无法显示任何东西
        console.error(
          '[Feishu StreamingCard] Fallback card creation also failed:',
          fallbackErr instanceof Error ? fallbackErr.message : fallbackErr,
        )
        this.phase = 'aborted'
        throw fallbackErr
      }
    }

    // 卡片可写之后若已有 buffered 文本，立刻触发一次 flush
    if (this.accumulatedText.length > 0) {
      void this.flushController.throttledUpdate(this.currentThrottle())
    }
  }

  /** 追加文本增量。不等待，只安排一次节流 flush。 */
  appendText(delta: string): void {
    if (!delta) return
    if (this.phase === 'completed' || this.phase === 'aborted') return
    this.accumulatedText += delta
    void this.flushController.throttledUpdate(this.currentThrottle())
  }

  /**
   * 流式结束，切到最终态。
   * - 先 waitForFlush 确保中间帧写入完成
   * - 然后 close streaming_mode（仅 CardKit 路径）
   * - 最后用完整 rendered 卡片 update
   * - complete FlushController 锁死，后续 appendText 被忽略
   */
  async finalize(): Promise<void> {
    if (this.phase === 'completed' || this.phase === 'aborted') return
    if (this.phase === 'idle') {
      // 完全没开始 —— 直接标记完成
      this.phase = 'completed'
      this.flushController.complete()
      return
    }
    this.phase = 'finalizing'
    this.flushController.cancelPendingFlush()
    await this.flushController.waitForFlush()

    const finalText = this.renderedText()
    try {
      if (this.cardId) {
        // CardKit 路径: settings(false) + card.update（即使中间 stream 曾失败）
        this.sequence += 1
        await setCardStreamingMode(
          this.deps.larkClient,
          this.cardId,
          false,
          this.sequence,
        )
        this.sequence += 1
        await updateCardKitCard(
          this.deps.larkClient,
          this.cardId,
          buildRenderedCard(finalText),
          this.sequence,
        )
      } else if (this.messageId) {
        // Patch fallback 路径: 全量替换
        await this.deps.larkClient.im.message.patch({
          path: { message_id: this.messageId },
          data: { content: JSON.stringify(buildRenderedCard(finalText)) },
        })
      }
    } catch (err) {
      console.error(
        '[Feishu StreamingCard] finalize failed:',
        err instanceof Error ? err.message : err,
      )
      // 不抛出 —— 用户已经看到某种版本的内容，finalize 失败不是致命错误
    } finally {
      this.phase = 'completed'
      this.lastFlushedText = finalText
      this.flushController.complete()
    }
  }

  /** 错误中止 —— 尝试把错误信息渲染到卡片上。 */
  async abort(err: Error): Promise<void> {
    if (this.phase === 'completed' || this.phase === 'aborted') return
    const wasIdle = this.phase === 'idle'
    this.phase = 'aborted'
    this.flushController.cancelPendingFlush()
    await this.flushController.waitForFlush().catch(() => {})

    if (wasIdle || !this.messageId) {
      // 卡片还没创建成功，没法渲染错误 —— 由上层 sendText 兜底
      this.flushController.complete()
      return
    }

    const errCard = buildErrorCard(
      `${err.message}${this.accumulatedText ? '\n\n——\n\n' + this.accumulatedText : ''}`,
    )
    try {
      if (this.cardId) {
        this.sequence += 1
        await setCardStreamingMode(
          this.deps.larkClient,
          this.cardId,
          false,
          this.sequence,
        ).catch(() => {}) // 关流失败无所谓，update 才是关键
        this.sequence += 1
        await updateCardKitCard(
          this.deps.larkClient,
          this.cardId,
          errCard,
          this.sequence,
        )
      } else {
        await this.deps.larkClient.im.message.patch({
          path: { message_id: this.messageId },
          data: { content: JSON.stringify(errCard) },
        })
      }
    } catch (renderErr) {
      console.error(
        '[Feishu StreamingCard] abort render failed:',
        renderErr instanceof Error ? renderErr.message : renderErr,
      )
    } finally {
      this.flushController.complete()
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /** 当前应使用的节流时长。 */
  private currentThrottle(): number {
    return this.cardKitStreamActive ? THROTTLE.CARDKIT_MS : THROTTLE.PATCH_MS
  }

  /** 把 accumulatedText 经 sanitize + optimize 管道出来。 */
  private renderedText(): string {
    // 表格数限制在 optimize 之前做 —— sanitize 对原始 markdown 最准
    const limited = sanitizeTextForCard(this.accumulatedText)
    return optimizeMarkdownForFeishu(limited, 2)
  }

  /** FlushController 调用的 doFlush。 */
  private async performFlush(): Promise<void> {
    if (this.phase !== 'streaming') return
    if (!this.messageId) return

    // CardKit 中间帧被禁用但 cardId 仍有效 —— 跳过中间 flush，
    // 等 finalize 用 cardId 做最终 settings + update
    if (this.cardId && !this.cardKitStreamActive) return

    const finalText = this.renderedText()
    if (finalText === this.lastFlushedText) return

    if (this.cardKitStreamActive && this.cardId) {
      // CardKit 主路径
      this.sequence += 1
      try {
        await streamCardContent(
          this.deps.larkClient,
          this.cardId,
          STREAMING_ELEMENT_ID,
          finalText,
          this.sequence,
        )
        this.lastFlushedText = finalText
      } catch (err) {
        if (isCardRateLimitError(err)) {
          // 跳帧 —— 下次 throttledUpdate 会重试
          return
        }
        if (isCardTableLimitError(err)) {
          // 表格超限 —— 禁用流式中间帧，等 finalize 用 update 一次性发完整卡
          console.warn(
            '[Feishu StreamingCard] 230099 table limit, disabling CardKit streaming',
          )
          this.cardKitStreamActive = false
          return
        }
        // 其他错误 —— 禁用流式，最坏情况等 finalize 兜底
        console.error(
          '[Feishu StreamingCard] stream flush failed:',
          err instanceof Error ? err.message : err,
        )
        this.cardKitStreamActive = false
        return
      }
    } else {
      // Patch fallback 路径（CardKit 从未成功）
      try {
        await this.deps.larkClient.im.message.patch({
          path: { message_id: this.messageId },
          data: { content: JSON.stringify(buildRenderedCard(finalText)) },
        })
        this.lastFlushedText = finalText
      } catch (err) {
        if (isCardRateLimitError(err)) return
        console.error(
          '[Feishu StreamingCard] patch flush failed:',
          err instanceof Error ? err.message : err,
        )
      }
    }
  }

  // ------------------------------------------------------------------
  // Test helpers (exposed for unit tests, not part of public API)
  // ------------------------------------------------------------------

  /** @internal */
  _getPhase(): StreamingCardPhase {
    return this.phase
  }

  /** @internal */
  _getCardId(): string | null {
    return this.cardId
  }

  /** @internal */
  _getMessageId(): string | null {
    return this.messageId
  }

  /** @internal */
  _getSequence(): number {
    return this.sequence
  }

  /** @internal */
  _isCardKitStreamActive(): boolean {
    return this.cardKitStreamActive
  }

  /** @internal */
  _getAccumulatedText(): string {
    return this.accumulatedText
  }

  /** @internal */
  _getFlushController(): FlushController {
    return this.flushController
  }
}
