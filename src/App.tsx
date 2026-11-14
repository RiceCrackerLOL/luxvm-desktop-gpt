
import React, { useState, useEffect, useRef } from 'react'

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
  const content = data?.choices?.[0]?.message?.content
  if (typeof content === 'string' && content.trim()) return content.trim()
  if (Array.isArray(content)) {
    const text = content
      .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return fallback
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

function classifyResponseTier(prompt: string): ResponseTier {
  const value = prompt.trim().toLowerCase()
  const complexSignals = /\b(prove|derive|debug|architect|design|compare|evaluate|analy[sz]e|step[- ]by[- ]step|multi[- ]step|in depth|deep dive|optimi[sz]e|algorithm|proof|theorem|differential|integral|matrix|recursion|trade-?offs)\b/
  if (complexSignals.test(value) || value.length > 650 || (value.match(/\n/g) || []).length >= 3) return 'deep'
  if (/^(what is|what's|whats|who is|when did|where is|define|how many|how much)\b/.test(value) && value.length < 140) return 'quick'
  if (value.length < 90 && !/[;{}]/.test(value)) return 'quick'
  return 'standard'
}

function getResponseBudget(prompt: string): number {
  const tier = classifyResponseTier(prompt)
  return tier === 'quick' ? 180 : tier === 'deep' ? 1400 : 650
}

function evaluateMathExpression(source: string): number | null {
  const tokens = source.match(/\s*(?:(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[a-z]+|[()+\-*/%^,])\s*/gi)
  if (!tokens) return null
  const normalized = tokens.map((token) => token.trim()).filter(Boolean)
  if (normalized.join('').toLowerCase() !== source.replace(/\s+/g, '').toLowerCase()) return null
  let index = 0
  const peek = () => normalized[index] || ''
  const take = () => normalized[index++] || ''
  const expression = (): number => {
    let value = term()
    while (peek() === '+' || peek() === '-') {
      const op = take()
      const right = term()
      value = op === '+' ? value + right : value - right
    }
    return value
  }
  const primary = (): number => {
    const token = take()
    if (token === '(') {
      const value = expression()
      if (take() !== ')') throw new Error('Missing closing parenthesis')
      return value
    }
    if (/^(pi|e)$/i.test(token)) return token.toLowerCase() === 'pi' ? Math.PI : Math.E
    if (/^[a-z]+$/i.test(token)) {
      if (take() !== '(') throw new Error('Expected function parentheses')
      const value = expression()
      if (take() !== ')') throw new Error('Missing function parenthesis')
      const fn: Record<string, (n: number) => number> = {
        sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan,
        log: Math.log10, ln: Math.log, round: Math.round, floor: Math.floor, ceil: Math.ceil,
      }
      if (!fn[token.toLowerCase()]) throw new Error('Unknown function')
      return fn[token.toLowerCase()](value)
    }
    const number = Number(token)
    if (!Number.isFinite(number)) throw new Error('Invalid number')
    return number
  }
  const unary = (): number => {
    if (peek() === '+') { take(); return unary() }
    if (peek() === '-') { take(); return -unary() }
    return primary()
  }
  const power = (): number => {
    const left = unary()
    if (peek() === '^') { take(); return left ** power() }
    return left
  }
  const term = (): number => {
    let value = power()
    while (['*', '/', '%'].includes(peek())) {
      const op = take()
      const right = power()
      if ((op === '/' || op === '%') && right === 0) throw new Error('Division by zero')
      value = op === '*' ? value * right : op === '/' ? value / right : value % right
    }
    return value
  }
  try {
    const result = expression()
    if (index !== normalized.length || !Number.isFinite(result)) return null
    return result
  } catch {
    return null
  }
}

function getCalculatorContext(prompt: string): string {
  const trimmed = prompt.trim()
  const explicit = trimmed.match(/(?:calculate|compute|evaluate|solve|what is|what's|whats|how much is)\s+(.+?)[?.!]*$/i)
  const direct = /^[\d.\s()+\-*/%^a-z,]+$/i.test(trimmed) ? trimmed : null
  const candidate = (explicit?.[1] || direct || '').replace(/[?=]+$/g, '').trim()
  if (!candidate || candidate.length > 100) return ''
  const result = evaluateMathExpression(candidate)
  if (result === null) return ''
  return 'Verified local calculator result: ' + candidate + ' = ' + Number(result.toPrecision(12)) + '. Use this result when answering; do not mention an internal calculator unless asked.'
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

  const openRouterHeaders = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey.trim()}`,
    'HTTP-Referer': 'https://luxvm.desktop',
    'X-Title': 'LuxVM Desktop',
  })

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
    const timeoutId = setTimeout(() => controller.abort(), 45000)

    try {
      if (!apiKey.trim()) {
        throw new Error('Missing OpenRouter API Key. Click  Settings in the top right to paste it.')
      }

      const chatMemory = updateSessionMemory(currentSession.memory, updatedMessages)
      const calculatorContext = getCalculatorContext(trimmed)
      const responseTier = classifyResponseTier(trimmed)
      const outboundMessages = [
        ...(systemPrompt.trim() ? [{ role: 'system' as const, content: systemPrompt.trim() }] : []),
        ...(chatMemory ? [{ role: 'system' as const, content: 'Memory saved for this chat only:\n' + chatMemory }] : []),
        ...(calculatorContext ? [{ role: 'system' as const, content: calculatorContext }] : []),
        { role: 'system' as const, content: responseTier === 'quick' ? 'This is a straightforward request. Answer accurately and directly in the fewest useful words. Do not over-explain.' : responseTier === 'deep' ? 'This is a demanding request. Take the time needed to reason carefully, verify steps, and explain the important details.' : 'Use a balanced level of detail appropriate to the request.' },
        ...updatedMessages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(-40)
          .map((m) => ({ role: m.role, content: m.content })),
      ]

      const res = await fetch(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: openRouterHeaders(),
        body: JSON.stringify({
          model: models.chat,
          messages: outboundMessages,
          max_tokens: getResponseBudget(trimmed),
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
                    content: `Error: ${err?.name === 'AbortError' ? 'The request timed out after 45 seconds. Please try again.' : err?.message}`,
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
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-synthesis: none; text-rendering: optimizeLegibility; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #F5F3EE; color: #292825; }
    button, input, textarea, select { font: inherit; }
    button { transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease, box-shadow 160ms ease, transform 160ms ease; }
    button:hover { filter: brightness(.97); }
    button:active { transform: translateY(1px); }
    button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid #A65F43; outline-offset: 2px; }
    input, textarea, select { transition: border-color 160ms ease, box-shadow 160ms ease; }
    input:focus, textarea:focus, select:focus { border-color: #A65F43 !important; box-shadow: 0 0 0 3px rgba(166,95,67,.12); }
    ::selection { background: rgba(166,95,67,.18); }
    ::-webkit-scrollbar { width: 9px; height: 9px; }
    ::-webkit-scrollbar-thumb { background: #CFC8BC; border: 2px solid #F5F3EE; border-radius: 20px; }
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
                  activeTab === 'chat' && session.id === activeSessionId ? '#DED8CE' : 'transparent',
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
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-or-v1-..."
              />
            </div>

            <div style={{ ...styles.fieldRow, marginTop: '10px' }}>
              <label style={styles.label}>GitHub Repository (owner/repository)</label>
              <input style={styles.input} value={githubRepo} onChange={(e) => setGithubRepo(e.target.value)} placeholder="owner/repository" />
            </div>
            <div style={styles.fieldRow}>
              <label style={styles.label}>GitHub Personal Access Token</label>
              <input style={styles.input} type="password" value={githubToken} onChange={(e) => setGithubToken(e.target.value)} placeholder="github_pat_..." autoComplete="off" />
              <span style={{ fontSize: '11px', color: '#777065' }}>Kept in memory only for this app session; it is not saved with your settings. Use a fine-grained token limited to this repository with Contents: Read and write.</span>
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
                <span style={{ fontSize: '11px', color: '#777065' }}>Each chat has separate memory. Only details written here or explicitly marked “remember that” are saved as memory.</span>
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
                          ? '#A65F43'
                          : msg.role === 'system'
                          ? '#7f1d1d'
                          : '#EAE6DE',
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
                  <div style={{ ...styles.bubble, backgroundColor: '#EAE6DE', opacity: 0.8 }}>
                    Thinking...
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
                placeholder={`Message ${models.chat}...`}
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
                          : '#EAE6DE',
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
                  <div style={{ ...styles.bubble, backgroundColor: '#EAE6DE', opacity: 0.8 }}>
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
                <span style={{ fontSize: '12px', color: '#777065' }}>{codexLang} Output</span>
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
              {githubStatus && <div style={{ padding: '9px 16px', fontSize: '12px', color: githubStatus.startsWith('Committed') ? '#52664D' : '#8A4938', background: '#EEEAE2' }}>{githubStatus}</div>}
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
                            ? '#DED8CE'
                            : '#777065',
                          color: cell && isWhitePiece(cell) ? '#292825' : '#EEEAE2',
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
                  <span style={{ color: '#81796E', fontSize: '13px' }}>No moves yet. You play White.</span>
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
                <div style={{ color: '#81796E', textAlign: 'center', marginTop: '60px' }}>
                  Enter a prompt above to generate images using {models.image}
                </div>
              )}
              {generatedImages.map((img) => (
                <div key={img.id} style={styles.imageCard}>
                  <img src={img.url} alt={img.prompt} style={styles.generatedImg} />
                  <div style={styles.imageCardFooter}>
                    <span style={{ fontSize: '12px', color: '#514D46', flex: 1 }}>{img.prompt}</span>
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
    width: 'min(520px, 100%)', background: '#F5F3EE', color: '#292825',
    border: '1px solid #DED8CE', borderRadius: '12px', padding: '22px',
    boxShadow: '0 18px 60px rgba(35,32,28,.22)',
  },
  appContainer: {
    display: 'flex',
    height: '100vh',
    width: '100vw',
    backgroundColor: '#F5F3EE',
    color: '#292825',
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    overflow: 'hidden',
  },
  sidebar: {
    width: '250px',
    backgroundColor: '#EEEAE2',
    borderRight: '1px solid #EAE6DE',
    display: 'flex',
    flexDirection: 'column',
  },
  sidebarBrand: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '16px',
    fontSize: '16px',
    borderBottom: '1px solid #EAE6DE',
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
    color: '#514D46',
    border: 'none',
    padding: '9px 12px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
  },
  navBtnActive: {
    backgroundColor: '#EAE6DE',
    color: '#292825',
    borderLeft: '3px solid #A65F43',
  },
  divider: {
    height: '1px',
    backgroundColor: '#EAE6DE',
    margin: '4px 0',
  },
  sidebarHeader: {
    padding: '10px',
  },
  newChatBtn: {
    width: '100%',
    backgroundColor: '#A65F43',
    color: '#FFFDF9',
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
    color: '#514D46',
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
    color: '#777065',
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
    backgroundColor: '#EAE6DE',
    borderBottom: '1px solid #DED8CE',
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
    backgroundColor: '#F5F3EE',
    color: '#777065',
    border: '1px solid #DED8CE',
  },
  actions: {
    display: 'flex',
    gap: '10px',
  },
  primaryBtn: {
    backgroundColor: '#A65F43',
    color: '#FFFDF9',
    border: 'none',
    padding: '7px 14px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
  },
  secondaryBtn: {
    backgroundColor: '#DED8CE',
    color: '#292825',
    border: 'none',
    padding: '6px 12px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '12px',
  },
  settingsPanel: {
    padding: '16px 20px',
    backgroundColor: '#EAE6DE',
    borderBottom: '1px solid #DED8CE',
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
    color: '#777065',
    marginBottom: '4px',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    borderRadius: '6px',
    border: '1px solid #CFC8BC',
    backgroundColor: '#F5F3EE',
    color: '#292825',
    fontSize: '13px',
  },
  chatArea: {
    flex: 1,
    overflowY: 'auto',
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  messageRow: {
    display: 'flex',
    width: '100%',
  },
  bubble: {
    maxWidth: '75%',
    padding: '12px 16px',
    borderRadius: '12px',
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
    gap: '10px',
    padding: '14px 20px',
    backgroundColor: '#EAE6DE',
    borderTop: '1px solid #DED8CE',
  },
  chatInput: {
    flex: 1,
    padding: '10px 14px',
    borderRadius: '8px',
    border: '1px solid #CFC8BC',
    backgroundColor: '#F5F3EE',
    color: '#292825',
    fontSize: '14px',
    outline: 'none',
  },
  sendBtn: {
    backgroundColor: '#A65F43',
    color: '#FFFDF9',
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
    backgroundColor: '#EEEAE2',
    borderBottom: '1px solid #EAE6DE',
  },
  micBtn: {
    color: '#292825',
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
    borderRight: '1px solid #EAE6DE',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#EEEAE2',
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
    backgroundColor: '#EAE6DE',
    borderBottom: '1px solid #DED8CE',
  },
  codeBlock: {
    flex: 1,
    margin: 0,
    padding: '16px',
    overflow: 'auto',
    backgroundColor: '#0b1120',
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
    backgroundColor: '#EAE6DE',
    padding: '10px 14px',
    borderRadius: '8px',
    fontSize: '13px',
    fontWeight: 500,
  },
  chessBoard: {
    display: 'grid',
    gridTemplateColumns: 'repeat(8, 56px)',
    gridTemplateRows: 'repeat(8, 56px)',
    border: '3px solid #DED8CE',
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
    backgroundColor: '#EAE6DE',
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
    backgroundColor: '#EEEAE2',
    borderBottom: '1px solid #EAE6DE',
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
    backgroundColor: '#EAE6DE',
    borderRadius: '10px',
    overflow: 'hidden',
    border: '1px solid #DED8CE',
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
