
import React, { useState, useEffect, useRef } from 'react'
import { evaluate as mathEvaluate, derivative as mathDerivative, simplify as mathSimplify } from 'mathjs'

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


type ResponseTier = 'quick' | 'standard' | 'deep'

// LuxVM does not impose a small output ceiling on demanding questions.
// The selected model/provider still controls its actual context and output limits.
const DEEP_RESPONSE_TOKEN_CEILING = 200000

function isMathPrompt(prompt: string): boolean {
  return /\b(math|mathematics|calculate|compute|equation|solve|proof|prove|derivative|differentiate|integral|integrate|limit|matrix|determinant|eigenvalue|probability|statistics|calculus|algebra|geometry|trigonometry|factor|simplify|polynomial|exponent|exponential|power|raised to|squared|cubed)\b|\d\s*(?:\^|\*\*|×|÷|\/|\+|-)\s*\d/i.test(prompt)
}

function classifyResponseTier(prompt: string): ResponseTier {
  const value = prompt.trim().toLowerCase()
  const complexSignals = /\b(prove|derive|debug|architect|design|compare|evaluate|analy[sz]e|step[- ]by[- ]step|multi[- ]step|in depth|deep dive|optimi[sz]e|algorithm|proof|theorem|differential|integral|matrix|recursion|trade-?offs|raised to|exponent|exponential|power|factorial|summation|series)\b/
  const mathematicalExpression = /\d\s*(?:\^|\*\*|×|÷|\/|\+|-)\s*\d/.test(value)
  if (isMathPrompt(value) && (complexSignals.test(value) || mathematicalExpression || value.length > 120)) return 'deep'
  if (complexSignals.test(value) || value.length > 650 || (value.match(/\n/g) || []).length >= 3) return 'deep'
  if (/^(what is|what's|whats|who is|when did|where is|define|how many|how much)\b/.test(value) && value.length < 140) return 'quick'
  if (value.length < 90 && !/[;{}]/.test(value) && !isMathPrompt(value)) return 'quick'
  return 'standard'
}

function getResponseBudget(prompt: string): number {
  return classifyResponseTier(prompt) === 'deep' ? DEEP_RESPONSE_TOKEN_CEILING : 2048
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

  const explicit = trimmed.match(/(?:calculate|compute|evaluate|solve|what is|what's|whats|how much is)\s+(.+?)[?.!]*$/i)
  const direct = /^[\d.\s()+\-*/%^a-z,]+$/i.test(trimmed) ? trimmed : null
  const candidate = (explicit?.[1] || direct || '').replace(/[?=]+$/g, '').trim()
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

function boardToFen(board: Board, turn: 'w' | 'b'): string {
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
  return `${rows.join('/')} ${turn} KQkq - 0 1`
}

function getPseudoLegalMoves(board: Board, r: number, c: number): [number, number][] {
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

function getAllLegalMoves(board: Board, whiteTurn: boolean): string[] {
  const legalUcis: string[] = []
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c]
      if (!p) continue
      if (whiteTurn ? isWhitePiece(p) : isBlackPiece(p)) {
        const dests = getPseudoLegalMoves(board, r, c)
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
  const [showSettings, setShowSettings] = useState(false)
  const [githubRepo, setGithubRepo] = useState<string>(() => safeGetStorage<any>(SETTINGS_KEY, {}).githubRepo || 'RiceCrackerLOL/luxvm-desktop-gpt')
  const [githubToken, setGithubToken] = useState('')
  const [githubTargetPath, setGithubTargetPath] = useState('src/generated-codex-output.txt')
  const [githubCommitMessage, setGithubCommitMessage] = useState('Update LuxVM from Codex Studio')
  const [showGithubApproval, setShowGithubApproval] = useState(false)
  const [isGithubPublishing, setIsGithubPublishing] = useState(false)
  const [githubStatus, setGithubStatus] = useState('')

  const initialSettings = safeGetStorage(SETTINGS_KEY, {
    apiKey: '',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    models: DEFAULT_MODELS,
  })

  const [apiKey, setApiKey] = useState<string>(initialSettings.apiKey || '')
  const [systemPrompt, setSystemPrompt] = useState<string>(
    initialSettings.systemPrompt || DEFAULT_SYSTEM_PROMPT
  )
  const [models, setModels] = useState<ModelConfig>({
    ...DEFAULT_MODELS,
    ...(initialSettings.models || {}),
  })

  useEffect(() => {
    safeSetStorage(SETTINGS_KEY, {
      apiKey: apiKey.trim(),
      systemPrompt: systemPrompt.trim(),
      models,
      githubRepo: githubRepo.trim(),
    })
  }, [apiKey, systemPrompt, models, githubRepo])

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
          max_tokens: 64,
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
    const savedId = localStorage.getItem(ACTIVE_SESSION_KEY)
    if (savedId && sessions.some((s) => s.id === savedId)) return savedId
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
    localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId)
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
    const responseTierForTimeout = classifyResponseTier(trimmed)\n    const requestTimeoutMs = responseTierForTimeout === 'deep' ? 10 * 60 * 1000 : 90 * 1000\n    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs)

    try {
      if (!apiKey.trim()) {
        throw new Error('Missing OpenRouter API Key. Click  Settings in the top right to paste it.')
      }

      const chatMemory = updateSessionMemory(currentSession.memory, updatedMessages)
      const calculatorContext = getCalculatorContext(trimmed)
      const responseTier = classifyResponseTier(trimmed)
      const mathQuestion = isMathPrompt(trimmed)
      const outboundMessages = [
        ...(systemPrompt.trim() ? [{ role: 'system' as const, content: systemPrompt.trim() }] : []),
        ...(chatMemory ? [{ role: 'system' as const, content: 'Memory saved for this chat only:\n' + chatMemory }] : []),
        ...(calculatorContext ? [{ role: 'system' as const, content: calculatorContext }] : []),
        { role: 'system' as const, content: mathQuestion ? 'Mathematics mode: solve accurately, verify intermediate calculations, check units and edge cases, and distinguish exact answers from numerical approximations. Use concise working for routine problems and a clear rigorous derivation for difficult ones. Never invent a calculator result.' : responseTier === 'quick' ? 'This is a straightforward request. Answer accurately and directly in the fewest useful words. Do not over-explain.' : responseTier === 'deep' ? 'This is a demanding request. Take the time needed to reason carefully, verify steps, and explain the important details.' : 'Use a balanced level of detail appropriate to the request.' },
        ...updatedMessages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(-40)
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
          max_completion_tokens: getResponseBudget(trimmed),
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
              .slice(-10)
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
        sendVoicePrompt(transcript)
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
      const allWhiteMoves = getAllLegalMoves(board, true)
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

      const blackLegalMoves = getAllLegalMoves(afterPlayerBoard, false)
      if (blackLegalMoves.length === 0) {
        setChessStatus(
          isKingInCheck(afterPlayerBoard, false)
            ? 'Checkmate! You win! '
            : 'Stalemate! Draw.'
        )
        return
      }

      setIsChessThinking(true)
      setChessStatus('LuxVM Chess Bot is calculating...')

      try {
        let chosenUci = blackLegalMoves[Math.floor(Math.random() * blackLegalMoves.length)]

        if (apiKey.trim()) {
          const fen = boardToFen(afterPlayerBoard, 'b')
          const res = await fetch(OPENROUTER_CHAT_URL, {
            method: 'POST',
            headers: openRouterHeaders(),
            body: JSON.stringify({
              model: models.chess,
              messages: [
                {
                  role: 'system',
                  content:
                    'You are a strong chess engine assistant playing Black. Choose one move only from the supplied legal-move list. Evaluate king safety, checks, captures, material, development, and immediate threats. Never invent a move. Return exactly one UCI move (for example e7e5), with no explanation or punctuation.',
                },
                {
                  role: 'user',
                  content: `Current FEN: ${fen}\nMove history: ${nextHistory.join(' ')}\nLegal moves for Black: ${blackLegalMoves.join(', ')}\nChoose the strongest move from the legal moves list:`,
                },
              ],
            }),
          })

          if (res.ok) {
            const data = await res.json()
            const rawReply = extractOpenRouterText(data, '').toLowerCase().trim()
            const candidate = rawReply.match(/\b[a-h][1-8][a-h][1-8][qrbn]?\b/)?.[0]
            if (candidate && blackLegalMoves.includes(candidate)) chosenUci = candidate
          }
        }

        const aiParsed = uciToCoords(chosenUci)!
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

        const whiteLegalAfter = getAllLegalMoves(afterAiBoard, true)
        if (whiteLegalAfter.length === 0) {
          setChessStatus(
            isKingInCheck(afterAiBoard, true)
              ? `Checkmate! LuxVM wins with ${chosenUci}.`
              : 'Stalemate! Draw.'
          )
        } else if (isKingInCheck(afterAiBoard, true)) {
          setChessStatus(`AI played ${chosenUci}. Check! Your turn.`)
        } else {
          setChessStatus(`AI played ${chosenUci}. Your turn (White).`)
        }
      } catch {
        setChessStatus('AI move error. Reset or try again.')
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

  const generateImage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!imagePrompt.trim() || isImageLoading) return

    setIsImageLoading(true)
    setImageError('')

    try {
      if (!apiKey.trim()) throw new Error('Please enter your OpenRouter API key in  Settings.')

      const res = await fetch(OPENROUTER_IMAGE_URL, {
        method: 'POST',
        headers: openRouterHeaders(),
        body: JSON.stringify({
          model: models.image,
          prompt: imagePrompt.trim(),
          aspect_ratio: aspectRatio,
        }),
      })

      const rawText = await res.text()
      if (!res.ok) {
        throw new Error(getOpenRouterError(rawText, res.status))
      }

      const data = JSON.parse(rawText)
      const item = data?.data?.[0]
      let imgUrl = ''
      if (item?.b64_json) {
        imgUrl = `data:image/png;base64,${item.b64_json}`
      } else if (item?.url) {
        imgUrl = item.url
      } else {
        throw new Error('No image data returned by model.')
      }

      setGeneratedImages((prev) => [
        {
          id: String(Date.now()),
          prompt: imagePrompt.trim(),
          url: imgUrl,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
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
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-synthesis: none; text-rendering: optimizeLegibility; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #111210; color: #E8E6E0; }
    button, input, textarea, select { font: inherit; }
    button { transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease, box-shadow 160ms ease, transform 160ms ease; }
    button:hover { filter: brightness(.97); }
    button:active { transform: translateY(1px); }
    button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid #A65F43; outline-offset: 2px; }
    input, textarea, select { transition: border-color 160ms ease, box-shadow 160ms ease; }
    input:focus, textarea:focus, select:focus { border-color: #A65F43 !important; box-shadow: 0 0 0 3px rgba(166,95,67,.12); }
    ::selection { background: rgba(166,95,67,.18); }
    ::-webkit-scrollbar { width: 9px; height: 9px; }
    ::-webkit-scrollbar-thumb { background: #41423D; border: 2px solid #111210; border-radius: 20px; }
    ::-webkit-scrollbar-track { background: transparent; }
    @media (max-width: 760px) { [data-luxvm-sidebar] { width: 196px !important; min-width: 196px !important; } }
    @media (max-width: 560px) { [data-luxvm-sidebar] { width: 176px !important; min-width: 176px !important; } }
  `}</style>

  return (
    <div style={styles.appContainer}>
      {globalStyle}
      <aside data-luxvm-sidebar style={styles.sidebar}>
        <div style={styles.sidebarBrand}>
          <span style={styles.dot} />
          <strong>LuxVM Studio</strong>
        </div>

        <nav style={styles.navMenu}>
          <button
            type="button"
            onClick={() => setActiveTab('chat')}
            style={{ ...styles.navBtn, ...(activeTab === 'chat' ? styles.navBtnActive : {}) }}
          >
             General Chat
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('voice')}
            style={{ ...styles.navBtn, ...(activeTab === 'voice' ? styles.navBtnActive : {}) }}
          >
             Voice Assistant
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('codex')}
            style={{ ...styles.navBtn, ...(activeTab === 'codex' ? styles.navBtnActive : {}) }}
          >
             Codex Studio
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('chess')}
            style={{ ...styles.navBtn, ...(activeTab === 'chess' ? styles.navBtnActive : {}) }}
          >
             Chess Bot
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('image')}
            style={{ ...styles.navBtn, ...(activeTab === 'image' ? styles.navBtnActive : {}) }}
          >
             Image Studio
          </button>
        </nav>

        <div style={styles.divider} />

        <div style={styles.sidebarHeader}>
          <button type="button" onClick={createNewChat} style={styles.newChatBtn}>
            + New Chat Thread
          </button>
        </div>

        <div style={styles.sessionList}>
          {sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => {
                setActiveSessionId(session.id)
                setActiveTab('chat')
              }}
              style={{
                ...styles.sessionItem,
                backgroundColor:
                  activeTab === 'chat' && session.id === activeSessionId ? '#30312D' : 'transparent',
              }}
            >
              <span style={styles.sessionTitle}>{session.title}</span>
              <button
                type="button"
                onClick={(e) => deleteSession(session.id, e)}
                style={styles.deleteBtn}
                title="Delete Chat"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div style={styles.mainContent}>
        <header style={styles.header}>
          <div style={styles.brand}>
            <strong>
              {activeTab === 'chat' && ' General Chat'}
              {activeTab === 'voice' && ' Voice Assistant'}
              {activeTab === 'codex' && ' Codex Code Studio'}
              {activeTab === 'chess' && ' Grandmaster Chess Bot'}
              {activeTab === 'image' && ' Image Generation Studio'}
            </strong>
            <span style={styles.badge}>{models[activeTab]}</span>
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
          <div style={styles.settingsPanel}>
            <h3 style={{ margin: '0 0 10px 0', fontSize: '15px' }}>
              OpenRouter API Key, Models & Personality Memory
            </h3>

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
              <span style={{ fontSize: '11px', color: '#9B988F' }}>Kept in memory only for this app session; it is not saved with your settings. Use a fine-grained token limited to this repository with Contents: Read and write.</span>
            </div>

            <div style={styles.grid2}>
              <div>
                <label style={styles.label}>Chat & Chess Model</label>
                <input
                  style={styles.input}
                  value={models.chat}
                  onChange={(e) =>
                    setModels({ ...models, chat: e.target.value, chess: e.target.value })
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
              <label style={styles.label}>Permanent Personality / System Prompt</label>
              <textarea
                style={{ ...styles.input, height: '60px', resize: 'vertical', fontFamily: 'inherit' }}
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
                <span style={{ fontSize: '11px', color: '#9B988F' }}>Each chat has separate memory. Only details written here or explicitly marked “remember that” are saved as memory.</span>
              </div>
            )}

            <button type="button" onClick={() => setShowSettings(false)} style={styles.primaryBtn}>
              Done
            </button>
          </div>
        )}

        {activeTab === 'chat' && (
          <>
            <main style={styles.chatArea}>
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
                      backgroundColor:
                        msg.role === 'user'
                          ? '#292B27'
                          : msg.role === 'system'
                          ? '#422B27'
                          : 'transparent',
                    }}
                  >
                    <div style={styles.meta}>
                      <span>{msg.role === 'user' ? 'You' : msg.role === 'system' ? 'System' : 'LuxVM'}</span>
                      <span>{msg.timestamp}</span>
                    </div>
                    <div style={styles.content}>{msg.content}</div>
                  </div>
                </div>
              ))}
              {isChatLoading && (
                <div style={styles.messageRow}>
                  <div style={{ ...styles.bubble, backgroundColor: 'transparent', color: '#A8A69E' }}>
                    <span style={{ display: 'inline-block', width: '7px', height: '7px', borderRadius: '50%', background: '#A65F43', marginRight: '9px' }} />
                    Thinking…
                  </div>
                </div>
              )}
              <div ref={chatBottomRef} />
            </main>

            <form onSubmit={sendChatMessage} style={styles.footer}>
              <input
                style={styles.chatInput}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Ask LuxVM anything…"
                disabled={isChatLoading}
              />
              <button type="submit" style={styles.sendBtn} disabled={isChatLoading || !chatInput.trim()}>
                Send
              </button>
            </form>
          </>
        )}

        {activeTab === 'voice' && (
          <>
            <div style={styles.voiceTopBar}>
              <button
                type="button"
                onClick={toggleMicrophone}
                style={{
                  ...styles.micBtn,
                  backgroundColor: isListening ? '#dc2626' : '#A65F43',
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
                          ? '#A65F43'
                          : msg.role === 'system'
                          ? '#7f1d1d'
                          : '#20211E',
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
                  <div style={{ ...styles.bubble, backgroundColor: '#20211E', opacity: 0.8 }}>
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
            <form onSubmit={generateCode} style={styles.codexLeft}>
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
              <div style={styles.codexToolbar}>
                <span style={{ fontSize: '12px', color: '#9B988F' }}>{codexLang} Output</span>
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
              {githubStatus && <div style={{ padding: '9px 16px', fontSize: '12px', color: githubStatus.startsWith('Committed') ? '#52664D' : '#8A4938', background: '#171815' }}>{githubStatus}</div>}
            </div>
          </div>
        )}

        {activeTab === 'chess' && (
          <div style={styles.chessContainer}>
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
                            ? '#A65F43'
                            : isDark
                            ? '#30312D'
                            : '#9B988F',
                          color: cell && isWhitePiece(cell) ? '#E8E6E0' : '#171815',
                        }}
                      >
                        {isLegalDest && <div style={styles.legalDot} />}
                        {cell ? PIECE_UNICODE[cell] : ''}
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

        {activeTab === 'image' && (
          <div style={styles.imageContainer}>
            <form onSubmit={generateImage} style={styles.imageControls}>
              <input
                style={{ ...styles.chatInput, flex: 1 }}
                value={imagePrompt}
                onChange={(e) => setImagePrompt(e.target.value)}
                placeholder="Describe the image you want to create..."
                disabled={isImageLoading}
              />
              <select
                style={{ ...styles.input, width: '110px' }}
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value)}
              >
                <option value="1:1">1:1 Square</option>
                <option value="16:9">16:9 Wide</option>
                <option value="9:16">9:16 Tall</option>
                <option value="4:3">4:3 Photo</option>
              </select>
              <button
                type="submit"
                style={styles.sendBtn}
                disabled={isImageLoading || !imagePrompt.trim()}
              >
                {isImageLoading ? 'Generating...' : ' Generate'}
              </button>
            </form>

            {imageError && (
              <div style={{ padding: '12px 20px', backgroundColor: '#7f1d1d', fontSize: '13px' }}>
                {imageError}
              </div>
            )}

            <div style={styles.imageGallery}>
              {generatedImages.length === 0 && !isImageLoading && (
                <div style={{ color: '#9B988F', textAlign: 'center', marginTop: '60px' }}>
                  Enter a prompt above to generate images using {models.image}
                </div>
              )}
              {generatedImages.map((img) => (
                <div key={img.id} style={styles.imageCard}>
                  <img src={img.url} alt={img.prompt} style={styles.generatedImg} />
                  <div style={styles.imageCardFooter}>
                    <span style={{ fontSize: '12px', color: '#C6C2B8', flex: 1 }}>{img.prompt}</span>
                    <a
                      href={img.url}
                      download={`luxvm-image-${img.id}.png`}
                      style={{ ...styles.secondaryBtn, textDecoration: 'none' }}
                    >
                       Download
                    </a>
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
    width: 'min(520px, 100%)', background: '#111210', color: '#E8E6E0',
    border: '1px solid #30312D', borderRadius: '12px', padding: '22px',
    boxShadow: '0 18px 60px rgba(35,32,28,.22)',
  },
  appContainer: {
    display: 'flex',
    height: '100vh',
    width: '100vw',
    backgroundColor: '#111210',
    color: '#E8E6E0',
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    overflow: 'hidden',
  },
  sidebar: {
    width: '228px',
    backgroundColor: '#171815',
    borderRight: '1px solid #292A26',
    display: 'flex',
    flexDirection: 'column',
  },
  sidebarBrand: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '16px',
    fontSize: '16px',
    borderBottom: '1px solid #20211E',
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
    color: '#C6C2B8',
    border: 'none',
    padding: '9px 12px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
  },
  navBtnActive: {
    backgroundColor: '#20211E',
    color: '#E8E6E0',
    borderLeft: '3px solid #A65F43',
  },
  divider: {
    height: '1px',
    backgroundColor: '#20211E',
    margin: '4px 0',
  },
  sidebarHeader: {
    padding: '10px',
  },
  newChatBtn: {
    width: '100%',
    backgroundColor: '#A65F43',
    color: '#151613',
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
    color: '#C6C2B8',
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
    color: '#9B988F',
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
    backgroundColor: '#111210',
    borderBottom: '1px solid #292A26',
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
    backgroundColor: '#879078',
  },
  badge: {
    fontSize: '11px',
    padding: '3px 8px',
    borderRadius: '12px',
    backgroundColor: '#111210',
    color: '#9B988F',
    border: '1px solid #30312D',
  },
  actions: {
    display: 'flex',
    gap: '10px',
  },
  primaryBtn: {
    backgroundColor: '#A65F43',
    color: '#151613',
    border: 'none',
    padding: '7px 14px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
  },
  secondaryBtn: {
    backgroundColor: '#30312D',
    color: '#E8E6E0',
    border: 'none',
    padding: '6px 12px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '12px',
  },
  settingsPanel: {
    padding: '16px 20px',
    backgroundColor: '#191A17',
    borderBottom: '1px solid #292A26',
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
    color: '#9B988F',
    marginBottom: '4px',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    borderRadius: '6px',
    border: '1px solid #41423D',
    backgroundColor: '#20211E',
    color: '#E8E6E0',
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
    maxWidth: '940px',
    margin: '0 auto',
    borderTop: 'none',
    gap: '10px',
    padding: '14px 20px 22px',
    backgroundColor: '#111210',
  },
  chatInput: {
    flex: 1,
    padding: '14px 18px',
    borderRadius: '16px',
    border: '1px solid #41423D',
    backgroundColor: '#20211E',
    color: '#E8E6E0',
    fontSize: '14px',
    outline: 'none',
  },
  sendBtn: {
    backgroundColor: '#E8E6E0',
    color: '#20211E',
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
    backgroundColor: '#171815',
    borderBottom: '1px solid #20211E',
  },
  micBtn: {
    color: '#E8E6E0',
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
    borderRight: '1px solid #20211E',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#171815',
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
    backgroundColor: '#20211E',
    borderBottom: '1px solid #30312D',
  },
  codeBlock: {
    flex: 1,
    margin: 0,
    padding: '16px',
    overflow: 'auto',
    backgroundColor: '#151613',
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
    border: '3px solid #30312D',
    borderRadius: '6px',
    overflow: 'hidden',
  },
  chessSquare: {
    width: '56px',
    height: '56px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '36px',
    cursor: 'pointer',
    position: 'relative',
    userSelect: 'none',
  },
  legalDot: {
    position: 'absolute',
    width: '14px',
    height: '14px',
    borderRadius: '50%',
    backgroundColor: 'rgba(34, 197, 94, 0.65)',
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
    backgroundColor: '#171815',
    borderBottom: '1px solid #20211E',
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
    backgroundColor: '#20211E',
    borderRadius: '10px',
    overflow: 'hidden',
    border: '1px solid #30312D',
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
