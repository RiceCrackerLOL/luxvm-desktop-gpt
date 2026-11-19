
import React, { useState, useEffect, useRef } from 'react'
import { all, create, evaluate as mathEvaluate, derivative as mathDerivative, simplify as mathSimplify } from 'mathjs'

declare global {
  interface Window {
    luxvmUpdater?: {
      checkForUpdates: () => Promise<{ ok: boolean; message?: string }>
      downloadUpdate: () => Promise<{ ok: boolean; message?: string }>
      installUpdate: () => Promise<{ ok: boolean; message?: string }>
      onStatus: (callback: (payload: { status: string; data?: any }) => void) => () => void
    }
  }
}

type WorkspaceTab = 'chat' | 'voice' | 'codex' | 'chess' | 'image'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
}

interface ChatSession {
  id: string
  title: string
  messages: Message[]
  memory?: string
  updatedAt: number
}

interface ModelConfig {
  chat: string
  math: string
  voice: string
  codex: string
  chess: string
  image: string
}

interface GeneratedImage {
  id: string
  prompt: string
  url: string
  timestamp: string
  mode?: 'generate' | 'edit'
}

const SESSIONS_KEY = 'luxvm_or_sessions_v2'
const ACTIVE_SESSION_KEY = 'luxvm_or_active_v2'
const SETTINGS_KEY = 'luxvm_or_settings_v2'

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_IMAGE_URL = 'https://openrouter.ai/api/v1/images'

const DEFAULT_MODELS: ModelConfig = {
  chat: 'nvidia/nemotron-3.5-lightning:free',
  math: '',
  voice: 'nvidia/nemotron-3.5-super-vl:free',
  codex: 'cohere/north-mini-code:free',
  chess: 'nvidia/nemotron-3.5-lightning:free',
  image: 'recraft/recraft-v4.1-flash-v2:free',
}

const DEFAULT_SYSTEM_PROMPT = `You are LuxVM, a capable, thoughtful desktop AI assistant.

How to respond:
- Understand the user's actual goal and answer the request directly before adding context.
- Be accurate and honest. Never invent facts, sources, capabilities, actions, or completed work.
- If information may be uncertain or time-sensitive, say so and explain what would verify it.
- Ask a concise clarifying question only when a missing detail prevents a useful answer; otherwise make a sensible assumption and state it when relevant.
- Adapt depth to the task. Be concise for simple requests and thorough for complex ones.
- Use clear structure for multi-step explanations. Prefer practical examples and actionable steps.
- For code, provide complete, maintainable, secure solutions; explain important assumptions and edge cases.
- Preserve the user's stated preferences and existing work. Do not make unrelated changes.
- Use a calm, natural, professional tone. Avoid filler, excessive enthusiasm, and emojis.`

function getOpenRouterError(rawText: string, status: number): string {
  let detail = ''
  try {
    const parsed = JSON.parse(rawText)
    detail = parsed?.error?.message || parsed?.message || ''
  } catch {
    detail = rawText.replace(/\s+/g, ' ').trim().slice(0, 240)
  }

  const statusHint: Record<number, string> = {
    400: 'The request was rejected. Check the selected model and request settings.',
    401: 'The API key was rejected. Check your OpenRouter key in Settings.',
    402: 'OpenRouter reports insufficient credits or payment capacity for this request.',
    403: 'The request was blocked. Check model access and provider permissions.',
    404: 'The selected model or endpoint could not be found.',
    408: 'The request timed out. Please try again.',
    429: 'The model is receiving too many requests. Wait a moment and try again.',
    500: 'The model provider encountered an internal error. Try again shortly.',
    502: 'The model provider is temporarily unavailable. Try again shortly.',
    503: 'The model provider is overloaded or unavailable. Try again shortly.',
  }
  return [`OpenRouter error (HTTP ${status}).`, statusHint[status], detail].filter(Boolean).join(' ')
}

function extractOpenRouterText(data: any, fallback: string): string {
  const choice = data?.choices?.[0]
  const content = choice?.message?.content
  if (typeof content === 'string' && content.trim()) return content.trim()
  if (Array.isArray(content)) {
    const text = content
      .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  const finishReason = choice?.finish_reason || 'not provided'
  const completionTokens = data?.usage?.completion_tokens
  const usageNote = Number.isFinite(completionTokens) ? ` Completion tokens: ${completionTokens}.` : ''
  if (finishReason === 'length') return `The model stopped at its output-token limit without returning visible text. Increase the response budget or choose a model with a larger output limit.${usageNote}`
  if (choice?.message?.refusal) return `The model declined this request: ${String(choice.message.refusal).slice(0, 500)}`
  return `${fallback} (finish_reason: ${finishReason}.${usageNote})`
}

function safeGetStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function safeSetStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (err) {
    console.error(`Storage write failed for ${key}:`, err)
  }
}


const preciseMath = create(all, { number: 'BigNumber', precision: 64 })

type ResponseTier = 'quick' | 'standard' | 'deep'

function isMathPrompt(prompt: string): boolean {
  return /\b(math|mathematics|calculate|compute|equation|solve|proof|prove|derivative|differentiate|integral|integrate|limit|matrix|determinant|eigenvalue|probability|statistics|calculus|algebra|geometry|trigonometry|factor|simplify|polynomial|exponent|exponential|power|raised to|squared|cubed|square root|sqrt|percent|percentage|factorial|logarithm|log|ln|sine|cosine|tangent|permutation|combination|summation|series|vector)\b|\d\s*(?:\^\s*\{[^}]+\}|\^|\*\*|×|÷|\/|\+|-|!)\s*\d?|[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼]/i.test(prompt)
}

