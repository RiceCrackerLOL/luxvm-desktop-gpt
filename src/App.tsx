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

// Self-contained Chess Engine Helpers
type PieceChar = 'P' | 'N' | 'B' | 'R' | 'Q' | 'K' | 'p' | 'n' | 'b' | 'r' | 'q' | 'k' | null
type Board = PieceChar[][]

const PIECE_UNICODE: Record<string, string> = {
  K: '', Q: '', R: '', B: '', N: '', P: '',
  k: '', q: '', r: '', b: '', n: '', p: '',
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

  const initialSettings = safeGetStorage(SETTINGS_KEY, {
    apiKey: '',
    systemPrompt: 'You are LuxVM, a helpful, precise, and direct AI desktop assistant.',
    models: DEFAULT_MODELS,
  })

  const [apiKey, setApiKey] = useState<string>(initialSettings.apiKey || '')
  const [systemPrompt, setSystemPrompt] = useState<string>(
    initialSettings.systemPrompt || 'You are LuxVM, a helpful, precise, and direct AI desktop assistant.'
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
    })
  }, [apiKey, systemPrompt, models])

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
          ? { ...s, title: derivedTitle, messages: updatedMessages, updatedAt: Date.now() }
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

      const outboundMessages = [
        ...(systemPrompt.trim() ? [{ role: 'system' as const, content: systemPrompt.trim() }] : []),
        ...updatedMessages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, content: m.content })),
      ]

      const res = await fetch(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: openRouterHeaders(),
        body: JSON.stringify({
          model: models.chat,
          messages: outboundMessages,
        }),
        signal: controller.signal,
      })

      const rawText = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 220)}`)

      const data = JSON.parse(rawText)
      const reply = data?.choices?.[0]?.message?.content || 'Empty response from OpenRouter.'

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
                    content: `Error: ${err?.name === 'AbortError' ? 'Timed out after 45s' : err?.message}`,
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

      const voiceSystem = `${systemPrompt.trim()} Respond conversationally, concisely, and naturally as a spoken voice assistant without markdown formatting or code blocks unless asked.`

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
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 200)}`)

      const data = JSON.parse(rawText)
      const reply = data?.choices?.[0]?.message?.content || 'I did not catch a response.'

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
          content: `Voice Error: ${err?.message}`,
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
              content: `You are LuxVM Codex, an elite software engineer. Write clean, complete, production-ready ${codexLang} code. Output ONLY the code itself without markdown backticks or conversational filler unless briefly needed inside code comments.`,
            },
            { role: 'user', content: codexPrompt.trim() },
          ],
        }),
      })

      const rawText = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 200)}`)

      const data = JSON.parse(rawText)
      let code: string = data?.choices?.[0]?.message?.content || '// No code generated.'
      code = code.replace(/^```[\w-]*\n?/i, '').replace(/\n?```$/i, '')
      setCodexOutput(code)
    } catch (err: any) {
      setCodexOutput(`// Generation Error:\n// ${err?.message}`)
    } finally {
      setIsCodexLoading(false)
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
                    'You are a chess grandmaster playing Black. Reply ONLY with a single legal UCI move (e.g. e7e5, g8f6) from the provided legal moves list. Do not include any other words or punctuation.',
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
            const rawReply: string = data?.choices?.[0]?.message?.content || ''
            const matched = blackLegalMoves.find((m) => rawReply.toLowerCase().includes(m))
            if (matched) chosenUci = matched
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

