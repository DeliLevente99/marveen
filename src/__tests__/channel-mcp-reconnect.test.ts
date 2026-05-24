import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the platform agent-runtime shim — the unit under test now drives
// the runtime via this interface instead of execFileSync(TMUX, ...). The
// mocks expose sendKey / sendText / sleepSync as vi.fn so individual
// tests can assert on call shapes and stub failure modes.
const mockSendKey = vi.fn<(name: string, key: string) => void>()
const mockSendText = vi.fn<(name: string, text: string) => void>()
const mockSleepSync = vi.fn<(ms: number) => void>()
vi.mock('../platform/agent-runtime.js', () => ({
  agentRuntime: {
    sendKey: (name: string, key: string) => mockSendKey(name, key),
    sendText: (name: string, text: string) => mockSendText(name, text),
    sleepSync: (ms: number) => mockSleepSync(ms),
    startSession: vi.fn(),
    killSession: vi.fn(),
    hasSession: vi.fn(),
    listSessions: vi.fn(),
    capture: vi.fn(),
  },
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
  CHANNEL_PROVIDER: 'telegram',
  PROJECT_ROOT: '/tmp/test-claudeclaw',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentChannelProvider: (name: string) => name === 'slacker' ? 'slack' : '',
  AGENTS_BASE_DIR: '/tmp/test-claudeclaw/agents',
}))

const mockCapturePane = vi.fn<(session: string) => string | null>()
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  capturePane: (session: string) => mockCapturePane(session),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: (type: string) => ({
    pluginId: type === 'slack'
      ? 'slack-channel@marveen-marketplace'
      : 'telegram@claude-plugins-official',
  }),
}))

import {
  attemptChannelMcpReconnect,
  resolveAgentSession,
  resolveAgentProviderType,
} from '../web/channel-mcp-reconnect.js'

describe('resolveAgentSession', () => {
  it('returns main channels session for main agent', () => {
    expect(resolveAgentSession('marveen')).toBe('marveen-channels')
  })

  it('returns agent-NAME for sub-agents', () => {
    expect(resolveAgentSession('samu')).toBe('agent-samu')
    expect(resolveAgentSession('zara')).toBe('agent-zara')
  })
})

describe('resolveAgentProviderType', () => {
  it('returns configured provider for agent with explicit config', () => {
    expect(resolveAgentProviderType('slacker')).toBe('slack')
  })

  it('falls back to CHANNEL_PROVIDER for unconfigured agents', () => {
    expect(resolveAgentProviderType('samu')).toBe('telegram')
  })
})

describe('attemptChannelMcpReconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns ok:true when plugin submenu is found on first Up', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp menu content')
      .mockReturnValueOnce('some content with telegram@claude-plugins-official listed')

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Up x1')
    // /mcp menu open: sendText('/mcp') then sendKey('Enter')
    expect(mockSendText).toHaveBeenCalledWith('marveen-channels', '/mcp')
    expect(mockSendKey).toHaveBeenCalledWith('marveen-channels', 'Enter')
  })

  it('returns ok:true when plugin found on third Up', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp menu')
      .mockReturnValueOnce('no match')
      .mockReturnValueOnce('no match')
      .mockReturnValueOnce('telegram@claude-plugins-official here')

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Up x3')
  })

  it('returns ok:false when capture fails after /mcp', () => {
    mockCapturePane.mockReturnValueOnce(null)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('capture')
  })

  it('returns ok:false when plugin not found within max attempts', () => {
    mockCapturePane.mockReturnValueOnce('/mcp menu')
    for (let i = 0; i < 8; i++) {
      mockCapturePane.mockReturnValueOnce('no match here')
    }

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('not found')
  })

  it('uses correct session for sub-agents', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp')
      .mockReturnValueOnce('slack-channel@marveen-marketplace found')

    attemptChannelMcpReconnect('slacker')

    // First call in the function is sendKey(session, 'Escape')
    expect(mockSendKey).toHaveBeenCalledWith('agent-slacker', 'Escape')
  })

  it('sends Escape on error to clean up menu state', () => {
    // Force the second sendKey call to throw (the one after /mcp Enter is
    // already in flight) so the catch path's cleanup Escape fires.
    let sendKeyCount = 0
    mockSendKey.mockImplementation(() => {
      sendKeyCount++
      if (sendKeyCount === 2) throw new Error('runtime dead')
    })

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    const escapeCalls = mockSendKey.mock.calls.filter(c => c[1] === 'Escape')
    expect(escapeCalls.length).toBeGreaterThan(0)
  })
})