function classifyResponseTier(prompt: string): ResponseTier {
  const value = prompt.trim().toLowerCase()
  const complexSignals = /\b(prove|derive|debug|architect|design|compare|evaluate|analy[sz]e|step[- ]by[- ]step|multi[- ]step|in depth|deep dive|optimi[sz]e|algorithm|proof|theorem|differential|integral|matrix|recursion|trade-?offs|raised to|exponent|exponential|power|factorial|summation|series)\b/
  const mathematicalExpression = /\d\s*(?:\^\s*\{[^}]+\}|\^|\*\*|×|÷|\/|\+|-)\s*\d?|[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼]/.test(value)
  if (isMathPrompt(value) && (complexSignals.test(value) || mathematicalExpression || value.length > 120)) return 'deep'
  if (complexSignals.test(value) || value.length > 650 || (value.match(/\n/g) || []).length >= 3) return 'deep'
  if (/^(what is|what's|whats|who is|when did|where is|define|how many|how much)\b/.test(value) && value.length < 140) return 'quick'
  if (value.length < 90 && !/[;{}]/.test(value) && !isMathPrompt(value)) return 'quick'
  return 'standard'
}

function getDirectCalculatorAnswer(prompt: string): string | null {
  const expression = prompt.trim()
    .replace(/^(?:calculate|compute|evaluate|what is|what's|whats|how much is)\s+/i, '')
    .replace(/[?=]+$/g, '')
    .replace(/\b(plus|added to)\b/gi, '+')
    .replace(/\b(minus|subtract)\b/gi, '-')
    .replace(/\b(times|multiplied by)\b/gi, '*')
    .replace(/\b(divided by|over)\b/gi, '/')
    .replace(/\b(squared)\b/gi, '^2')
    .replace(/\b(cubed)\b/gi, '^3')
    .trim()
  if (!expression || expression.length > 500 || !/[0-9]/.test(expression)) return null
  if (!/^[0-9a-zA-Z_\s()+\-*/%^.,!]+$/.test(expression)) return null
  if (/\b(?:import|createUnit|evaluate|parse|simplify|derivative|help|version|config|typed|reviver|replacer)\b/i.test(expression)) return null
  try {
    const result = preciseMath.evaluate(expression)
    if (result && typeof result.toString === 'function' && (preciseMath.isBigNumber(result) || typeof result === 'number')) {
      const output = result.toString()
      if (output && output !== 'NaN' && output !== 'Infinity' && output !== '-Infinity') {
        return output
      }
    }
  } catch {}
  return null
}


const SAGEMATHCELL_SERVICE_URL = 'https://sagecell.sagemath.org/service'

function buildKeylessSageCode(question: string): string | null {
  let q = question.trim().replace(/^\$+|\$+$/g, '').replace(/^\\\(|\\\)$/g, '').replace(/\\left|\\right/g, '').replace(/\\cdot/g, '*').replace(/\\times/g, '*').replace(/\\div/g, '/').replace(/\\pi/g, 'pi').replace(/\\sqrt\{([^{}]+)\}/g, 'sqrt($1)').replace(/\^\{([^{}]+)\}/g, '^($1)').replace(/[{}]/g, '').replace(/[?=]+$/g, '').trim()
  let op = 'evaluate', variable = 'x'
  const patterns: Array<[RegExp, string]> = [
    [/^(?:differentiate|derivative of)\s+(.+?)(?:\s+(?:with respect to|w\.r\.t\.?)\s+([a-z]))?$/i, 'differentiate'],
    [/^(?:integrate|integral of)\s+(.+?)(?:\s+with respect to\s+([a-z]))?$/i, 'integrate'],
    [/^(?:factor|factorise|factorize)\s+(.+)$/i, 'factor'],
    [/^simplify\s+(.+)$/i, 'simplify'],
    [/^solve\s+(.+?)(?:\s+for\s+([a-z]))?$/i, 'solve'],
    [/^(?:calculate|compute|evaluate|what is|what's|whats)\s+(.+)$/i, 'evaluate'],
  ]
  for (const [pattern, operation] of patterns) { const m = q.match(pattern); if (m) { op = operation; q = m[1].trim(); if (m[2]) variable = m[2].toLowerCase(); break } }
  if (!q || q.length > 2000 || !/^[a-zA-Z0-9_+\-*/^().,!\s]+$/.test(q) || /\b(import|exec|eval|open|input|while|for|lambda|class|def|print|system|globals|locals)\b|__/.test(q)) return null
  if (op === 'differentiate') return "var('" + variable + "'); print(diff(" + q + ', ' + variable + '))'
  if (op === 'integrate') return "var('" + variable + "'); print(integrate(" + q + ', ' + variable + '))'
  if (op === 'factor') return 'print(factor(' + q + '))'
  if (op === 'simplify') return 'print((' + q + ').simplify_full())'
  if (op === 'solve') return "var('" + variable + "'); print(solve(" + q + ', ' + variable + '))'
  return 'print(' + q + ')'
}

async function executeSageMathCode(code: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(SAGEMATHCELL_SERVICE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'omit', signal, body: JSON.stringify({ code }) })
  const raw = await response.text()
  if (!response.ok) throw new Error('SageMathCell is unavailable (HTTP ' + response.status + '). Please try again.')
  let result: any; try { result = JSON.parse(raw) } catch { throw new Error('SageMathCell returned an unreadable result.') }
  if (result?.success !== true) { const detail = String(result?.stderr || result?.error || '').trim(); throw new Error(detail ? 'SageMathCell could not calculate this: ' + detail.slice(0, 400) : 'SageMathCell could not calculate this expression.') }
  const answer = String(result?.stdout || '').trim(); if (!answer) throw new Error('SageMathCell returned no final answer.'); return answer
}

async function solveWithSageMathCell(
  question: string,
  apiKey: string,
  model: string,
  headers: (key?: string) => Record<string, string>,
  signal: AbortSignal,
): Promise<string> {
  const codegenResponse = await fetch(OPENROUTER_CHAT_URL, {
    method: 'POST',
    headers: headers(apiKey),
    signal,
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 1800,
      messages: [
        {
          role: 'system',
          content: [
            'You convert a user mathematical question into executable SageMath code for SageMathCell.',
            'Return ONLY SageMath code. Do not use Markdown fences, prose, explanations, derivations, or solution steps.',
            'The code must compute the correct result and print ONLY the final answer using print(...). Do not print intermediate values.',
            'Use exact symbolic arithmetic whenever possible; use QQ, ZZ, SR, solve, limit, diff, integrate, matrix, factor, etc. as appropriate.',
            'For numerical answers, use sufficient precision and label approximations clearly.',
            'For word problems, define variables, encode the stated conditions, solve them, and print only the requested answer with units when applicable.',
            'If the question is ambiguous or lacks necessary information, print a short statement identifying exactly what is missing.',
            'Do not assume unstated values or silently choose among multiple valid solutions. If multiple solutions are requested, print the complete answer set.',
            'Do not import modules. Do not access files, environment variables, networks, processes, or system resources.',
            'Do not use open, exec, eval, compile, input, interact, while, or dunder attributes.',
            'Avoid unbounded computation. Use SageMath built-ins and bounded calculations.',
            'The final output must be suitable to show directly to the user without any explanation.',
          ].join(' '),
        },
        {
          role: 'user',
          content: 'Convert this problem into SageMath code and calculate its final answer only:\n\n' + question,
        },
      ],
    }),
  })

  const codegenText = await codegenResponse.text()
  if (!codegenResponse.ok) throw new Error(getOpenRouterError(codegenText, codegenResponse.status))
  const codegenData = JSON.parse(codegenText)
  let sageCode = extractOpenRouterText(codegenData, 'The math model did not return SageMath code.')
    .replace(/^\x60{3}(?:sage|python)?\s*/i, '')
    .replace(/\s*\x60{3}$/, '')
    .trim()

  if (!sageCode || sageCode.length > 8000) {
    throw new Error('The math model did not produce valid SageMath code. Please rephrase the problem.')
  }
  if (!/\bprint\s*\(/.test(sageCode)) {
    throw new Error('The math model did not provide a final-answer output. Please try again.')
  }
  if (/\b(import|exec|eval|compile|open|input|interact|while)\b|__|(?:os|sys|subprocess|socket|requests|urllib|pathlib)\s*\./i.test(sageCode)) {
    throw new Error('The generated calculation was blocked by LuxVM safety checks. Please rephrase the problem.')
  }

  const calculationResponse = await fetch(SAGEMATHCELL_SERVICE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'omit',
    signal,
    body: JSON.stringify({ code: sageCode }),
  })
  const calculationText = await calculationResponse.text()
  if (!calculationResponse.ok) {
    throw new Error('SageMathCell could not calculate this problem (HTTP ' + calculationResponse.status + '). Please try again shortly.')
  }

  let calculation: any
  try {
    calculation = JSON.parse(calculationText)
  } catch {
    throw new Error('SageMathCell returned an unreadable result. Please try again.')
  }
  if (calculation?.success !== true) {
    const detail = String(calculation?.stderr || calculation?.error || '').trim()
    throw new Error(detail
      ? 'SageMathCell could not solve this problem: ' + detail.slice(0, 500)
      : 'SageMathCell could not solve this problem. Please check the question and try again.')
  }

  const answer = String(calculation?.stdout || '').trim()
  if (!answer) throw new Error('SageMathCell completed the calculation but returned no final answer. Please try again.')
  return answer
}

function getCalculatorContext(prompt: string): string {
  const trimmed = prompt.trim()
  const derivativeMatch = trimmed.match(/(?:differentiate|derivative of)\s+(.+?)(?:\s+(?:with respect to|w\.r\.t\.?)\s+([a-z]))?[?.!]*$/i)
  if (derivativeMatch) {
    try {
      const variable = (derivativeMatch[2] || 'x').toLowerCase()
      const result = mathDerivative(derivativeMatch[1].replace(/[?.!]+$/g, '').trim(), variable).toString()
      return 'Verified symbolic derivative (variable ' + variable + '): ' + result + '. Check and use this result; do not mention an internal calculator unless asked.'
    } catch {}
  }

  const simplifyMatch = trimmed.match(/(?:simplify|factor)\s+(.+?)[?.!]*$/i)
  if (simplifyMatch) {
    try {
      const result = mathSimplify(simplifyMatch[1].replace(/[?.!]+$/g, '').trim()).toString()
      return 'Verified symbolic simplification: ' + result + '. Check and use this result; do not mention an internal calculator unless asked.'
    } catch {}
  }

  const integralMatch = trimmed.match(/(?:integrate|definite integral of)\s+(.+?)\s+from\s+(-?\d+(?:\.\d+)?)\s+to\s+(-?\d+(?:\.\d+)?)/i)
  if (integralMatch) {
    try {
      const expression = integralMatch[1].replace(/^['"]|['"]$/g, '').trim()
      const lower = Number(integralMatch[2])
      const upper = Number(integralMatch[3])
      const intervals = 2000
      const step = (upper - lower) / intervals
      let sum = Number(mathEvaluate(expression, { x: lower })) + Number(mathEvaluate(expression, { x: upper }))
      for (let i = 1; i < intervals; i++) {
        const y = Number(mathEvaluate(expression, { x: lower + i * step }))
        if (!Number.isFinite(y)) throw new Error('Non-finite integrand')
        sum += (i % 2 === 0 ? 2 : 4) * y
      }
      const result = (sum * step) / 3
      if (Number.isFinite(result)) return 'Verified numerical definite integral using Simpson rule: ' + result.toPrecision(12) + '. State that this is a numerical approximation, not a symbolic antiderivative.'
    } catch {}
  }

  const percentOf = trimmed.match(/(?:what is |calculate |compute )?(-?\d+(?:\.\d+)?)\s*%\s*of\s*(-?\d+(?:\.\d+)?)/i)
  if (percentOf) {
    const result = (Number(percentOf[1]) / 100) * Number(percentOf[2])
    if (Number.isFinite(result)) return 'Verified local calculator result: ' + percentOf[1] + '% of ' + percentOf[2] + ' = ' + Number(result.toPrecision(14)) + '. Use this result when answering; do not mention an internal calculator unless asked.'
  }

  const explicit = trimmed.match(/(?:calculate|compute|evaluate|solve|what is|what's|whats|how much is)\s+(.+?)[?.!]*$/i)
  const direct = /^[\d.\s()+\-*/%^a-z,]+$/i.test(trimmed) ? trimmed : null
  const verbal = (explicit?.[1] || direct || '').toLowerCase()
    .replace(/\b(plus|added to)\b/g, '+')
    .replace(/\b(minus|subtract)\b/g, '-')
    .replace(/\b(times|multiplied by)\b/g, '*')
    .replace(/\b(divided by|over)\b/g, '/')
    .replace(/\b(squared)\b/g, '^2')
    .replace(/\b(cubed)\b/g, '^3')
    .replace(/\bsquare root of\s*(\d+(?:\.\d+)?|\([^)]*\))/g, 'sqrt($1)')
  const candidate = verbal.replace(/[?=]+$/g, '').trim()
  if (!candidate || candidate.length > 500 || !/^[\d.a-z_\s()+\-*/%^,]+$/i.test(candidate)) return ''
  try {
    const result = mathEvaluate(candidate)
    if (typeof result !== 'number' || !Number.isFinite(result)) return ''
    return 'Verified local calculator result: ' + candidate + ' = ' + Number(result.toPrecision(14)) + '. Use this result when answering; do not mention an internal calculator unless asked.'
  } catch {
    return ''
  }
}

function updateSessionMemory(previous: string | undefined, messages: Message[]): string {
  const explicitFacts = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content.match(/(?:remember that|for this chat, remember|in this chat, remember)\s+(.+)/i)?.[1]?.trim())
    .filter((fact): fact is string => Boolean(fact))
  return Array.from(new Set([...(previous ? [previous] : []), ...explicitFacts])).join('\n').slice(-1800)
}

// Self-contained Chess Engine Helpers
type PieceChar = 'P' | 'N' | 'B' | 'R' | 'Q' | 'K' | 'p' | 'n' | 'b' | 'r' | 'q' | 'k' | null
type Board = PieceChar[][]

const PIECE_UNICODE: Record<string, string> = {
  K: '\u2654', Q: '\u2655', R: '\u2656', B: '\u2657', N: '\u2658', P: '\u2659',
  k: '\u265A', q: '\u265B', r: '\u265C', b: '\u265D', n: '\u265E', p: '\u265F',
}

function createInitialBoard(): Board {
  return [
    ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
    ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'],
    ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'],
  ]
}

function cloneBoard(b: Board): Board {
  return b.map((row) => [...row])
}

function isWhitePiece(p: PieceChar): boolean {
  return p !== null && p === p.toUpperCase()
}

function isBlackPiece(p: PieceChar): boolean {
  return p !== null && p === p.toLowerCase()
}

function coordsToUci(r1: number, c1: number, r2: number, c2: number): string {
  const files = 'abcdefgh'
  return `${files[c1]}${8 - r1}${files[c2]}${8 - r2}`
}

function uciToCoords(uci: string): { r1: number; c1: number; r2: number; c2: number; promo?: string } | null {
  const clean = uci.trim().toLowerCase().replace(/[^a-h1-8qrbn]/g, '')
  if (clean.length < 4) return null
  const files = 'abcdefgh'
  const c1 = files.indexOf(clean[0])
  const r1 = 8 - parseInt(clean[1], 10)
  const c2 = files.indexOf(clean[2])
  const r2 = 8 - parseInt(clean[3], 10)
  if ([c1, r1, c2, r2].some((v) => isNaN(v) || v < 0 || v > 7)) return null
  return { r1, c1, r2, c2, promo: clean[4] }
}

function boardToFen(board: Board, turn: 'w' | 'b', history: string[] = []): string {
  let castling = 'KQkq'
  let enPassant = '-'
  for (const move of history) {
    const from = move.slice(0, 2)
    const to = move.slice(2, 4)
    if (from === 'e1') castling = castling.replace(/[KQ]/g, '')
    if (from === 'e8') castling = castling.replace(/[kq]/g, '')
    if (from === 'h1' || to === 'h1') castling = castling.replace('K', '')
    if (from === 'a1' || to === 'a1') castling = castling.replace('Q', '')
    if (from === 'h8' || to === 'h8') castling = castling.replace('k', '')
    if (from === 'a8' || to === 'a8') castling = castling.replace('q', '')
    if (/^[a-h][27][a-h][45]$/.test(move) && Math.abs(Number(from[1]) - Number(to[1])) === 2) {
      enPassant = from[0] + (Number(from[1]) + Number(to[1])) / 2
    } else enPassant = '-'
  }
  if (!castling) castling = '-'
  const rows = board.map((row) => {
    let empty = 0
    let str = ''
    for (const cell of row) {
      if (!cell) {
        empty++
      } else {
        if (empty > 0) {
          str += empty
          empty = 0
        }
        str += cell
      }
    }
    if (empty > 0) str += empty
    return str
  })
  return `${rows.join('/')} ${turn} ${castling} ${enPassant} 0 1`
}

function getPseudoLegalMoves(board: Board, r: number, c: number, history: string[] = []): [number, number][] {
  const piece = board[r][c]
  if (!piece) return []
  const white = isWhitePiece(piece)
  const moves: [number, number][] = []
  const inBounds = (nr: number, nc: number) => nr >= 0 && nr < 8 && nc >= 0 && nc < 8
  const isAlly = (nr: number, nc: number) => {
    const target = board[nr][nc]
    return target !== null && (white ? isWhitePiece(target) : isBlackPiece(target))
  }
  const isEnemy = (nr: number, nc: number) => {
    const target = board[nr][nc]
    return target !== null && (white ? isBlackPiece(target) : isWhitePiece(target))
  }

  const type = piece.toUpperCase()

  if (type === 'P') {
    const dir = white ? -1 : 1
    const startRow = white ? 6 : 1
    if (inBounds(r + dir, c) && !board[r + dir][c]) {
      moves.push([r + dir, c])
      if (r === startRow && !board[r + 2 * dir][c]) {
        moves.push([r + 2 * dir, c])
      }
    }
    for (const dc of [-1, 1]) {
      if (inBounds(r + dir, c + dc) && isEnemy(r + dir, c + dc)) {
        moves.push([r + dir, c + dc])
      }
    }
    const previousMove = history[history.length - 1]
    if (previousMove && /^[a-h][27][a-h][45]$/.test(previousMove)) {
      const fromRow = 8 - Number(previousMove[1])
      const toRow = 8 - Number(previousMove[3])
      const toCol = 'abcdefgh'.indexOf(previousMove[2])
      if (Math.abs(fromRow - toRow) === 2 && toRow === r && Math.abs(toCol - c) === 1 && board[r][toCol]?.toLowerCase() === 'p') {
        moves.push([r + dir, toCol])
      }
    }
  } else if (type === 'N') {
    const jumps = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]
    for (const [dr, dc] of jumps) {
      if (inBounds(r + dr, c + dc) && !isAlly(r + dr, c + dc)) {
        moves.push([r + dr, c + dc])
      }
    }
  } else if (type === 'K') {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue
        if (inBounds(r + dr, c + dc) && !isAlly(r + dr, c + dc)) {
          moves.push([r + dr, c + dc])
        }
      }
    }
    if (white && r === 7 && c === 4) {
      if (!board[7][5] && !board[7][6] && board[7][7] === 'R') moves.push([7, 6])
      if (!board[7][3] && !board[7][2] && !board[7][1] && board[7][0] === 'R') moves.push([7, 2])
    }
    if (!white && r === 0 && c === 4) {
      if (!board[0][5] && !board[0][6] && board[0][7] === 'r') moves.push([0, 6])
      if (!board[0][3] && !board[0][2] && !board[0][1] && board[0][0] === 'r') moves.push([0, 2])
    }
  } else {
    const dirs: [number, number][] = []
    if (type === 'R' || type === 'Q') dirs.push([-1, 0], [1, 0], [0, -1], [0, 1])
    if (type === 'B' || type === 'Q') dirs.push([-1, -1], [-1, 1], [1, -1], [1, 1])
    for (const [dr, dc] of dirs) {
      let nr = r + dr
      let nc = c + dc
      while (inBounds(nr, nc)) {
        if (isAlly(nr, nc)) break
        moves.push([nr, nc])
        if (isEnemy(nr, nc)) break
        nr += dr
        nc += dc
      }
    }
  }
  return moves
}

function applyRawMove(board: Board, r1: number, c1: number, r2: number, c2: number, promo?: string): Board {
  const next = cloneBoard(board)
  const piece = next[r1][c1]
  next[r2][c2] = piece
  next[r1][c1] = null

  if ((piece === 'P' || piece === 'p') && c1 !== c2 && board[r2][c2] === null) {
    next[piece === 'P' ? r2 + 1 : r2 - 1][c2] = null
  }

  if (piece === 'K' && r1 === 7 && c1 === 4 && c2 === 6) {
    next[7][5] = 'R'
    next[7][7] = null
  } else if (piece === 'K' && r1 === 7 && c1 === 4 && c2 === 2) {
    next[7][3] = 'R'
    next[7][0] = null
  } else if (piece === 'k' && r1 === 0 && c1 === 4 && c2 === 6) {
    next[0][5] = 'r'
    next[0][7] = null
  } else if (piece === 'k' && r1 === 0 && c1 === 4 && c2 === 2) {
    next[0][3] = 'r'
    next[0][0] = null
  }

  if (piece === 'P' && r2 === 0) {
    next[r2][c2] = (promo ? promo.toUpperCase() : 'Q') as PieceChar
  } else if (piece === 'p' && r2 === 7) {
    next[r2][c2] = (promo ? promo.toLowerCase() : 'q') as PieceChar
  }
  return next
}

function isKingInCheck(board: Board, whiteKing: boolean): boolean {
  let kr = -1
  let kc = -1
  const targetKing = whiteKing ? 'K' : 'k'
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c] === targetKing) {
        kr = r
        kc = c
      }
    }
  }
  if (kr === -1) return true

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c]
      if (!p) continue
      if (whiteKing ? isBlackPiece(p) : isWhitePiece(p)) {
        const attacks = getPseudoLegalMoves(board, r, c)
        if (attacks.some(([ar, ac]) => ar === kr && ac === kc)) return true
      }
    }
  }
  return false
}

function getAllLegalMoves(board: Board, whiteTurn: boolean, history: string[] = []): string[] {
  const legalUcis: string[] = []
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c]
      if (!p) continue
      if (whiteTurn ? isWhitePiece(p) : isBlackPiece(p)) {
        const dests = getPseudoLegalMoves(board, r, c, history)
        for (const [nr, nc] of dests) {
          const testBoard = applyRawMove(board, r, c, nr, nc)
          if (!isKingInCheck(testBoard, whiteTurn)) {
            legalUcis.push(coordsToUci(r, c, nr, nc))
          }
        }
      }
    }
  }
  return legalUcis
}

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('chat')
  const [comingSoonPage, setComingSoonPage] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [githubRepo, setGithubRepo] = useState<string>(() => safeGetStorage<any>(SETTINGS_KEY, {}).githubRepo || 'RiceCrackerLOL/luxvm-desktop-gpt')
  const [githubToken, setGithubToken] = useState('')
  const [githubTargetPath, setGithubTargetPath] = useState('src/generated-codex-output.txt')
  const [githubCommitMessage, setGithubCommitMessage] = useState('Update LuxVM from Codex Studio')
  const [showGithubApproval, setShowGithubApproval] = useState(false)
  const [isGithubPublishing, setIsGithubPublishing] = useState(false)
  const [githubStatus, setGithubStatus] = useState('')
  const [updateStatus, setUpdateStatus] = useState('Checking for updates when available...')
  const [updateProgress, setUpdateProgress] = useState(0)

  useEffect(() => {
    const unsubscribe = window.luxvmUpdater?.onStatus(({ status, data }) => {
      if (status === 'checking') setUpdateStatus('Checking for updates...')
      if (status === 'available') {
        setUpdateStatus(`Update ${data?.version || ''} is available.`)
      }
      if (status === 'up-to-date') setUpdateStatus('LuxVM is up to date.')
      if (status === 'downloading') {
        setUpdateProgress(data?.percent || 0)
        setUpdateStatus(`Downloading update: ${data?.percent || 0}%`)
      }
      if (status === 'downloaded') {
        setUpdateStatus(`Update ${data?.version || ''} is ready to install. Restart LuxVM to finish.`)
      }
      if (status === 'error') setUpdateStatus(`Update error: ${data?.message || 'Unknown error'}`)
    })
    return () => unsubscribe?.()
  }, [])

  const checkForLuxVMUpdates = async () => {
    setUpdateStatus('Checking for updates...')
    const result = await window.luxvmUpdater?.checkForUpdates()
    if (result && !result.ok) setUpdateStatus(result.message || 'Update check failed.')
  }

  const downloadLuxVMUpdate = async () => {
    setUpdateStatus('Starting update download...')
    const result = await window.luxvmUpdater?.downloadUpdate()
    if (result && !result.ok) setUpdateStatus(result.message || 'Update download failed.')
  }

  const installLuxVMUpdate = async () => {
    const result = await window.luxvmUpdater?.installUpdate()
    if (result && !result.ok) setUpdateStatus(result.message || 'Could not install update.')
  }

  const initialSettings = safeGetStorage(SETTINGS_KEY, {
    apiKey: '',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    models: DEFAULT_MODELS,
    theme: 'light' as 'light' | 'dark',
    imageProvider: 'openrouter' as 'openrouter' | 'cloudflare',
    cloudflareWorkerUrl: '',
    cloudflareAccessKey: '',
  })

  const [apiKey, setApiKey] = useState<string>(initialSettings.apiKey || '')
  const [systemPrompt, setSystemPrompt] = useState<string>(
    initialSettings.systemPrompt || DEFAULT_SYSTEM_PROMPT
  )
  const [models, setModels] = useState<ModelConfig>({
    ...DEFAULT_MODELS,
    ...(initialSettings.models || {}),
  })
  const [theme, setTheme] = useState<'light' | 'dark'>(initialSettings.theme === 'dark' ? 'dark' : 'light')
  const [imageProvider, setImageProvider] = useState<'openrouter' | 'cloudflare'>(initialSettings.imageProvider === 'cloudflare' ? 'cloudflare' : 'openrouter')
  const [cloudflareWorkerUrl, setCloudflareWorkerUrl] = useState<string>(initialSettings.cloudflareWorkerUrl || '')
  const [cloudflareAccessKey, setCloudflareAccessKey] = useState<string>(initialSettings.cloudflareAccessKey || '')

  useEffect(() => {
    safeSetStorage(SETTINGS_KEY, {
      apiKey: apiKey.trim(),
      systemPrompt: systemPrompt.trim(),
      models,
      githubRepo: githubRepo.trim(),
      theme,
      imageProvider,
      cloudflareWorkerUrl: cloudflareWorkerUrl.trim(),
      cloudflareAccessKey: cloudflareAccessKey.trim(),
    })
  }, [apiKey, systemPrompt, models, githubRepo, theme, imageProvider, cloudflareWorkerUrl, cloudflareAccessKey])

  const openRouterHeaders = (key = apiKey) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key.trim()}`,
    'HTTP-Referer': 'https://luxvm.desktop',
    'X-Title': 'LuxVM Desktop',
  })

  const testOpenRouterConnection = async () => {
    const key = apiKey.trim()
    if (!key) { setApiStatus('Enter an OpenRouter API key first.'); return }
    setIsTestingApi(true)
    setApiStatus('Checking key and model access…')
    try {
      const response = await fetch(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: openRouterHeaders(key),
        body: JSON.stringify({
          model: models.chat.trim(),
          messages: [{ role: 'user', content: 'Reply with exactly: LuxVM connection successful.' }],
        }),
      })
      const raw = await response.text()
      if (!response.ok) throw new Error(getOpenRouterError(raw, response.status))
      const data = JSON.parse(raw)
      const testContent = data?.choices?.[0]?.message?.content
      const hasVisibleText = typeof testContent === 'string'
        ? Boolean(testContent.trim())
        : Array.isArray(testContent) && testContent.some((part: any) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim())
      if (!hasVisibleText) throw new Error(extractOpenRouterText(data, 'OpenRouter accepted the request but returned no visible text.'))
      setApiStatus(`Connection successful — ${models.chat.trim()} responded.`)
    } catch (error: any) {
      setApiStatus(error?.message || 'Connection test failed.')
    } finally {
      setIsTestingApi(false)
    }
  }

  // 1. General Chat
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const saved = safeGetStorage<ChatSession[]>(SESSIONS_KEY, [])
    if (Array.isArray(saved) && saved.length > 0) return saved
    return [
      {
        id: 'default-session',
        title: 'New Chat',
        messages: [
          {
            id: 'welcome-1',
            role: 'assistant',
            content: 'Welcome to LuxVM Desktop. Paste your OpenRouter key in Settings to unlock Chat, Voice, Codex, Chess, and Image Studio!',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ],
        updatedAt: Date.now(),
      },
    ]
  })

  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    try {
      const savedId = localStorage.getItem(ACTIVE_SESSION_KEY)
      if (savedId && sessions.some((s) => s.id === savedId)) return savedId
    } catch (error) {
      console.warn('Could not read the active chat from browser storage:', error)
    }
    return sessions[0]?.id || 'default-session'
  })

  const [chatInput, setChatInput] = useState('')
  const [isChatLoading, setIsChatLoading] = useState(false)
  const [apiStatus, setApiStatus] = useState('')
  const [isTestingApi, setIsTestingApi] = useState(false)
  const chatBottomRef = useRef<HTMLDivElement | null>(null)
  const currentSession = sessions.find((s) => s.id === activeSessionId) || sessions[0]

  useEffect(() => {
    safeSetStorage(SESSIONS_KEY, sessions)
  }, [sessions])

  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId)
    } catch (error) {
      console.warn('Could not save the active chat to browser storage:', error)
    }
  }, [activeSessionId])

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [currentSession?.messages, isChatLoading, activeTab])

  const createNewChat = () => {
    const newSession: ChatSession = {
      id: String(Date.now()),
      title: 'New Chat',
      messages: [
        {
          id: 'welcome-new',
          role: 'assistant',
          content: 'Started a new session using your persistent personality and OpenRouter key.',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ],
      updatedAt: Date.now(),
    }
    setSessions((prev) => [newSession, ...prev])
    setActiveSessionId(newSession.id)
    setActiveTab('chat')
    setComingSoonPage('')
  }

  const deleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (sessions.length <= 1) createNewChat()
    setSessions((prev) => prev.filter((s) => s.id !== id))
    if (activeSessionId === id) {
      const remaining = sessions.filter((s) => s.id !== id)
      if (remaining.length > 0) setActiveSessionId(remaining[0].id)
    }
  }

  const sendChatMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    const trimmed = chatInput.trim()
    if (!trimmed || isChatLoading) return

    const userMsg: Message = {
      id: String(Date.now()),
      role: 'user',
      content: trimmed,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }

    const updatedMessages = [...currentSession.messages, userMsg]
    const derivedTitle =
      currentSession.title === 'New Chat'
        ? trimmed.slice(0, 28) + (trimmed.length > 28 ? '...' : '')
        : currentSession.title

    setSessions((prev) =>
      prev.map((s) =>
        s.id === currentSession.id
          ? { ...s, title: derivedTitle, messages: updatedMessages, memory: updateSessionMemory(s.memory, updatedMessages), updatedAt: Date.now() }
          : s
      )
    )
    setChatInput('')
    setIsChatLoading(true)

    const controller = new AbortController()
    const responseTierForTimeout = classifyResponseTier(trimmed)
    const requestTimeoutMs = responseTierForTimeout === 'deep' ? 10 * 60 * 1000 : 90 * 1000
    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs)

    try {
      const mathQuestion = isMathPrompt(trimmed)
      if (mathQuestion && !apiKey.trim()) {
        const sageCode = buildKeylessSageCode(trimmed)
        if (!sageCode) throw new Error('This maths question needs natural-language interpretation. Expressions, powers, derivatives, integrals, factoring and equations can be calculated without an API key. Add an API key for full word-problem interpretation.')
        const finalAnswer = await executeSageMathCode(sageCode, controller.signal)
        setSessions((prev) => prev.map((s) => s.id === currentSession.id ? { ...s, messages: [...s.messages, { id: String(Date.now() + 1), role: 'assistant', content: finalAnswer, timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }], updatedAt: Date.now() } : s))
        return
      }
      if (!apiKey.trim()) throw new Error('Missing OpenRouter API Key. Click Settings in the top right to paste it.')
      const chatMemory = updateSessionMemory(currentSession.memory, updatedMessages)
      const responseTier = classifyResponseTier(trimmed)
      if (mathQuestion) {
        const finalAnswer = await solveWithSageMathCell(
          trimmed,
          apiKey.trim(),
          models.math.trim() || models.chat.trim(),
          openRouterHeaders,
          controller.signal,
        )
        setSessions((prev) =>
          prev.map((s) =>
            s.id === currentSession.id
              ? {
                  ...s,
                  messages: [
                    ...s.messages,
                    {
                      id: String(Date.now() + 1),
                      role: 'assistant',
                      content: finalAnswer,
                      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    },
                  ],
                  updatedAt: Date.now(),
                }
              : s
          )
        )
        return
      }

      const outboundMessages = [
        ...(systemPrompt.trim() ? [{ role: 'system' as const, content: systemPrompt.trim() }] : []),
        ...(chatMemory ? [{ role: 'system' as const, content: 'Memory saved for this chat only:\n' + chatMemory }] : []),
        { role: 'system' as const, content: mathQuestion ? 'Mathematics mode: solve accurately, verify intermediate calculations, check units and edge cases, and distinguish exact answers from numerical approximations. Use concise working for routine problems and a clear rigorous derivation for difficult ones. Never invent a calculator result.' : responseTier === 'quick' ? 'This is a straightforward request. Answer accurately and directly in the fewest useful words. Do not over-explain.' : responseTier === 'deep' ? 'This is a demanding request. Take the time needed to reason carefully, verify steps, and explain the important details.' : 'Use a balanced level of detail appropriate to the request.' },
        ...updatedMessages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, content: m.content })),
      ]

      const requestApiKey = apiKey.trim()
      if (!requestApiKey) throw new Error('OpenRouter API key is empty. Re-enter it in Settings and save.')
      const res = await fetch(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: openRouterHeaders(requestApiKey),
        body: JSON.stringify({
          model: mathQuestion && models.math.trim() ? models.math.trim() : models.chat,
          messages: outboundMessages,
          ...(mathQuestion && responseTier === 'deep' ? { reasoning: { effort: 'high', exclude: true } } : {}),
        }),
        signal: controller.signal,
      })

      const rawText = await res.text()
      if (!res.ok) throw new Error(getOpenRouterError(rawText, res.status))

      const data = JSON.parse(rawText)
      const reply = extractOpenRouterText(data, 'The model returned an empty response. Please try again.')

      setSessions((prev) =>
        prev.map((s) =>
          s.id === currentSession.id
            ? {
                ...s,
                messages: [
                  ...s.messages,
                  {
                    id: String(Date.now() + 1),
                    role: 'assistant',
                    content: reply,
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                  },
                ],
                updatedAt: Date.now(),
              }
            : s
        )
      )
    } catch (err: any) {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === currentSession.id
            ? {
                ...s,
                messages: [
                  ...s.messages,
                  {
                    id: String(Date.now() + 1),
                    role: 'system',
                    content: `Error: ${err?.name === 'AbortError' ? `The request timed out after ${Math.round(requestTimeoutMs / 60000)} minute(s). Please try again or select a faster model.` : err?.message}`,
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                  },
                ],
              }
            : s
        )
      )
    } finally {
      clearTimeout(timeoutId)
      setIsChatLoading(false)
    }
  }

  // 2. Voice Assistant
  const [voiceHistory, setVoiceHistory] = useState<Message[]>([
    {
      id: 'v-init',
      role: 'assistant',
      content: 'Voice Assistant ready. Press the Microphone button to speak or type below.',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ])
  const [voiceInput, setVoiceInput] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [isVoiceLoading, setIsVoiceLoading] = useState(false)
  const [autoSpeak, setAutoSpeak] = useState(true)
  const recognitionRef = useRef<any>(null)

  const speakText = (text: string) => {
    if (!('speechSynthesis' in window)) return
    window.speechSynthesis.cancel()
    const cleanText = text.replace(/[*#`]/g, '')
    const utterance = new SpeechSynthesisUtterance(cleanText)
    utterance.rate = 1.05
    utterance.pitch = 1.0
    window.speechSynthesis.speak(utterance)
  }

  const sendVoicePrompt = async (spokenText: string) => {
    const trimmed = spokenText.trim()
    if (!trimmed || isVoiceLoading) return

    const userMsg: Message = {
      id: String(Date.now()),
      role: 'user',
      content: trimmed,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }
    const nextHist = [...voiceHistory, userMsg]
    setVoiceHistory(nextHist)
    setVoiceInput('')
    setIsVoiceLoading(true)

    try {
      if (!apiKey.trim()) throw new Error('Please paste your OpenRouter API key in  Settings.')

      const voiceSystem = `${systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT}\n\nVoice mode: Speak naturally and conversationally. Keep spoken replies clear and reasonably concise. Avoid markdown, tables, and code blocks unless the user asks for them. If a task needs several steps, guide the user one step at a time.`

      const res = await fetch(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: openRouterHeaders(),
        body: JSON.stringify({
          model: models.voice,
          messages: [
            { role: 'system', content: voiceSystem },
            ...nextHist
              .filter((m) => m.role === 'user' || m.role === 'assistant')
              .map((m) => ({ role: m.role, content: m.content })),
          ],
        }),
      })

      const rawText = await res.text()
      if (!res.ok) throw new Error(getOpenRouterError(rawText, res.status))

      const data = JSON.parse(rawText)
      const reply = extractOpenRouterText(data, 'I did not receive a readable response. Please try again.')

      setVoiceHistory((prev) => [
        ...prev,
        {
          id: String(Date.now() + 1),
          role: 'assistant',
          content: reply,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ])

      if (autoSpeak) speakText(reply)
    } catch (err: any) {
      setVoiceHistory((prev) => [
        ...prev,
        {
          id: String(Date.now() + 1),
          role: 'system',
          content: `Voice Error: ${err?.name === 'AbortError' ? 'The request timed out. Please try again.' : err?.message}`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ])
    } finally {
      setIsVoiceLoading(false)
    }
  }

  const toggleMicrophone = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this environment. You can still type in the box below!')
      return
    }

    if (isListening) {
      recognitionRef.current?.stop()
      setIsListening(false)
      return
    }

    const recognition = new SpeechRecognition()
    recognition.lang = 'en-US'
    recognition.interimResults = false
    recognition.maxAlternatives = 1

    recognition.onstart = () => setIsListening(true)
    recognition.onresult = (event: any) => {
      const transcript = event.results?.[0]?.[0]?.transcript || ''
      if (transcript) {
        setActiveTab('chat')
        setComingSoonPage('')
        setChatInput(transcript)
      }
    }
    recognition.onerror = () => setIsListening(false)
    recognition.onend = () => setIsListening(false)

    recognitionRef.current = recognition
    recognition.start()
  }

  // 3. Codex Studio
  const [codexPrompt, setCodexPrompt] = useState('')
  const [codexLang, setCodexLang] = useState('TypeScript / React')
  const [codexOutput, setCodexOutput] = useState('// Your generated code will appear here...\n')
  const [isCodexLoading, setIsCodexLoading] = useState(false)
  const [copiedCode, setCopiedCode] = useState(false)

  const generateCode = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!codexPrompt.trim() || isCodexLoading) return

    setIsCodexLoading(true)
    setCopiedCode(false)

    try {
      if (!apiKey.trim()) throw new Error('Paste your OpenRouter API key in  Settings first.')

      const res = await fetch(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: openRouterHeaders(),
        body: JSON.stringify({
          model: models.codex,
          messages: [
            {
              role: 'system',
              content: `You are LuxVM Codex, a senior software engineer. Build a correct, maintainable solution in ${codexLang}. Follow the user's requirements closely and preserve any supplied interfaces or constraints. Prefer simple, readable code; handle relevant edge cases; validate untrusted input; avoid insecure defaults and unnecessary dependencies. Include helpful comments only where they add value. If the request is ambiguous but still actionable, make a reasonable assumption. If a critical detail is missing, ask one concise question instead of inventing it. Output the complete code only, without markdown fences or conversational preamble.`,
            },
            { role: 'user', content: codexPrompt.trim() },
          ],
        }),
      })

      const rawText = await res.text()
      if (!res.ok) throw new Error(getOpenRouterError(rawText, res.status))

      const data = JSON.parse(rawText)
      let code: string = extractOpenRouterText(data, '// The model returned no code. Please try again.')
      code = code.replace(/^```[\w-]*\n?/i, '').replace(/\n?```$/i, '')
      setCodexOutput(code)
    } catch (err: any) {
      setCodexOutput(`// Generation Error:\n// ${err?.name === 'AbortError' ? 'The request timed out. Please try again.' : err?.message}`)
    } finally {
      setIsCodexLoading(false)
    }
  }


  const encodeBase64Utf8 = (value: string): string => {
    const bytes = new TextEncoder().encode(value)
    let binary = ''
    bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
    return btoa(binary)
  }

  const publishCodexToGithub = async () => {
    const repoName = githubRepo.trim()
    const path = githubTargetPath.trim().replace(/^\/+/, '')
    if (!/^[^/]+\/[^/]+$/.test(repoName)) {
      setGithubStatus('Enter the repository as owner/repository.')
      return
    }
    if (!githubToken.trim()) {
      setGithubStatus('Add a GitHub personal access token in Settings first.')
      return
    }
    if (!path || !codexOutput.trim() || codexOutput.startsWith('// Your generated code')) {
      setGithubStatus('Generate code and enter a target file path first.')
      return
    }

    setIsGithubPublishing(true)
    setGithubStatus('')
    try {
      const apiBase = 'https://api.github.com/repos/' + repoName + '/contents/' + path.split('/').map(encodeURIComponent).join('/')
      const headers = {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + githubToken.trim(),
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      }
      const existing = await fetch(apiBase + '?ref=main', { headers })
      let existingSha: string | undefined
      if (existing.ok) {
        const existingData = await existing.json()
        existingSha = existingData.sha
      } else if (existing.status !== 404) {
        throw new Error('GitHub could not read the target file (HTTP ' + existing.status + '). Check the token and repository permissions.')
      }

      const response = await fetch(apiBase, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: githubCommitMessage.trim() || 'Update LuxVM from Codex Studio',
          content: encodeBase64Utf8(codexOutput),
          ...(existingSha ? { sha: existingSha } : {}),
          branch: 'main',
        }),
      })
      const raw = await response.text()
      if (!response.ok) {
        let detail = raw
        try { detail = JSON.parse(raw).message || raw } catch {}
        throw new Error('GitHub rejected the update (HTTP ' + response.status + '): ' + detail)
      }
      const result = JSON.parse(raw)
      setGithubStatus('Committed successfully: ' + (result.commit?.html_url || result.content?.html_url || 'GitHub update created.'))
      setShowGithubApproval(false)
    } catch (error: any) {
      setGithubStatus(error?.message || 'Could not publish the update.')
    } finally {
      setIsGithubPublishing(false)
    }
  }


  const copyCodeToClipboard = () => {
    navigator.clipboard.writeText(codexOutput)
    setCopiedCode(true)
    setTimeout(() => setCopiedCode(false), 2000)
  }

  const downloadCodeFile = () => {
    const extMap: Record<string, string> = {
      'TypeScript / React': 'tsx',
      JavaScript: 'js',
      Python: 'py',
      'HTML / CSS': 'html',
      'C++': 'cpp',
      Rust: 'rs',
    }
    const ext = extMap[codexLang] || 'txt'
    const blob = new Blob([codexOutput], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `luxvm-codex-${Date.now()}.${ext}`
    a.click()
    URL.revokeObjectURL(url)
  }

  // 4. Chess Bot
  const [board, setBoard] = useState<Board>(() => createInitialBoard())
  const [selectedSq, setSelectedSq] = useState<[number, number] | null>(null)
  const [legalTargets, setLegalTargets] = useState<[number, number][]>([])
  const [moveHistory, setMoveHistory] = useState<string[]>([])
  const [chessStatus, setChessStatus] = useState('Your turn (White). Click a piece to move.')
  const [isChessThinking, setIsChessThinking] = useState(false)
  const stockfishWorkerRef = useRef<Worker | null>(null)
  const stockfishReadyRef = useRef(false)

  useEffect(() => () => {
    stockfishWorkerRef.current?.terminate()
    stockfishWorkerRef.current = null
    stockfishReadyRef.current = false
  }, [])

  const chooseStockfishMove = (fen: string): Promise<string> => new Promise((resolve, reject) => {
    let worker = stockfishWorkerRef.current
    if (!worker) {
      worker = new Worker(new URL('stockfish/stockfish-19-lite-single.js', window.location.href))
      stockfishWorkerRef.current = worker
      stockfishReadyRef.current = false
    }
    let finished = false
    const finish = (error?: Error, move?: string) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      worker!.removeEventListener('message', onMessage)
      if (error) reject(error)
      else if (move && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) resolve(move)
      else reject(new Error('Stockfish did not return a valid move.'))
    }
    const onMessage = (event: MessageEvent) => {
      const line = String(event.data || '').trim()
      if (line === 'uciok') {
        worker!.postMessage('setoption name Threads value 1')
        worker!.postMessage('setoption name Hash value 128')
        worker!.postMessage('isready')
      } else if (line === 'readyok') {
        stockfishReadyRef.current = true
        worker!.postMessage('position fen ' + fen)
        worker!.postMessage('go movetime 1200')
      } else if (line.startsWith('bestmove ')) {
        finish(undefined, line.split(/\s+/)[1])
      }
    }
    const timeout = window.setTimeout(() => finish(new Error('The local chess engine took too long to respond.')), 30000)
    worker!.addEventListener('message', onMessage)
    worker!.addEventListener('error', () => finish(new Error('Could not start the local Stockfish engine.')), { once: true })
    if (stockfishReadyRef.current) {
      worker!.postMessage('position fen ' + fen)
      worker!.postMessage('go movetime 1200')
    } else {
      worker!.postMessage('uci')
    }
  })

  const resetChess = () => {
    setBoard(createInitialBoard())
    setSelectedSq(null)
    setLegalTargets([])
    setMoveHistory([])
    setChessStatus('New game started. Your turn (White).')
    setIsChessThinking(false)
  }

  const handleSquareClick = async (r: number, c: number) => {
    if (isChessThinking) return

    const clickedPiece = board[r][c]

    if (clickedPiece && isWhitePiece(clickedPiece)) {
      setSelectedSq([r, c])
      const allWhiteMoves = getAllLegalMoves(board, true, moveHistory)
      const targets: [number, number][] = []
      for (const uci of allWhiteMoves) {
        const parsed = uciToCoords(uci)
        if (parsed && parsed.r1 === r && parsed.c1 === c) {
          targets.push([parsed.r2, parsed.c2])
        }
      }
      setLegalTargets(targets)
      return
    }

    if (selectedSq) {
      const [sr, sc] = selectedSq
      const isTarget = legalTargets.some(([tr, tc]) => tr === r && tc === c)
      if (!isTarget) {
        setSelectedSq(null)
        setLegalTargets([])
        return
      }

      const playerUci = coordsToUci(sr, sc, r, c)
      const afterPlayerBoard = applyRawMove(board, sr, sc, r, c)
      const nextHistory = [...moveHistory, playerUci]

      setBoard(afterPlayerBoard)
      setSelectedSq(null)
      setLegalTargets([])
      setMoveHistory(nextHistory)

      const blackLegalMoves = getAllLegalMoves(afterPlayerBoard, false, nextHistory)
      if (blackLegalMoves.length === 0) {
        setChessStatus(
          isKingInCheck(afterPlayerBoard, false)
            ? 'Checkmate! You win! '
            : 'Stalemate! Draw.'
        )
        return
      }

      setIsChessThinking(true)
      setChessStatus('Stockfish is calculating locally...')

      try {
        const fen = boardToFen(afterPlayerBoard, 'b', nextHistory)
        const chosenUci = await chooseStockfishMove(fen)
        const aiParsed = uciToCoords(chosenUci)
        if (!aiParsed) throw new Error('Stockfish returned an invalid move.')
        const afterAiBoard = applyRawMove(
          afterPlayerBoard,
          aiParsed.r1,
          aiParsed.c1,
          aiParsed.r2,
          aiParsed.c2,
          aiParsed.promo
        )
        const updatedHist = [...nextHistory, chosenUci]
        setBoard(afterAiBoard)
        setMoveHistory(updatedHist)

        const whiteLegalAfter = getAllLegalMoves(afterAiBoard, true, updatedHist)
        if (whiteLegalAfter.length === 0) {
          setChessStatus(
            isKingInCheck(afterAiBoard, true)
              ? `Checkmate! LuxVM wins with ${chosenUci}.`
              : 'Stalemate! Draw.'
          )
        } else if (isKingInCheck(afterAiBoard, true)) {
          setChessStatus(`Stockfish played ${chosenUci}. Check! Your turn.`)
        } else {
          setChessStatus(`Stockfish played ${chosenUci}. Your turn (White).`)
        }
      } catch (error: any) {
        setChessStatus(error?.message || 'Stockfish could not complete the move. Restart the game and try again.')
      } finally {
        setIsChessThinking(false)
      }
    }
  }

  // 5. Image Studio
  const [imagePrompt, setImagePrompt] = useState('')
  const [aspectRatio, setAspectRatio] = useState('1:1')
  const [generatedImages, setGeneratedImages] = useState<GeneratedImage[]>([])
  const [isImageLoading, setIsImageLoading] = useState(false)
  const [imageError, setImageError] = useState('')
  const [referenceImage, setReferenceImage] = useState<{ url: string; name: string } | null>(null)
  const [keepOriginalElements, setKeepOriginalElements] = useState(true)

  const handleReferenceUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setImageError('Choose a valid image file.')
      event.target.value = ''
      return
    }
    if (file.size > 12 * 1024 * 1024) {
      setImageError('Reference images must be 12 MB or smaller.')
      event.target.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setReferenceImage({ url: reader.result, name: file.name })
        setImageError('')
      } else {
        setImageError('LuxVM could not read that image. Try another file.')
      }
    }
    reader.onerror = () => setImageError('LuxVM could not read that image. Try another file.')
    reader.readAsDataURL(file)
    event.target.value = ''
  }

  const generateImage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!imagePrompt.trim() || isImageLoading) return

    setIsImageLoading(true)
    setImageError('')

    try {
      const prompt = referenceImage && keepOriginalElements
        ? `${imagePrompt.trim()} Preserve the original subject, identity, and important visual elements from the reference image unless the requested changes explicitly require changing them.`
        : imagePrompt.trim()
      let imgUrl = ''
      if (imageProvider === 'cloudflare') {
        if (!cloudflareWorkerUrl.trim()) throw new Error('Add your Cloudflare Worker URL in Settings before using FLUX.2.')
        if (!cloudflareAccessKey.trim()) throw new Error('Add your Cloudflare Worker access key in Settings before using FLUX.2.')
        const [ratioWidth, ratioHeight] = aspectRatio.split(':').map(Number)
        const width = ratioWidth >= ratioHeight ? 1024 : Math.max(256, Math.round(1024 * ratioWidth / ratioHeight))
        const height = ratioHeight >= ratioWidth ? 1024 : Math.max(256, Math.round(1024 * ratioHeight / ratioWidth))
        let cloudflareReference = referenceImage?.url || null
        if (cloudflareReference) {
          const imageBlob = await (await fetch(cloudflareReference)).blob()
          const bitmap = await createImageBitmap(imageBlob)
          const scale = Math.min(1, 511 / Math.max(bitmap.width, bitmap.height))
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(bitmap.width * scale))
          canvas.height = Math.max(1, Math.round(bitmap.height * scale))
          const context = canvas.getContext('2d')
          if (!context) throw new Error('Could not prepare the reference image for FLUX.2.')
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
          bitmap.close()
          cloudflareReference = canvas.toDataURL('image/png')
        }
        const response = await fetch(cloudflareWorkerUrl.trim(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cloudflareAccessKey.trim()}` },
          body: JSON.stringify({ prompt, width, height, referenceImage: cloudflareReference }),
        })
        const raw = await response.text()
        if (!response.ok) {
          let detail = raw
          try { detail = JSON.parse(raw).error || raw } catch { /* keep response text */ }
          throw new Error(`Cloudflare FLUX.2 failed (${response.status}): ${detail}`)
        }
        const result = JSON.parse(raw)
        if (!result.image) throw new Error('Cloudflare returned no image data.')
        imgUrl = result.image.startsWith('data:') ? result.image : `data:image/png;base64,${result.image}`
      } else {
        if (!apiKey.trim()) throw new Error('Please enter your OpenRouter API key in Settings.')
        const requestBody: Record<string, any> = { model: models.image, prompt, aspect_ratio: aspectRatio }
        if (referenceImage) requestBody.input_references = [{ type: 'image_url', image_url: { url: referenceImage.url } }]
        const res = await fetch(OPENROUTER_IMAGE_URL, { method: 'POST', headers: openRouterHeaders(), body: JSON.stringify(requestBody) })
        const rawText = await res.text()
        if (!res.ok) throw new Error(getOpenRouterError(rawText, res.status))
        const data = JSON.parse(rawText)
        const item = data?.data?.[0]
        if (item?.b64_json) imgUrl = `data:image/png;base64,${item.b64_json}`
        else if (item?.url) imgUrl = item.url
        else throw new Error('No image data returned by model.')
      }

      setGeneratedImages((prev) => [
        {
          id: String(Date.now()),
          prompt: imagePrompt.trim(),
          url: imgUrl,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          mode: referenceImage ? 'edit' : 'generate',
        },
        ...prev,
      ])
    } catch (err: any) {
      setImageError(err?.message || 'Failed to generate image.')
    } finally {
      setIsImageLoading(false)
    }
  }

  const globalStyle = <style>{`
    :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-synthesis: none; text-rendering: optimizeLegibility; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #FFFFFF; color: #202124; }
    button, input, textarea, select { font: inherit; }
    button { transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease, box-shadow 160ms ease, transform 160ms ease; }
    button:hover { filter: brightness(.97); }
    button:active { transform: translateY(1px); }

    [data-luxvm-theme="light"] { background: #FFFFFF !important; color: #202124 !important; color-scheme: light; }


    [data-luxvm-theme="dark"] { color-scheme: dark; }
    [data-luxvm-theme="light"] [data-luxvm-sidebar] { background: #F7F7F8 !important; border-right: 1px solid #E5E7EB !important; }
    [data-luxvm-theme="light"] [data-luxvm-main] { background: #FFFFFF !important; }
    [data-luxvm-theme="light"] header { background: #FFFFFF !important; color: #202124 !important; border-bottom: 1px solid #ECEDEF !important; }
    [data-luxvm-theme="light"] [data-luxvm-settings] { background: #FFFFFF !important; color: #202124 !important; border-bottom: 1px solid #ECEDEF !important; }
    [data-luxvm-theme="light"] [data-luxvm-settings] *:not([data-luxvm-chess]):not([data-luxvm-chess] *) { color: #202124 !important; }
    [data-luxvm-theme="light"] [data-luxvm-settings] h3 { color: #17191C !important; font-size: 20px !important; font-weight: 650 !important; letter-spacing: -0.025em !important; margin: 0 0 5px !important; }
    [data-luxvm-theme="light"] [data-luxvm-settings] input,
    [data-luxvm-theme="light"] [data-luxvm-settings] textarea,
    [data-luxvm-theme="light"] [data-luxvm-settings] select { background: #FFFFFF !important; color: #202124 !important; border: 1px solid #DADDE2 !important; }
    [data-luxvm-theme="light"] [data-luxvm-chat-composer] { background: #FFFFFF !important; border: 1px solid #DADDE2 !important; border-radius: 18px !important; }
    [data-luxvm-theme="light"] [data-luxvm-chat-composer] input { background: transparent !important; color: #202124 !important; border: 0 !important; }
    [data-luxvm-theme="light"] [data-luxvm-message="assistant"] { background: transparent !important; color: #202124 !important; border: 0 !important; }
    [data-luxvm-theme="light"] [data-luxvm-message="user"] { background: #F1F2F4 !important; color: #202124 !important; border: 0 !important; }
    [data-luxvm-theme="light"] [data-luxvm-chess] { color-scheme: light; }

    [data-luxvm-theme="dark"] { background: #191A1D !important; color: #E8E9EB !important; color-scheme: dark; }
    [data-luxvm-theme="dark"] [data-luxvm-sidebar] { background: #1B1D21 !important; border-right: 1px solid #2B2E34 !important; }
    [data-luxvm-theme="dark"] [data-luxvm-main] { background: #191A1D !important; }
    [data-luxvm-theme="dark"] header { background: #191A1D !important; color: #E8E9EB !important; border-bottom: 1px solid #2B2E34 !important; }
    [data-luxvm-theme="dark"] [data-luxvm-settings] { background: #191A1D !important; color: #E8E9EB !important; border-bottom: 1px solid #2B2E34 !important; }
    [data-luxvm-theme="dark"] [data-luxvm-settings] *:not([data-luxvm-chess]):not([data-luxvm-chess] *) { color: #E8E9EB !important; }
    [data-luxvm-theme="dark"] [data-luxvm-settings] h3 { color: #FFFFFF !important; font-size: 20px !important; font-weight: 650 !important; letter-spacing: -0.025em !important; margin: 0 0 5px !important; }
    [data-luxvm-theme="dark"] [data-luxvm-settings] input,
    [data-luxvm-theme="dark"] [data-luxvm-settings] textarea,
    [data-luxvm-theme="dark"] [data-luxvm-settings] select { background: #24272D !important; color: #F5F6F7 !important; border: 1px solid #3B4149 !important; }
    [data-luxvm-theme="dark"] [data-luxvm-chat-composer] { background: #202328 !important; border: 1px solid #373B43 !important; border-radius: 18px !important; }
    [data-luxvm-theme="dark"] [data-luxvm-chat-composer] input { background: transparent !important; color: #F5F6F7 !important; border: 0 !important; }
    [data-luxvm-theme="dark"] [data-luxvm-message="user"] { background: #24272D !important; color: #F5F6F7 !important; border: 0 !important; }
    [data-luxvm-theme="dark"] [data-luxvm-message="assistant"] { background: transparent !important; color: #E8E9EB !important; border: 0 !important; }
    [data-luxvm-theme="dark"] [data-luxvm-chess] { color-scheme: light; }
    [data-luxvm-theme="light"] *:not([data-luxvm-chess] *) { color: #202124 !important; }
    [data-luxvm-theme="dark"] *:not([data-luxvm-chess] *) { color: #F5F6F7 !important; }
    [data-luxvm-theme="dark"] [data-luxvm-sidebar] button { background: transparent !important; color: #E8E9EB !important; }
    [data-luxvm-theme="dark"] [data-luxvm-sidebar] button[aria-current="page"],
    [data-luxvm-theme="dark"] [data-luxvm-sidebar] button:focus-visible { background: #303640 !important; color: #FFFFFF !important; }
    /* Keep every non-chess workspace readable in light mode. */
    [data-luxvm-theme="light"] [data-luxvm-main] *:not([data-luxvm-chess] *) { color: #202124 !important; }
    [data-luxvm-theme="light"] [data-luxvm-main] input,
    [data-luxvm-theme="light"] [data-luxvm-main] textarea,
    [data-luxvm-theme="light"] [data-luxvm-main] select { background: #FFFFFF !important; color: #202124 !important; border-color: #DADDE2 !important; }
    [data-luxvm-theme="light"] [data-luxvm-main] button:not([data-theme-choice]) { color: #202124 !important; }
    [data-luxvm-theme="light"] [data-luxvm-main] pre { background: #F7F8FA !important; color: #202124 !important; }
    [data-luxvm-theme="light"] [data-luxvm-main] [data-luxvm-surface] { background: #F7F7F8 !important; border-color: #E5E7EB !important; }
    [data-luxvm-theme="light"] [data-luxvm-main] button[data-theme-choice][aria-pressed="true"] { background: #E5E7EB !important; color: #202124 !important; border-color: #C9CDD3 !important; }
    [data-luxvm-theme="light"] [data-luxvm-main] button[data-theme-choice][aria-pressed="false"] { background: #FFFFFF !important; color: #202124 !important; border-color: #DADDE2 !important; }
    /* Keep every non-chess workspace readable in dark mode. */
    [data-luxvm-theme="dark"] [data-luxvm-main] *:not([data-luxvm-chess] *) { color: #F5F6F7 !important; }
    [data-luxvm-theme="dark"] [data-luxvm-main] input,
    [data-luxvm-theme="dark"] [data-luxvm-main] textarea,
    [data-luxvm-theme="dark"] [data-luxvm-main] select { background: #24272D !important; color: #F5F6F7 !important; border-color: #3B4149 !important; }
    [data-luxvm-theme="dark"] [data-luxvm-main] button:not([data-theme-choice]) { color: #F5F6F7 !important; }
    [data-luxvm-theme="dark"] [data-luxvm-main] pre { background: #17191D !important; color: #F5F6F7 !important; }
    [data-luxvm-theme="dark"] [data-luxvm-main] [data-luxvm-surface] { background: #202328 !important; border-color: #343942 !important; }
    /* Retain the existing layout; recolor only neutral inline surfaces in dark mode. */
    [data-luxvm-theme="dark"] [data-luxvm-sidebar] { background: #1B1D21 !important; color: #F5F6F7 !important; }
    [data-luxvm-theme="dark"] [data-luxvm-sidebar] [style*="background-color"] { background-color: #24272D !important; }
    [data-luxvm-theme="dark"] [data-luxvm-sidebar] button[style*="background-color: rgb(198, 106, 74)"] { background-color: #C66A4A !important; }
    [data-luxvm-theme="dark"] [data-luxvm-main] :is(div,section,article,form,aside)[style*="background-color"]:not([data-luxvm-chess]):not([data-luxvm-chess] *) { background-color: #202328 !important; }
    [data-luxvm-theme="dark"] [data-luxvm-main] :is(input,textarea,select) { background-color: #24272D !important; color: #F5F6F7 !important; border-color: #3B4149 !important; color-scheme: dark; }
    [data-luxvm-theme="dark"] [data-luxvm-main] pre, [data-luxvm-theme="dark"] [data-luxvm-main] code { background-color: #17191D !important; color: #F5F6F7 !important; }
    [data-luxvm-theme="dark"] [data-luxvm-main] button { color: #F5F6F7; }
    [data-luxvm-theme="dark"] [data-luxvm-main] button[style*="background-color: rgb(198, 106, 74)"],
    [data-luxvm-theme="dark"] [data-luxvm-main] button[style*="background: rgb(198, 106, 74)"] { background: #C66A4A !important; color: #FFFFFF !important; }
    [data-luxvm-theme="dark"] [data-luxvm-main] [data-luxvm-chess],
    [data-luxvm-theme="dark"] [data-luxvm-main] [data-luxvm-chess] * { color-scheme: light; }
    [data-luxvm-theme="dark"] [data-luxvm-main] button[data-theme-choice][aria-pressed="true"] { background: #3B4149 !important; color: #FFFFFF !important; border-color: #59616D !important; }
    [data-luxvm-theme="dark"] [data-luxvm-main] button[data-theme-choice][aria-pressed="false"] { background: transparent !important; color: #F5F6F7 !important; border-color: #3B4149 !important; }
    [data-luxvm-theme] [data-luxvm-settings] { flex: 1 1 auto; min-height: 0; max-height: calc(100vh - 64px); overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
    [data-luxvm-theme] [data-luxvm-settings] textarea[data-personality-prompt] { display: block; width: 100%; min-height: 220px; height: 32vh !important; max-height: 48vh; resize: vertical; line-height: 1.55; padding: 12px 14px !important; }
    [data-luxvm-theme="light"] [data-luxvm-settings] textarea[data-personality-prompt] { background: #FFFFFF !important; color: #202124 !important; border: 1px solid #C9CDD3 !important; }
    [data-luxvm-theme="dark"] [data-luxvm-settings] textarea[data-personality-prompt] { background: #24272D !important; color: #F5F6F7 !important; border: 1px solid #59616D !important; }
    [data-luxvm-theme="light"] [data-luxvm-settings] label, [data-luxvm-theme="light"] [data-luxvm-settings] span { color: #41454B !important; }
    [data-luxvm-theme="dark"] [data-luxvm-settings] label, [data-luxvm-theme="dark"] [data-luxvm-settings] span { color: #C9CDD3 !important; }
    /* ChatGPT-inspired LuxVM workspace */
    [data-luxvm-sidebar] { width:260px !important; min-width:260px !important; padding:8px 10px !important; gap:6px !important; }
    [data-luxvm-sidebar] { overflow:hidden !important; }
    [data-luxvm-sidebar-nav] { flex:0 0 auto !important; min-height:0 !important; max-height:52vh; overflow-y:auto !important; scrollbar-width:thin; }
    [data-luxvm-session-list] { flex:1 1 auto !important; min-height:0 !important; overflow-y:auto !important; scrollbar-width:thin; }
    .luxvm-sidebar-header { padding-top:8px !important; }
    [data-luxvm-sidebar] [style*="newChatBtn"] { width:100% !important; text-align:left !important; padding:10px 12px !important; border-radius:10px !important; }
    [data-luxvm-main] { background:var(--luxvm-workspace,#fff); }
    [data-luxvm-theme="dark"] [data-luxvm-main] { background:#191A1D; }
    [data-luxvm-chat-composer] { width:calc(100% - 48px) !important; box-sizing:border-box !important; }
    [data-luxvm-chat-composer] input { background:transparent !important; color:inherit !important; }
    [data-luxvm-chat-composer] input::placeholder { color:#92969D !important; }
    [data-luxvm-sidebar] button:focus-visible, [data-luxvm-chat-composer] button:focus-visible, [data-luxvm-search] button:focus-visible, [data-luxvm-search] input:focus-visible { outline:2px solid #C66A4A !important; outline-offset:2px !important; }

    [data-luxvm-sidebar][data-collapsed="true"] { width:64px !important; min-width:64px !important; }
    [data-luxvm-sidebar][data-collapsed="true"] ~ [data-luxvm-main] [data-luxvm-coming-soon] { left:64px; }
    [data-luxvm-sidebar] button { border-radius:9px !important; transition:background .16s ease,color .16s ease !important; }
    [data-luxvm-sidebar] button:hover { background:rgba(128,128,128,.13) !important; }
    [data-luxvm-sidebar] [style*="navBtnActive"] { background:rgba(128,128,128,.16) !important; border-left:0 !important; }
    [data-luxvm-sidebar] [style*="sidebarBrand"] { padding:12px 8px !important; }
    [data-luxvm-main] { min-width:0 !important; position:relative !important; }
    [data-luxvm-main] > header { min-height:58px !important; padding:10px 24px !important; box-shadow:none !important; }
    [data-luxvm-chat-area] { max-width:820px !important; padding:48px 28px 24px !important; gap:24px !important; }
    [data-luxvm-message="user"] { border-radius:20px !important; padding:12px 18px !important; }
    [data-luxvm-chat-composer] { max-width:820px !important; margin:0 auto 24px !important; padding:8px 10px 8px 14px !important; border-radius:26px !important; box-shadow:0 5px 24px rgba(0,0,0,.07) !important; align-items:center !important; gap:8px !important; }
    [data-luxvm-chat-composer] input { min-width:0 !important; padding:13px 8px !important; font-size:15px !important; }
    [data-luxvm-chat-composer] [data-composer-tool] { flex:0 0 36px !important; width:36px !important; height:36px !important; border:0 !important; border-radius:50% !important; background:transparent !important; color:inherit !important; cursor:pointer !important; font-size:22px !important; }
    [data-luxvm-chat-composer] [data-composer-tool]:hover { background:rgba(128,128,128,.15) !important; }
    [data-luxvm-chat-composer] [data-microphone] { font-size:19px !important; }
    [data-luxvm-chat-composer] button[type="submit"] { width:38px !important; height:38px !important; min-width:38px !important; padding:0 !important; border-radius:50% !important; font-size:21px !important; }
    [data-luxvm-search] { position:fixed; z-index:80; inset:0; display:flex; justify-content:center; align-items:flex-start; padding:12vh 20px 24px; background:rgba(0,0,0,.42); backdrop-filter:blur(4px); }
    .luxvm-search-panel { width:min(620px,100%); max-height:70vh; display:flex; flex-direction:column; gap:14px; padding:20px; border:1px solid rgba(128,128,128,.22); border-radius:18px; background:var(--luxvm-panel,#fff); color:inherit; box-shadow:0 20px 80px rgba(0,0,0,.24); }
    [data-luxvm-theme="dark"] .luxvm-search-panel { background:#22252A; }
    .luxvm-search-heading { display:flex; align-items:center; justify-content:space-between; font-size:16px; }
    .luxvm-search-heading button { border:0; background:transparent; color:inherit; font-size:24px; cursor:pointer; }
    .luxvm-search-panel > input { width:100%; box-sizing:border-box; padding:13px 15px; border:1px solid rgba(128,128,128,.3); border-radius:11px; background:transparent; color:inherit; font:inherit; outline:none; }
    .luxvm-search-results { overflow:auto; display:flex; flex-direction:column; gap:5px; }
    .luxvm-search-results > button { display:flex; flex-direction:column; gap:4px; text-align:left; padding:12px; border:0; border-radius:10px; background:transparent; color:inherit; cursor:pointer; }
    .luxvm-search-results > button:hover { background:rgba(128,128,128,.13); }
    .luxvm-search-results > button span,.luxvm-search-results > p { color:#858990; font-size:12px; }
    [data-luxvm-coming-soon] { position:fixed; z-index:50; left:260px; top:58px; right:0; bottom:0; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:32px; text-align:center; background:#fff; color:inherit; }
    [data-luxvm-theme="dark"] [data-luxvm-coming-soon] { background:#191A1D; }
    [data-luxvm-coming-soon] .luxvm-coming-icon { display:grid; place-items:center; width:58px; height:58px; margin-bottom:18px; border-radius:18px; background:rgba(128,128,128,.13); font-size:28px; }
    [data-luxvm-coming-soon] h1 { margin:0 0 10px; font-size:28px; letter-spacing:-.04em; }
    [data-luxvm-coming-soon] p { max-width:420px; color:#858990; line-height:1.6; }
    [data-luxvm-coming-soon] span { margin-top:12px; color:#C66A4A; font-size:10px; font-weight:800; letter-spacing:.16em; }
    [data-luxvm-coming-soon] button { margin-top:24px; border:1px solid rgba(128,128,128,.25); border-radius:20px; padding:10px 18px; background:transparent; color:inherit; cursor:pointer; }
    @media (max-width:760px) {
      [data-luxvm-sidebar] { width:68px !important; min-width:68px !important; }
      [data-luxvm-sidebar] [style*="navBtn"] { padding:10px 7px !important; }
      .luxvm-nav-icon { margin-right:0 !important; }
      [data-luxvm-main] > header { padding:8px 12px !important; }
      [data-luxvm-chat-area] { padding:28px 14px 18px !important; }
      [data-luxvm-chat-composer] { margin:0 12px 14px !important; }
      [data-luxvm-coming-soon] { left:68px; }
    }

    /* LuxVM workspace redesign */
    :root { --lux-sidebar:#f7f7f8; --lux-main:#fff; --lux-panel:#fff; --lux-text:#202123; --lux-muted:#777b83; --lux-border:#e5e5e7; --lux-hover:#ececee; --lux-user:#f4f4f4; --lux-accent:#b96d50; }
    [data-luxvm-theme="dark"] { --lux-sidebar:#171717; --lux-main:#212121; --lux-panel:#2b2b2b; --lux-text:#ececec; --lux-muted:#a1a1aa; --lux-border:#3a3a3a; --lux-hover:#303030; --lux-user:#303030; --lux-accent:#d58a6b; }
    [data-luxvm-theme] { background:var(--lux-main) !important; color:var(--lux-text) !important; }
    [data-luxvm-sidebar] { position:relative; z-index:30; flex:0 0 260px !important; width:260px !important; min-width:260px !important; height:100dvh; padding:10px 9px 12px; background:var(--lux-sidebar) !important; border-right:1px solid var(--lux-border) !important; color:var(--lux-text) !important; display:flex; flex-direction:column; overflow:hidden; transition:width .18s ease,min-width .18s ease,transform .2s ease; }
    .luxvm-sidebar-brand { min-height:48px !important; padding:4px 10px 12px !important; color:var(--lux-text) !important; }
    .luxvm-sidebar-brand strong { font-size:17px; font-weight:700; letter-spacing:-.035em; }
    .luxvm-brand-dot { width:10px !important; height:10px !important; border-radius:4px !important; background:var(--lux-accent) !important; }
    .luxvm-sidebar-toggle { color:var(--lux-muted) !important; width:30px !important; height:30px !important; }
    [data-luxvm-sidebar-nav] { padding:7px 3px 10px !important; gap:3px !important; overflow-y:auto; }
    [data-luxvm-sidebar] button { color:var(--lux-text) !important; }
    [data-luxvm-sidebar-nav] button { display:flex !important; align-items:center !important; min-height:38px; padding:8px 11px !important; border:0 !important; border-radius:9px !important; background:transparent !important; color:var(--lux-text) !important; font-size:13px !important; font-weight:450 !important; text-align:left; }
    [data-luxvm-sidebar-nav] button:hover,.luxvm-session-item:hover { background:var(--lux-hover) !important; }
    [data-luxvm-sidebar-nav] button:first-child { background:var(--lux-panel) !important; border:1px solid var(--lux-border) !important; font-weight:600 !important; margin-bottom:5px; }
    [data-luxvm-sidebar-nav] button[aria-current="page"] { background:var(--lux-hover) !important; }
    [data-luxvm-sidebar] [style*="navIcon"] { width:23px !important; margin-right:10px !important; font-size:16px !important; color:var(--lux-muted) !important; }
    .luxvm-sidebar-divider { border-color:var(--lux-border) !important; margin:5px 8px !important; }
    [data-luxvm-sidebar] [style*="sidebarHeader"] { display:flex !important; align-items:center; justify-content:space-between; padding:9px 10px 5px !important; color:var(--lux-muted) !important; font-size:11px !important; font-weight:650; letter-spacing:.04em; text-transform:uppercase; }
    [data-luxvm-sidebar] [style*="sidebarHeader"] button { border:0 !important; background:transparent !important; color:var(--lux-muted) !important; font-size:18px !important; cursor:pointer; }
    [data-luxvm-session-list] { flex:1; min-height:0; overflow-y:auto; padding:3px 2px 8px !important; }
    [data-luxvm-sidebar] [style*="sessionItem"] { display:flex; align-items:center; gap:5px; min-height:35px; padding:7px 9px !important; border-radius:8px; color:var(--lux-text) !important; cursor:pointer; }
    .luxvm-session-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px !important; color:var(--lux-text) !important; }
    .luxvm-session-delete { opacity:0; color:var(--lux-muted) !important; }
    [data-luxvm-sidebar] [style*="sessionItem"]:hover [style*="deleteBtn"] { opacity:1; }
    [data-luxvm-main] { position:relative; min-width:0; min-height:0; flex:1; display:flex; flex-direction:column; overflow:hidden; background:var(--lux-main) !important; color:var(--lux-text) !important; }
    [data-luxvm-main] > header { height:58px; min-height:58px; padding:0 22px !important; display:flex; align-items:center; justify-content:space-between; background:var(--lux-main) !important; color:var(--lux-text) !important; border-bottom:1px solid var(--lux-border) !important; }
    [data-luxvm-main] > header strong { font-size:14px !important; font-weight:650 !important; letter-spacing:-.015em; }
    [data-luxvm-main] > header select { background:transparent !important; border:1px solid var(--lux-border) !important; color:var(--lux-muted) !important; border-radius:8px !important; }
    [data-luxvm-main] > header button { border:1px solid var(--lux-border) !important; border-radius:9px !important; background:transparent !important; color:var(--lux-text) !important; padding:7px 11px !important; font-size:12px !important; }
    [data-luxvm-chat-area] { width:min(100%,920px) !important; max-width:920px !important; flex:1; min-height:0; margin:0 auto !important; padding:34px 34px 28px !important; gap:24px !important; overflow-y:auto; scrollbar-width:thin; scrollbar-color:var(--lux-border) transparent; }
    [data-luxvm-chat-area] [data-luxvm-message="user"] { max-width:min(76%,680px) !important; padding:12px 17px !important; border-radius:19px !important; background:var(--lux-user) !important; color:var(--lux-text) !important; font-size:14px !important; line-height:1.65 !important; }
    [data-luxvm-chat-area] [data-luxvm-message="assistant"] { width:100%; max-width:100% !important; padding:3px 0 !important; border-radius:0 !important; background:transparent !important; color:var(--lux-text) !important; font-size:14px !important; line-height:1.75 !important; }
    .luxvm-message-meta { color:var(--lux-muted) !important; font-size:11px !important; margin-bottom:8px !important; }
    .luxvm-message-content { white-space:pre-wrap; overflow-wrap:anywhere; }
    [data-luxvm-chat-composer] { width:min(calc(100% - 48px),820px) !important; max-width:820px !important; min-height:62px; margin:0 auto 22px !important; padding:8px 10px !important; gap:7px !important; align-items:center !important; border:1px solid var(--lux-border) !important; border-radius:20px !important; background:var(--lux-panel) !important; box-shadow:0 3px 16px rgba(0,0,0,.045); }
    [data-luxvm-chat-composer] input { min-width:0; min-height:42px; padding:10px 8px !important; color:var(--lux-text) !important; background:transparent !important; border:0 !important; outline:none !important; font-size:14px !important; }
    [data-luxvm-chat-composer] input::placeholder { color:var(--lux-muted) !important; }
    [data-luxvm-chat-composer] [data-composer-tool] { display:grid; place-items:center; flex:0 0 38px; width:38px; height:38px; padding:0 !important; border:0 !important; border-radius:50% !important; background:transparent !important; color:var(--lux-muted) !important; cursor:pointer; font-size:19px !important; }
    [data-luxvm-chat-composer] [data-composer-tool]:hover { background:var(--lux-hover) !important; color:var(--lux-text) !important; }
    [data-luxvm-chat-composer] button[type="submit"] { display:grid; place-items:center; width:38px; height:38px; padding:0 !important; flex:0 0 38px; border:0 !important; border-radius:50% !important; background:var(--lux-text) !important; color:var(--lux-main) !important; font-size:19px !important; font-weight:700; }
    [data-luxvm-chat-composer] button:disabled { opacity:.35; cursor:not-allowed; }
    .luxvm-welcome { width:100%; min-height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:20px 0 60px; }
    .luxvm-welcome-mark { display:grid; place-items:center; width:44px; height:44px; margin-bottom:20px; border-radius:15px; background:var(--lux-user); color:var(--lux-accent); font-size:22px; font-weight:800; }
    .luxvm-welcome h1 { margin:0; color:var(--lux-text); font-size:clamp(25px,3vw,34px); line-height:1.2; letter-spacing:-.045em; font-weight:650; }
    .luxvm-welcome p { margin:12px 0 26px; color:var(--lux-muted); font-size:14px; }
    .luxvm-suggestions { display:flex; flex-wrap:wrap; justify-content:center; gap:9px; }
    .luxvm-suggestions button { border:1px solid var(--lux-border); border-radius:13px; padding:11px 14px; background:var(--lux-panel); color:var(--lux-text); font-size:12px; cursor:pointer; }
    .luxvm-suggestions button:hover { background:var(--lux-hover); }
    [data-luxvm-settings] { position:absolute !important; z-index:45; inset:58px 0 0 auto; width:min(620px,100%); max-width:100%; overflow:auto; padding:26px !important; background:var(--lux-panel) !important; border-left:1px solid var(--lux-border) !important; box-shadow:-12px 0 45px rgba(0,0,0,.08); color:var(--lux-text) !important; }
    [data-luxvm-settings] input,[data-luxvm-settings] textarea,[data-luxvm-settings] select { border:1px solid var(--lux-border) !important; border-radius:9px !important; background:var(--lux-main) !important; color:var(--lux-text) !important; }
    [data-luxvm-settings] label { color:var(--lux-text) !important; }
    [data-luxvm-search] { background:rgba(0,0,0,.48) !important; }
    .luxvm-search-panel { background:var(--lux-panel) !important; color:var(--lux-text) !important; border-color:var(--lux-border) !important; }
    .luxvm-search-panel input { color:var(--lux-text) !important; }
    [data-luxvm-coming-soon] { left:0 !important; top:58px !important; background:var(--lux-main) !important; color:var(--lux-text) !important; }
    [data-luxvm-coming-soon] h1 { color:var(--lux-text) !important; }
    [data-luxvm-coming-soon] p { color:var(--lux-muted) !important; }
    [data-luxvm-coming-soon] button { border-color:var(--lux-border) !important; color:var(--lux-text) !important; }
    .luxvm-sidebar-backdrop { display:none; }
    @media (max-width:760px) {
      [data-luxvm-sidebar] { position:fixed !important; inset:0 auto 0 0; z-index:90 !important; width:min(280px,86vw) !important; min-width:min(280px,86vw) !important; height:100dvh; box-shadow:12px 0 35px rgba(0,0,0,.18); }
      [data-luxvm-sidebar][data-collapsed="true"] { transform:translateX(-110%); }
      [data-luxvm-sidebar][data-collapsed="false"] { transform:translateX(0); }
      .luxvm-sidebar-backdrop { display:block; position:fixed; inset:0; z-index:80; border:0; background:rgba(0,0,0,.35); }
      [data-luxvm-main] { width:100%; }
      [data-luxvm-main] > header { height:54px; min-height:54px; padding:0 12px !important; }
      [data-luxvm-main] > header strong { font-size:13px !important; }
      [data-luxvm-chat-area] { padding:25px 15px 18px !important; }
      [data-luxvm-chat-area] [data-luxvm-message="user"] { max-width:90% !important; }
      [data-luxvm-chat-composer] { width:calc(100% - 22px) !important; margin:0 11px 12px !important; }
      [data-luxvm-settings] { inset:54px 0 0 0; width:100%; padding:20px !important; }
      [data-luxvm-coming-soon] { inset:54px 0 0 0 !important; }
      .luxvm-welcome { padding:20px 0 36px; }
      .luxvm-welcome h1 { font-size:27px; }
    }
  `}</style>

  return (
    <div data-luxvm-theme={theme} style={styles.appContainer}>
      {globalStyle}
      <aside data-luxvm-sidebar data-collapsed={sidebarCollapsed} style={{ ...styles.sidebar, ...(sidebarCollapsed ? styles.sidebarCollapsed : {}) }}>
        <div className="luxvm-sidebar-brand" style={styles.sidebarBrand}>
          {!sidebarCollapsed && <><span className="luxvm-brand-dot" style={styles.dot} /><strong>LuxVM</strong></>}
          <button type="button" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} className="luxvm-sidebar-toggle" style={styles.sidebarToggle}>{sidebarCollapsed ? '›' : '‹'}</button>
        </div>
        <nav data-luxvm-sidebar-nav style={styles.navMenu}>
          <button type="button" title="New Chat" aria-label="New Chat" onClick={createNewChat} style={styles.navBtn}><span className="luxvm-nav-icon" style={styles.navIcon}>+</span>{!sidebarCollapsed && 'New'}</button>
          <button type="button" title="General Chat" aria-label="General Chat" onClick={() => { setActiveTab('chat'); setComingSoonPage('') }} style={{ ...styles.navBtn, ...(activeTab === 'chat' ? styles.navBtnActive : {}) }}><span style={styles.navIcon}>⌕</span>{!sidebarCollapsed && 'General Chat'}</button>
          <button type="button" title="Codex Studio" aria-label="Codex Studio" onClick={() => { setActiveTab('codex'); setComingSoonPage('') }} style={{ ...styles.navBtn, ...(activeTab === 'codex' ? styles.navBtnActive : {}) }}><span style={styles.navIcon}>⌘</span>{!sidebarCollapsed && 'Codex Studio'}</button>
          <button type="button" title="Chess Bot" aria-label="Chess Bot" onClick={() => { setActiveTab('chess'); setComingSoonPage('') }} style={{ ...styles.navBtn, ...(activeTab === 'chess' ? styles.navBtnActive : {}) }}><span style={styles.navIcon}>♙</span>{!sidebarCollapsed && 'Chess Bot'}</button>
          <button type="button" title="Images" aria-label="Images" onClick={() => { setComingSoonPage(''); setActiveTab('image') }} style={{ ...styles.navBtn, ...(activeTab === 'image' ? styles.navBtnActive : {}) }}><span style={styles.navIcon}>▧</span>{!sidebarCollapsed && 'Images'}</button>
          <button type="button" title="Explore" aria-label="Explore" onClick={() => setComingSoonPage('Explore')} style={styles.navBtn}><span style={styles.navIcon}>⌕</span>{!sidebarCollapsed && 'Explore'}</button>
          <button type="button" title="Apps" aria-label="Apps" onClick={() => setComingSoonPage('Apps')} style={styles.navBtn}><span style={styles.navIcon}>▦</span>{!sidebarCollapsed && 'Apps'}</button>
          <button type="button" title="GPTs" aria-label="GPTs" onClick={() => setComingSoonPage('GPTs')} style={styles.navBtn}><span style={styles.navIcon}>✧</span>{!sidebarCollapsed && 'GPTs'}</button>
          <button type="button" title="Scheduled tasks" aria-label="Scheduled tasks" onClick={() => setComingSoonPage('Scheduled tasks')} style={styles.navBtn}><span style={styles.navIcon}>◷</span>{!sidebarCollapsed && 'Scheduled tasks'}</button>
          <button type="button" title="Library" aria-label="Library" onClick={() => setComingSoonPage('Library')} style={styles.navBtn}><span style={styles.navIcon}>▤</span>{!sidebarCollapsed && 'Library'}</button>
          <button type="button" title="Plugins" aria-label="Plugins" onClick={() => setComingSoonPage('Plugins')} style={styles.navBtn}><span style={styles.navIcon}>⌘</span>{!sidebarCollapsed && 'Plugins'}</button>
          <button type="button" title="Projects" aria-label="Projects" onClick={() => setComingSoonPage('Projects')} style={styles.navBtn}><span style={styles.navIcon}>▣</span>{!sidebarCollapsed && 'Projects'}</button>
          <button type="button" title="Search chats" aria-label="Search chats" onClick={() => { setSearchOpen(true); setSearchQuery(''); setComingSoonPage('') }} style={styles.navBtn}><span style={styles.navIcon}>⌕</span>{!sidebarCollapsed && 'Search chats'}</button>
          <button type="button" title="Settings" aria-label="Settings" onClick={() => { setShowSettings(true); setComingSoonPage('') }} style={styles.navBtn}><span style={styles.navIcon}>⚙</span>{!sidebarCollapsed && 'Settings'}</button>
        </nav>
        {!sidebarCollapsed && <>
          <div className="luxvm-sidebar-divider" style={styles.divider} />
          <div className="luxvm-sidebar-header" style={styles.sidebarHeader}><button type="button" onClick={createNewChat} style={styles.newChatBtn}>+ New Chat</button></div>
          <div data-luxvm-session-list style={styles.sessionList}>
            {sessions.map((session) => (
              <div className="luxvm-session-item" key={session.id} onClick={() => { setActiveSessionId(session.id); setActiveTab('chat'); setComingSoonPage('') }} style={{ ...styles.sessionItem, backgroundColor: activeTab === 'chat' && session.id === activeSessionId ? '#E5E1D8' : 'transparent' }}>
                <span className="luxvm-session-title" style={styles.sessionTitle}>{session.title}</span>
                <button className="luxvm-session-delete" type="button" onClick={(e) => deleteSession(session.id, e)} style={styles.deleteBtn} title="Delete Chat">×</button>
              </div>
            ))}
          </div>
        </>}
      </aside>

      <div data-luxvm-main style={styles.mainContent}>
        <header style={styles.header}>
          <div style={styles.brand}>
            {sidebarCollapsed && <button type="button" onClick={() => setSidebarCollapsed(false)} aria-label="Expand sidebar" title="Expand sidebar" style={styles.headerMenuBtn}>☰</button>}
            <strong>
              {activeTab === 'chat' && ' General Chat'}
              {activeTab === 'codex' && ' Codex Code Studio'}
              {activeTab === 'chess' && ' Grandmaster Chess Bot'}
              {activeTab === 'image' && ' Image Generation Studio'}
            </strong>
            {activeTab === 'chat' ? (
              <select aria-label="Chat model" value={models.chat} onChange={(e) => setModels((current) => ({ ...current, chat: e.target.value }))} style={{ ...styles.input, width: 'auto', maxWidth: 'min(42vw, 280px)', padding: '7px 10px', borderRadius: '9px', fontSize: '12px' }}>
                {[...new Set([models.chat, DEFAULT_MODELS.chat, DEFAULT_MODELS.voice, DEFAULT_MODELS.codex, DEFAULT_MODELS.image].filter(Boolean))].map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
            ) : <span style={styles.badge}>{models[activeTab]}</span>}
          </div>
          <div style={styles.actions}>
            <button
              type="button"
              onClick={() => setShowSettings(!showSettings)}
              style={styles.primaryBtn}
            >
              {showSettings ? 'Close Settings' : ' Settings'}
            </button>
          </div>
        </header>

        {showSettings && (
          <div data-luxvm-settings style={styles.settingsPanel}>
            <h3 style={{ margin: '0 0 5px 0', fontSize: '20px', fontWeight: 650, letterSpacing: '-0.025em' }}>
              Settings
            </h3>
            <p style={{ margin: '0 0 18px', fontSize: '13px', color: '#777E87' }}>
              Customize your LuxVM experience
            </p>
            <div style={{ ...styles.fieldRow, marginBottom: '16px' }}>
              <label style={styles.label}>Appearance</label>
              <div role="group" aria-label="Color theme" style={{ display: 'flex', gap: '8px' }}>
                <button type="button" data-theme-choice aria-pressed={theme === 'light'} onClick={() => setTheme('light')} style={{ ...styles.secondaryBtn, background: theme === 'light' ? '#E5E1D8' : 'transparent', border: '1px solid #D8D2C7' }}>Light mode</button>
                <button type="button" data-theme-choice aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')} style={{ ...styles.secondaryBtn, background: theme === 'dark' ? '#343A42' : 'transparent', color: theme === 'dark' ? '#FFFFFF' : '#292824', border: '1px solid #D8D2C7' }}>Dark mode</button>
              </div>
              <span style={{ display: 'block', fontSize: '11px', color: '#777168', marginTop: '6px' }}>Text automatically switches to white in dark mode and black in light mode.</span>
            </div>

            {window.luxvmUpdater && (
            <div style={{ ...styles.fieldRow, padding: '12px', border: '1px solid #D8D2C7', borderRadius: '8px', background: '#F0EEE8' }}>
              <label style={styles.label}>LuxVM Updates</label>
              <div style={{ fontSize: '12px', color: '#57534D', marginBottom: '10px' }} role="status">{updateStatus}</div>
              {updateProgress > 0 && updateProgress < 100 && (
                <div style={{ height: '5px', background: '#E5E1D8', borderRadius: '5px', overflow: 'hidden', marginBottom: '10px' }}>
                  <div style={{ width: `${updateProgress}%`, height: '100%', background: '#C66A4A' }} />
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button type="button" onClick={checkForLuxVMUpdates} style={styles.secondaryBtn}>Check for updates</button>
                {updateStatus.startsWith('Update ') && updateStatus.includes('available') && (
                  <button type="button" onClick={downloadLuxVMUpdate} style={styles.secondaryBtn}>Download update</button>
                )}
                {updateStatus.includes('ready to install') && (
                  <button type="button" onClick={installLuxVMUpdate} style={styles.primaryBtn}>Restart and install</button>
                )}
              </div>
              <span style={{ display: 'block', fontSize: '11px', color: '#777168', marginTop: '8px' }}>Updates download from the public LuxVM releases repository. Your chats and settings remain stored locally.</span>
            </div>
            )}

            <div style={styles.fieldRow}>
              <label style={styles.label}>Global OpenRouter API Key (sk-or-...)</label>
              <input
                style={styles.input}
                type="password"
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setApiStatus('') }}
                placeholder="sk-or-v1-..."
                autoComplete="off"
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' }}>
                <button type="button" onClick={testOpenRouterConnection} style={styles.secondaryBtn} disabled={isTestingApi || !apiKey.trim()}>{isTestingApi ? 'Testing…' : 'Test OpenRouter connection'}</button>
                {apiStatus && <span role="status" style={{ fontSize: '12px', color: apiStatus.startsWith('Connection successful') ? '#A8B99A' : '#D49A83' }}>{apiStatus}</span>}
              </div>
            </div>

            <div style={{ ...styles.fieldRow, marginTop: '10px' }}>
              <label style={styles.label}>GitHub Repository (owner/repository)</label>
              <input style={styles.input} value={githubRepo} onChange={(e) => setGithubRepo(e.target.value)} placeholder="owner/repository" />
            </div>
            <div style={styles.fieldRow}>
              <label style={styles.label}>GitHub Personal Access Token</label>
              <input style={styles.input} type="password" value={githubToken} onChange={(e) => setGithubToken(e.target.value)} placeholder="github_pat_..." autoComplete="off" />
              <span style={{ fontSize: '11px', color: '#777168' }}>Kept in memory only for this app session; it is not saved with your settings. Use a fine-grained token limited to this repository with Contents: Read and write.</span>
            </div>

            <div style={styles.grid2}>
              <div>
                <label style={styles.label}>Chat Model</label>
                <input
                  style={styles.input}
                  value={models.chat}
                  onChange={(e) =>
                    setModels({ ...models, chat: e.target.value })
                  }
                />
              </div>
              <div>
                <label style={styles.label}>Math Model (optional, blank uses Chat Model)</label>
                <input
                  style={styles.input}
                  value={models.math || ''}
                  onChange={(e) => setModels({ ...models, math: e.target.value })}
                  placeholder="e.g. provider/model-id"
                />
              </div>
              <div>
                <label style={styles.label}>Voice Assistant Model</label>
                <input
                  style={styles.input}
                  value={models.voice}
                  onChange={(e) => setModels({ ...models, voice: e.target.value })}
                />
              </div>
              <div>
                <label style={styles.label}>Codex Studio Model</label>
                <input
                  style={styles.input}
                  value={models.codex}
                  onChange={(e) => setModels({ ...models, codex: e.target.value })}
                />
              </div>
              <div>
                <label style={styles.label}>Image Studio Model</label>
                <input
                  style={styles.input}
                  value={models.image}
                  onChange={(e) => setModels({ ...models, image: e.target.value })}
                />
              </div>
            </div>

            <div style={{ ...styles.fieldRow, marginTop: '10px' }}>
              <label style={styles.label}>Image generation provider</label>
              <select style={styles.input} value={imageProvider} onChange={(e) => setImageProvider(e.target.value as 'openrouter' | 'cloudflare')}>
                <option value="openrouter">OpenRouter</option>
                <option value="cloudflare">Cloudflare FLUX.2 Klein 4B</option>
              </select>
              <label style={{ ...styles.label, marginTop: '10px' }}>Cloudflare Worker URL</label>
              <input style={styles.input} value={cloudflareWorkerUrl} onChange={(e) => setCloudflareWorkerUrl(e.target.value)} placeholder="https://luxvm-flux.your-subdomain.workers.dev" />
              <label style={{ ...styles.label, marginTop: '10px' }}>Cloudflare Worker access key</label>
              <input style={styles.input} type="password" value={cloudflareAccessKey} onChange={(e) => setCloudflareAccessKey(e.target.value)} placeholder="Your private Worker access key" autoComplete="off" />
              <span style={{ fontSize: '11px', color: '#777168' }}>The Cloudflare API token stays on the Worker and is never embedded in LuxVM.</span>
            </div>
            <div style={{ ...styles.fieldRow, marginTop: '10px' }}>
              <label style={styles.label}>Permanent Personality / System Prompt</label>
              <textarea
                data-personality-prompt aria-label="Permanent Personality / System Prompt" style={{ ...styles.input, minHeight: '220px', height: '32vh', maxHeight: '48vh', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.55, padding: '12px 14px' }}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
              />
            </div>

            {activeTab === 'chat' && currentSession && (
              <div style={{ ...styles.fieldRow, marginTop: '10px' }}>
                <label style={styles.label}>Memory for this chat only</label>
                <textarea
                  style={{ ...styles.input, minHeight: '58px', resize: 'vertical', fontFamily: 'inherit' }}
                  value={currentSession.memory || ''}
                  onChange={(e) => setSessions((prev) => prev.map((session) => session.id === currentSession.id ? { ...session, memory: e.target.value, updatedAt: Date.now() } : session))}
                  placeholder="Facts or preferences LuxVM should retain in this conversation..."
                />
                <span style={{ fontSize: '11px', color: '#777168' }}>Each chat has separate memory. Only details written here or explicitly marked “remember that” are saved as memory.</span>
              </div>
            )}

            <button type="button" onClick={() => setShowSettings(false)} style={styles.primaryBtn}>
              Done
            </button>
          </div>
        )}

        {activeTab === 'chat' && (
          <>
            <main data-luxvm-chat-area style={styles.chatArea}>
              {currentSession?.messages.map((msg) => (
                <div
                  key={msg.id}
                  style={{
                    ...styles.messageRow,
                    justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  }}
                >
                  <div
                    style={{
                      ...styles.bubble,
                      border: 'none', boxShadow: 'none',
                      borderRadius: msg.role === 'user' ? '18px' : '0',
                      padding: msg.role === 'user' ? '12px 18px' : '4px 0',
                      backgroundColor:
                        msg.role === 'user'
                          ? (theme === 'dark' ? '#343A42' : '#292B27')
                          : msg.role === 'system'
                          ? (theme === 'dark' ? '#4A2929' : '#422B27')
                          : 'transparent',
                      color: msg.role === 'user' ? '#FFFFFF' : (theme === 'dark' ? '#F5F6F7' : '#292824'),
                    }}
                    data-luxvm-message={msg.role === 'user' ? 'user' : 'assistant'}
                  >
                    <div className="luxvm-message-meta" style={styles.meta}>
                      <span>{msg.role === 'user' ? 'You' : msg.role === 'system' ? 'System' : 'LuxVM'}</span>
                      <span>{msg.timestamp}</span>
                    </div>
                    <div className="luxvm-message-content" style={styles.content}>{msg.content}</div>
                  </div>
                </div>
              ))}
              {isChatLoading && (
                <div style={styles.messageRow}>
                  <div style={{ ...styles.bubble, backgroundColor: 'transparent', color: '#A8A69E' }}>
                    <span style={{ display: 'inline-block', width: '7px', height: '7px', borderRadius: '50%', background: '#C66A4A', marginRight: '9px' }} />
                    Thinking…
                  </div>
                </div>
              )}
              <div ref={chatBottomRef} />
            </main>

            <form data-luxvm-chat-composer onSubmit={sendChatMessage} style={styles.footer}>
              <button type="button" data-composer-tool title="Add files (coming soon)" aria-label="Add files" onClick={() => setComingSoonPage('Attachments')}>＋</button>
              <input style={styles.chatInput} value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="Message LuxVM" disabled={isChatLoading} />
              <button type="button" data-composer-tool data-microphone aria-label={isListening ? 'Stop microphone' : 'Use microphone'} title={isListening ? 'Stop listening' : 'Dictate a message'} onClick={toggleMicrophone} style={{ background: isListening ? '#C66A4A' : undefined, color: isListening ? '#fff' : undefined }}>◉</button>
              <button type="submit" style={styles.sendBtn} disabled={isChatLoading || !chatInput.trim()}>↑</button>
            </form>
          </>
        )}

        {activeTab === 'voice' && (
          <>
            <div data-luxvm-surface style={styles.voiceTopBar}>
              <button
                type="button"
                onClick={toggleMicrophone}
                style={{
                  ...styles.micBtn,
                  backgroundColor: isListening ? '#dc2626' : '#C66A4A',
                }}
              >
                {isListening ? ' Listening... (Click to Stop)' : ' Speak to Voice Assistant'}
              </button>
              <label style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={autoSpeak}
                  onChange={(e) => setAutoSpeak(e.target.checked)}
                />
                Auto-Speak Replies (TTS)
              </label>
              <button
                type="button"
                onClick={() => window.speechSynthesis?.cancel()}
                style={styles.secondaryBtn}
              >
                 Mute Voice
              </button>
            </div>

            <main style={styles.chatArea}>
              {voiceHistory.map((msg) => (
                <div
                  key={msg.id}
                  style={{
                    ...styles.messageRow,
                    justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  }}
                >
                  <div
                    style={{
                      ...styles.bubble,
                      backgroundColor:
                        msg.role === 'user'
                          ? '#C66A4A'
                          : msg.role === 'system'
                          ? '#7f1d1d'
                          : '#F0EEE8',
                    }}
                  >
                    <div style={styles.meta}>
                      <span>{msg.role === 'user' ? 'You' : 'Voice Assistant'}</span>
                      <span>{msg.timestamp}</span>
                    </div>
                    <div style={styles.content}>{msg.content}</div>
                  </div>
                </div>
              ))}
              {isVoiceLoading && (
                <div style={styles.messageRow}>
                  <div style={{ ...styles.bubble, backgroundColor: '#F0EEE8', opacity: 0.8 }}>
                    Processing voice response...
                  </div>
                </div>
              )}
            </main>

            <form
              onSubmit={(e) => {
                e.preventDefault()
                sendVoicePrompt(voiceInput)
              }}
              style={styles.footer}
            >
              <input
                style={styles.chatInput}
                value={voiceInput}
                onChange={(e) => setVoiceInput(e.target.value)}
                placeholder="Or type a message..."
                disabled={isVoiceLoading}
              />
              <button type="submit" style={styles.sendBtn} disabled={isVoiceLoading || !voiceInput.trim()}>
                Speak / Send
              </button>
            </form>
          </>
        )}

        {activeTab === 'codex' && (
          <div style={styles.codexContainer}>
            <form data-luxvm-surface onSubmit={generateCode} style={styles.codexLeft}>
              <label style={styles.label}>Target Language / Stack</label>
              <select
                style={styles.input}
                value={codexLang}
                onChange={(e) => setCodexLang(e.target.value)}
              >
                <option>TypeScript / React</option>
                <option>JavaScript</option>
                <option>Python</option>
                <option>HTML / CSS</option>
                <option>C++</option>
                <option>Rust</option>
              </select>

              <label style={{ ...styles.label, marginTop: '12px' }}>What should Codex build?</label>
              <textarea
                style={{ ...styles.input, flex: 1, resize: 'none', fontFamily: 'inherit', lineHeight: 1.5 }}
                value={codexPrompt}
                onChange={(e) => setCodexPrompt(e.target.value)}
                placeholder="Describe the function, component, script, or algorithm..."
              />

              <button
                type="submit"
                style={{ ...styles.primaryBtn, marginTop: '12px', padding: '10px' }}
                disabled={isCodexLoading || !codexPrompt.trim()}
              >
                {isCodexLoading ? ' Generating Code...' : ' Generate Code'}
              </button>
            </form>

            <div style={styles.codexRight}>
              <div data-luxvm-surface style={styles.codexToolbar}>
                <span style={{ fontSize: '12px', color: '#777168' }}>{codexLang} Output</span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button type="button" onClick={copyCodeToClipboard} style={styles.secondaryBtn}>
                    {copiedCode ? ' Copied!' : ' Copy Code'}
                  </button>
                  <button type="button" onClick={downloadCodeFile} style={styles.secondaryBtn}>
                     Save File
                  </button>
                  <button type="button" onClick={() => { setGithubStatus(''); setShowGithubApproval(true) }} style={styles.secondaryBtn}>
                    Prepare GitHub Update
                  </button>
                </div>
              </div>
              <pre style={styles.codeBlock}>
                <code>{codexOutput}</code>
              </pre>
              {githubStatus && <div style={{ padding: '9px 16px', fontSize: '12px', color: githubStatus.startsWith('Committed') ? '#52664D' : '#8A4938', background: '#FFFFFF' }}>{githubStatus}</div>}
            </div>
          </div>
        )}

        {activeTab === 'chess' && (
          <div data-luxvm-chess style={styles.chessContainer}>
            <div style={styles.chessBoardWrapper}>
              <div style={styles.chessStatusBar}>
                <span>{chessStatus}</span>
                <button type="button" onClick={resetChess} style={styles.secondaryBtn}>
                   New Game
                </button>
              </div>

              <div style={styles.chessBoard}>
                {board.map((row, r) =>
                  row.map((cell, c) => {
                    const isDark = (r + c) % 2 === 1
                    const isSelected = selectedSq?.[0] === r && selectedSq?.[1] === c
                    const isLegalDest = legalTargets.some(([tr, tc]) => tr === r && tc === c)

                    return (
                      <div
                        key={`${r}-${c}`}
                        onClick={() => handleSquareClick(r, c)}
                        style={{
                          ...styles.chessSquare,
                          backgroundColor: isSelected
                            ? '#F6F669'
                            : isDark
                            ? '#769656'
                            : '#EEeed2',
                        }}
                      >
                        {isLegalDest && <div style={styles.legalDot} />}
                        {cell && (
                          <span
                            aria-label={`${isWhitePiece(cell) ? 'White' : 'Black'} ${cell.toUpperCase()}`}
                            style={{
                              ...styles.chessPiece,
                              color: isWhitePiece(cell) ? '#FFFFFF' : '#262421',
                              WebkitTextStroke: isWhitePiece(cell) ? '1.35px #30352B' : '1.15px #F5F0DF',
                              textShadow: isWhitePiece(cell)
                                ? '0 1px 2px rgba(0,0,0,.8)'
                                : '0 1px 2px rgba(255,255,255,.75)',
                            }}
                          >
                            {PIECE_UNICODE[cell]}
                          </span>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            </div>

            <div style={styles.chessSidebar}>
              <h4 style={{ margin: '0 0 10px 0' }}>Move History (UCI)</h4>
              <div style={styles.moveList}>
                {moveHistory.length === 0 ? (
                  <span style={{ color: '#9B988F', fontSize: '13px' }}>No moves yet. You play White.</span>
                ) : (
                  moveHistory.map((m, idx) => (
                    <div key={idx} style={{ fontSize: '13px', padding: '3px 0' }}>
                      {idx % 2 === 0 ? `${Math.floor(idx / 2) + 1}. ` : '   '}
                      <strong>{m}</strong> ({idx % 2 === 0 ? 'You' : 'AI'})
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {searchOpen && (
          <section data-luxvm-search role="dialog" aria-modal="true" aria-label="Search chats">
            <div className="luxvm-search-panel">
              <div className="luxvm-search-heading"><strong>Search chats</strong><button type="button" aria-label="Close search" onClick={() => setSearchOpen(false)}>×</button></div>
              <input autoFocus value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search your conversations..." aria-label="Search conversations" />
              <div className="luxvm-search-results">
                {sessions.filter((session) => !searchQuery.trim() || session.title.toLowerCase().includes(searchQuery.toLowerCase()) || session.messages.some((message) => message.content.toLowerCase().includes(searchQuery.toLowerCase()))).map((session) => (
                  <button type="button" key={session.id} onClick={() => { setActiveSessionId(session.id); setActiveTab('chat'); setComingSoonPage(''); setSearchOpen(false) }}>
                    <strong>{session.title}</strong><span>{session.messages[session.messages.length - 1]?.content.slice(0, 110) || 'Empty conversation'}</span>
                  </button>
                ))}
                {sessions.filter((session) => !searchQuery.trim() || session.title.toLowerCase().includes(searchQuery.toLowerCase()) || session.messages.some((message) => message.content.toLowerCase().includes(searchQuery.toLowerCase()))).length === 0 && <p>No conversations match your search.</p>}
              </div>
            </div>
          </section>
        )}

        {comingSoonPage && (
          <section data-luxvm-coming-soon>
            <div className="luxvm-coming-icon">✦</div>
            <h1>{comingSoonPage}</h1>
            <p>This part of LuxVM is not available yet. We’re preparing it for a future update.</p>
            <span>COMING SOON</span>
            <button type="button" onClick={() => { setComingSoonPage(''); setActiveTab('chat') }}>Back to chat</button>
          </section>
        )}

        {activeTab === 'image' && (
          <div style={styles.imageContainer}>
            <div style={{ padding: '10px 20px 0', fontSize: '12px', color: '#777168' }}>Image provider: <strong>{imageProvider === 'cloudflare' ? 'Cloudflare FLUX.2 Klein 4B' : 'OpenRouter'}</strong></div>
            <form data-luxvm-surface onSubmit={generateImage} style={{ ...styles.imageControls, flexDirection: 'column', alignItems: 'stretch' }}>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ ...styles.secondaryBtn, display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                  Upload reference image
                  <input type="file" accept="image/*" onChange={handleReferenceUpload} disabled={isImageLoading} style={{ display: 'none' }} />
                </label>
                <span style={{ fontSize: '12px', color: '#777168' }}>Or choose “Use as reference” on any image below.</span>
                {referenceImage && (
                  <button type="button" onClick={() => setReferenceImage(null)} style={styles.secondaryBtn} disabled={isImageLoading}>
                    Remove reference
                  </button>
                )}
              </div>
              {referenceImage && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px', border: '1px solid #D8D2C7', borderRadius: '8px', maxWidth: '520px' }}>
                  <img src={referenceImage.url} alt="Selected reference" style={{ width: '76px', height: '76px', objectFit: 'cover', borderRadius: '6px' }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '12px', fontWeight: 600 }}>Editing reference</div>
                    <div style={{ fontSize: '11px', color: '#777168', overflowWrap: 'anywhere' }}>{referenceImage.name}</div>
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  style={{ ...styles.chatInput, flex: 1, minWidth: '220px', border: '1px solid #D8D2C7', borderRadius: '8px' }}
                  value={imagePrompt}
                  onChange={(e) => setImagePrompt(e.target.value)}
                  placeholder={referenceImage ? 'Describe what you want changed in this image...' : 'Describe the image you want to create...'}
                  disabled={isImageLoading}
                />
                <select
                  aria-label="Image aspect ratio"
                  style={{ ...styles.input, width: '125px' }}
                  value={aspectRatio}
                  onChange={(e) => setAspectRatio(e.target.value)}
                  disabled={isImageLoading}
                >
                  <option value="1:1">1:1 Square</option>
                  <option value="16:9">16:9 Wide</option>
                  <option value="9:16">9:16 Tall</option>
                  <option value="4:3">4:3 Photo</option>
                </select>
                <button type="submit" style={styles.sendBtn} disabled={isImageLoading || !imagePrompt.trim()}>
                  {isImageLoading ? (referenceImage ? 'Editing...' : 'Generating...') : (referenceImage ? 'Edit image' : 'Generate')}
                </button>
              </div>
              {referenceImage && (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#57534D', cursor: 'pointer' }}>
                  <input type="checkbox" checked={keepOriginalElements} onChange={(e) => setKeepOriginalElements(e.target.checked)} disabled={isImageLoading} />
                  Keep original elements unless my prompt asks to change them
                </label>
              )}
            </form>

            {imageError && (
              <div role="alert" style={{ padding: '12px 20px', backgroundColor: '#7f1d1d', color: '#FFFFFF', fontSize: '13px' }}>
                {imageError}
              </div>
            )}

            <div data-luxvm-surface style={styles.imageGallery}>
              {generatedImages.length === 0 && !isImageLoading && (
                <div style={{ color: '#777168', textAlign: 'center', marginTop: '60px', gridColumn: '1 / -1' }}>
                  Upload a reference to edit an image, or enter a prompt to create one with {models.image}.
                </div>
              )}
              {generatedImages.map((img) => (
                <div key={img.id} data-luxvm-surface style={styles.imageCard}>
                  <img src={img.url} alt={img.prompt} style={styles.generatedImg} />
                  <div style={styles.imageCardFooter}>
                    <span style={{ fontSize: '12px', color: '#57534D', flex: 1 }}>{img.prompt}</span>
                    <a href={img.url} download={`luxvm-image-${img.id}.png`} style={{ ...styles.secondaryBtn, textDecoration: 'none' }}>
                      Download
                    </a>
                    <button type="button" onClick={() => setReferenceImage({ url: img.url, name: `LuxVM image ${img.id}` })} style={styles.secondaryBtn} disabled={isImageLoading}>
                      Use as reference
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {showGithubApproval && (
        <div style={styles.modalBackdrop} role="presentation">
          <section style={styles.approvalModal} role="dialog" aria-modal="true" aria-labelledby="github-approval-title">
            <h3 id="github-approval-title" style={{ margin: '0 0 8px', fontSize: '16px' }}>Approve GitHub update</h3>
            <p style={{ margin: '0 0 14px', color: '#625C53', fontSize: '13px', lineHeight: 1.5 }}>
              LuxVM is ready to write the generated Codex output to <strong>{githubRepo}</strong> on the <strong>main</strong> branch. Nothing is sent until you approve below.
            </p>
            <label style={styles.label}>Target file path</label>
            <input style={styles.input} value={githubTargetPath} onChange={(e) => setGithubTargetPath(e.target.value)} placeholder="src/App.tsx" />
            <p style={{ margin: '8px 0', color: '#8A4938', fontSize: '11px', lineHeight: 1.45 }}>
              Approval replaces the entire file at this path on main. Choose a complete file, not a partial code snippet.
            </p>
            <label style={styles.label}>Content preview</label>
            <pre style={{ ...styles.codeBlock, flex: 'none', maxHeight: '150px', borderRadius: '6px', padding: '10px', fontSize: '11px' }}>
              {codexOutput.slice(0, 2200)}{codexOutput.length > 2200 ? '\n… preview shortened' : ''}
            </pre>
            <label style={{ ...styles.label, marginTop: '10px' }}>Commit message</label>
            <input style={styles.input} value={githubCommitMessage} onChange={(e) => setGithubCommitMessage(e.target.value)} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '18px' }}>
              <button type="button" onClick={() => setShowGithubApproval(false)} style={styles.secondaryBtn} disabled={isGithubPublishing}>Cancel</button>
              <button type="button" onClick={publishCodexToGithub} style={styles.primaryBtn} disabled={isGithubPublishing}>{isGithubPublishing ? 'Publishing...' : 'Approve and commit'}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  modalBackdrop: {
    position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(35,32,28,.42)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
  },
  approvalModal: {
    width: 'min(520px, 100%)', background: '#F5F4EF', color: '#292824',
    border: '1px solid #E5E1D8', borderRadius: '12px', padding: '22px',
    boxShadow: '0 18px 60px rgba(35,32,28,.22)',
  },
  appContainer: {
    display: 'flex',
    height: '100vh',
    width: '100vw',
    backgroundColor: '#F5F4EF',
    color: '#292824',
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    overflow: 'hidden',
  },
  sidebarCollapsed: { width: '64px', minWidth: '64px' },
  sidebarToggle: { marginLeft: 'auto', width: '30px', height: '30px', border: 'none', borderRadius: '8px', background: 'transparent', color: '#A8ABB2', cursor: 'pointer', fontSize: '22px', lineHeight: 1 },
  headerMenuBtn: { border: 'none', background: 'transparent', color: '#A8ABB2', cursor: 'pointer', fontSize: '18px', marginRight: '12px', padding: '4px 8px' },
  navIcon: { display: 'inline-flex', width: '24px', justifyContent: 'center', alignItems: 'center', marginRight: '10px', fontSize: '17px', fontWeight: 600 },
  sidebar: {
    width: '258px', minWidth: '258px',
    backgroundColor: '#F2F2F2',
    borderRight: '1px solid #E5E5E5',
    transition: 'width 180ms ease, min-width 180ms ease',
    display: 'flex',
    flexDirection: 'column',
  },
  sidebarBrand: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '14px 12px', minHeight: '58px',
    fontSize: '16px',
    borderBottom: '0',
  },
  navMenu: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '10px',
  },
  navBtn: {
    textAlign: 'left',
    backgroundColor: 'transparent',
    color: '#57534D',
    border: 'none',
    padding: '9px 12px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
  },
  navBtnActive: {
    backgroundColor: '#F0EEE8',
    color: '#292824',
    borderLeft: '3px solid #C66A4A',
  },
  divider: {
    height: '1px',
    backgroundColor: '#F0EEE8',
    margin: '4px 0',
  },
  sidebarHeader: {
    padding: '10px',
  },
  newChatBtn: {
    width: '100%',
    backgroundColor: '#C66A4A',
    color: '#FFFFFF',
    border: 'none',
    padding: '8px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: 500,
    fontSize: '12px',
  },
  sessionList: {
    flex: 1,
    overflowY: 'auto',
    padding: '0 10px 10px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  sessionItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '7px 10px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '12px',
    color: '#57534D',
  },
  sessionTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
  },
  deleteBtn: {
    background: 'none',
    border: 'none',
    color: '#777168',
    cursor: 'pointer',
    fontSize: '15px',
    padding: '0 4px',
  },
  mainContent: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 20px',
    backgroundColor: '#F5F4EF',
    borderBottom: '1px solid #E5E1D8',
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    fontSize: '16px',
  },
  dot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    backgroundColor: '#8A8F79',
  },
  badge: {
    fontSize: '11px',
    padding: '3px 8px',
    borderRadius: '12px',
    backgroundColor: '#F5F4EF',
    color: '#777168',
    border: '1px solid #E5E1D8',
  },
  actions: {
    display: 'flex',
    gap: '10px',
  },
  primaryBtn: {
    backgroundColor: '#C66A4A',
    color: '#FFFFFF',
    border: 'none',
    padding: '7px 14px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
  },
  secondaryBtn: {
    backgroundColor: '#E5E1D8',
    color: '#292824',
    border: 'none',
    padding: '6px 12px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '12px',
  },
  settingsPanel: {
    flex: '1 1 auto',
    minHeight: 0,
    maxHeight: 'calc(100vh - 64px)',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    padding: '18px 22px 24px',
    backgroundColor: '#F7F5F0',
    borderBottom: '1px solid #E5E1D8',
  },
  grid2: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '10px',
  },
  fieldRow: {
    marginBottom: '10px',
  },
  label: {
    display: 'block',
    fontSize: '11px',
    color: '#777168',
    marginBottom: '4px',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    borderRadius: '6px',
    border: '1px solid #D8D2C7',
    backgroundColor: '#F0EEE8',
    color: '#292824',
    fontSize: '13px',
  },
  chatArea: {
    flex: 1,
    width: '100%',
    maxWidth: '1040px',
    margin: '0 auto',
    overflowY: 'auto',
    padding: '42px 28px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
  },
  messageRow: {
    display: 'flex',
    width: '100%',
  },
  bubble: {
    maxWidth: 'min(820px, 88%)',
    padding: '12px 16px',
    borderRadius: '14px',
    lineHeight: 1.5,
    fontSize: '14px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  meta: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '16px',
    fontSize: '11px',
    opacity: 0.7,
    marginBottom: '4px',
  },
  content: {
    margin: 0,
  },
  footer: {
    display: 'flex',
    width: '100%',
    maxWidth: '780px',
    margin: '0 auto 24px',
    border: '1px solid #D9DDE2', borderRadius: '18px',
    gap: '10px',
    padding: '10px 12px 10px 18px',
    backgroundColor: '#FFFFFF',
  },
  chatInput: {
    flex: 1,
    padding: '14px 18px',
    borderRadius: '16px',
    border: 'none',
    backgroundColor: 'transparent',
    color: '#292824',
    fontSize: '14px',
    outline: 'none',
  },
  sendBtn: {
    backgroundColor: '#292824',
    color: '#F0EEE8',
    border: 'none',
    padding: '0 20px',
    borderRadius: '8px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '14px',
  },
  voiceTopBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    padding: '12px 20px',
    backgroundColor: '#FFFFFF',
    borderBottom: '1px solid #F0EEE8',
  },
  micBtn: {
    color: '#292824',
    border: 'none',
    padding: '10px 18px',
    borderRadius: '8px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '13px',
  },
  codexContainer: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  codexLeft: {
    width: '320px',
    padding: '16px',
    borderRight: '1px solid #F0EEE8',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#FFFFFF',
  },
  codexRight: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  codexToolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 16px',
    backgroundColor: '#F0EEE8',
    borderBottom: '1px solid #E5E1D8',
  },
  codeBlock: {
    flex: 1,
    margin: 0,
    padding: '16px',
    overflow: 'auto',
    backgroundColor: '#FFFFFF',
    color: '#e2e8f0',
    fontSize: '13px',
    fontFamily: 'Consolas, Monaco, "Courier New", monospace',
    lineHeight: 1.5,
  },
  chessContainer: {
    display: 'flex',
    flex: 1,
    padding: '20px',
    gap: '24px',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'auto',
  },
  chessBoardWrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  chessStatusBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#20211E',
    padding: '10px 14px',
    borderRadius: '8px',
    fontSize: '13px',
    fontWeight: 500,
  },
  chessBoard: {
    display: 'grid',
    gridTemplateColumns: 'repeat(8, 56px)',
    gridTemplateRows: 'repeat(8, 56px)',
    border: '3px solid #536B43',
    borderRadius: '6px',
    overflow: 'hidden',
  },
  chessSquare: {
    width: '56px',
    height: '56px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    position: 'relative',
    userSelect: 'none',
  },
  chessPiece: {
    position: 'relative',
    zIndex: 1,
    display: 'block',
    fontSize: '43px',
    lineHeight: 1,
    fontFamily: '"Segoe UI Symbol", "Noto Sans Symbols 2", "DejaVu Sans", serif',
    fontWeight: 700,
    paintOrder: 'stroke fill',
    pointerEvents: 'none',
  },
  legalDot: {
    position: 'absolute',
    width: '15px',
    height: '15px',
    borderRadius: '50%',
    backgroundColor: 'rgba(28, 74, 28, 0.55)',
    boxShadow: '0 0 0 2px rgba(245, 245, 220, 0.35)',
    pointerEvents: 'none',
  },
  chessSidebar: {
    width: '220px',
    height: '490px',
    backgroundColor: '#20211E',
    borderRadius: '8px',
    padding: '14px',
    display: 'flex',
    flexDirection: 'column',
  },
  moveList: {
    flex: 1,
    overflowY: 'auto',
  },
  imageContainer: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    overflow: 'hidden',
  },
  imageControls: {
    display: 'flex',
    gap: '10px',
    padding: '14px 20px',
    backgroundColor: '#FFFFFF',
    borderBottom: '1px solid #F0EEE8',
  },
  imageGallery: {
    flex: 1,
    overflowY: 'auto',
    padding: '20px',
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: '16px',
    alignContent: 'start',
  },
  imageCard: {
    backgroundColor: '#F0EEE8',
    borderRadius: '10px',
    overflow: 'hidden',
    border: '1px solid #E5E1D8',
  },
  generatedImg: {
    width: '100%',
    display: 'block',
  },
  imageCardFooter: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 12px',
  },
}
