export type Unsubscribe = () => void

export interface ThemePayload {
  theme?: string
  tokens?: Record<string, string>
}

export interface SessionSummary {
  title: string
  model: string
  context: string | Record<string, unknown>
}

export interface WorkspaceEntry {
  path: string
  name: string
  type: 'file' | 'directory'
  mtimeMs: number
  size?: number
}

export interface WorkspaceListParams {
  path?: string
  recursive?: boolean
  includeHidden?: boolean
  maxEntries?: number
}

export interface WorkspaceListResult {
  cwd: string
  path: string
  entries: WorkspaceEntry[]
  truncated: boolean
}

export interface WorkspaceReadParams {
  path?: string
  encoding?: 'utf8' | 'utf-8'
  maxBytes?: number
}

export interface WorkspaceFile {
  path: string
  absolutePath: string
  encoding: 'utf8'
  content: string
  size: number
  mtimeMs: number
  truncated: boolean
}

export interface BrowserResult<TExtra extends Record<string, unknown> = Record<string, unknown>> {
  ok: boolean
  action: string
  url?: string
  title?: string
  mode?: string
  backend?: string
  error?: string
  raw?: unknown
  [key: string]: unknown
}

export interface BrowserGetUrlResult extends BrowserResult {
  url: string
}

export interface BrowserGetResult extends BrowserResult {
  kind: string
  value: unknown
}

export interface BrowserSnapshotResult extends BrowserResult {
  text: string
  fullText?: string
  elements: unknown[]
}

export interface BrowserScreenshotResult extends BrowserResult {
  path?: string
  data?: string
  mimeType?: string
  fullPage: boolean
  annotated: boolean
}

export interface BrowserWaitParams {
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | string
  waitForSelector?: string
  waitForText?: string
  waitMs?: number
  timeoutMs?: number
  autoConnect?: boolean
  preferAutoConnect?: boolean
  cdpPort?: number
}

export interface BrowserSnapshotParams {
  maxChars?: number
  maxElements?: number
  selector?: string
  interactive?: boolean
  includeCursorInteractive?: boolean
  fullText?: boolean
  autoConnect?: boolean
  preferAutoConnect?: boolean
  cdpPort?: number
}

export interface BrowserOpenParams extends BrowserWaitParams {
  url?: string
  profile?: string
  sessionName?: string
  state?: string
  headed?: boolean
  /** Widget browser.open defaults to visible Chrome; set false to opt into hidden automation. */
  visible?: boolean
  /** Alias for visible:false when a widget intentionally wants hidden automation. */
  background?: boolean
  mode?: 'auto' | 'visible' | 'background' | 'your-chrome'
  reason?: string
}

export interface BrowserTargetParams extends BrowserWaitParams {
  target?: string
  ref?: string
  selector?: string
  index?: number
  reason?: string
}

export interface BrowserFillParams extends BrowserTargetParams {
  value?: string
}

export interface BrowserPressParams extends BrowserWaitParams {
  key?: string
  reason?: string
}

export interface BrowserScrollParams extends BrowserWaitParams {
  x?: number
  y?: number
  target?: string
  reason?: string
}

export interface BrowserGetParams {
  kind: 'url' | 'title' | 'text' | 'html' | 'value' | 'attr' | 'count' | 'box' | 'styles' | string
  target?: string
  selector?: string
  name?: string
  maxChars?: number
  autoConnect?: boolean
  cdpPort?: number
}

export interface BrowserScreenshotParams {
  fullPage?: boolean
  annotate?: boolean
  selector?: string
  autoConnect?: boolean
  cdpPort?: number
}

export interface ShellRunParams {
  command?: string
  timeoutMs?: number
  reason?: string
}

export interface ShellRunResult {
  command: string
  cwd: string
  exitCode: number | null
  signal: string
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
  output: string
}

export interface AgentDispatchResult {
  dispatchId: string
  threadId: number
}

export interface AgentEvent {
  event: 'delta' | 'tool' | 'context' | 'done' | 'error' | string
  dispatchId?: string
  text?: string
  kind?: string
  message?: string
  modelName?: string
  [key: string]: unknown
}

// --- Intent-first Widget API types (navigator / project / automation / command) ---
// These mirror the legacy workspace/browser/shell types. Widgets should prefer
// the new namespaces; legacy names remain as aliases.

export type ProjectListParams = WorkspaceListParams
export type ProjectListResult = WorkspaceListResult
export type ProjectReadParams = WorkspaceReadParams
export type ProjectFile = WorkspaceFile

export interface NavigatorOpenParams extends BrowserWaitParams {
  url?: string
  reason?: string
}

export interface NavigatorOpenExternalParams {
  url: string
  reason?: string
}

export interface NavigatorOpenResult extends BrowserResult {
  url: string
}

export interface NavigatorOpenExternalResult {
  ok: boolean
  url: string
  opened: boolean
}

export type AutomationBrowserOpenParams = BrowserOpenParams
export type AutomationBrowserTargetParams = BrowserTargetParams
export type AutomationBrowserFillParams = BrowserFillParams
export type AutomationBrowserPressParams = BrowserPressParams
export type AutomationBrowserScrollParams = BrowserScrollParams
export type AutomationBrowserSnapshotParams = BrowserSnapshotParams
export type AutomationBrowserScreenshotParams = BrowserScreenshotParams
export type AutomationBrowserGetParams = BrowserGetParams

export type CommandRunParams = ShellRunParams
export type CommandRunResult = ShellRunResult

export interface HyperDeskWidgetClient {
  bridgeToken: string
  request<T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>
  destroy(): void
  onCommand<T = unknown>(command: string, handler: (data: T, payload: { command: string; data: T }) => void): Unsubscribe
  onTheme(handler: (theme: ThemePayload) => void): Unsubscribe
  onAgentEvent(handler: (event: AgentEvent) => void): Unsubscribe
  theme: {
    current(): Promise<ThemePayload>
  }
  session: {
    summary(): Promise<SessionSummary>
  }
  workspace: {
    listFiles(params?: WorkspaceListParams): Promise<WorkspaceListResult>
    readFile(path: string, params?: Omit<WorkspaceReadParams, 'path'>): Promise<WorkspaceFile>
    readFile(params: WorkspaceReadParams): Promise<WorkspaceFile>
  }
  browser: {
    call(action: string, params?: Record<string, unknown>): Promise<BrowserResult>
    getUrl(): Promise<BrowserGetUrlResult>
    get(params: BrowserGetParams): Promise<BrowserGetResult>
    snapshot(params?: BrowserSnapshotParams): Promise<BrowserSnapshotResult>
    snapshotElements(params?: BrowserSnapshotParams): Promise<BrowserResult<{ elements: unknown[] }>>
    screenshot(params?: BrowserScreenshotParams): Promise<BrowserScreenshotResult>
    wait(params?: BrowserWaitParams): Promise<BrowserResult>
    open(url: string, params?: Omit<BrowserOpenParams, 'url'>): Promise<BrowserResult>
    open(params: BrowserOpenParams): Promise<BrowserResult>
    click(target: string, params?: Omit<BrowserTargetParams, 'target'>): Promise<BrowserResult>
    click(params: BrowserTargetParams): Promise<BrowserResult>
    fill(target: string, value: string, params?: Omit<BrowserFillParams, 'target' | 'value'>): Promise<BrowserResult>
    fill(params: BrowserFillParams): Promise<BrowserResult>
    press(key: string, params?: Omit<BrowserPressParams, 'key'>): Promise<BrowserResult>
    press(params: BrowserPressParams): Promise<BrowserResult>
    scroll(params?: BrowserScrollParams): Promise<BrowserResult>
  }
  project: {
    listFiles(params?: ProjectListParams): Promise<ProjectListResult>
    readFile(path: string, params?: Omit<ProjectReadParams, 'path'>): Promise<ProjectFile>
    readFile(params: ProjectReadParams): Promise<ProjectFile>
  }
  navigator: {
    open(url: string, params?: Omit<NavigatorOpenParams, 'url'>): Promise<NavigatorOpenResult>
    open(params: NavigatorOpenParams): Promise<NavigatorOpenResult>
    openExternal(url: string, params?: Omit<NavigatorOpenExternalParams, 'url'>): Promise<NavigatorOpenExternalResult>
    openExternal(params: NavigatorOpenExternalParams): Promise<NavigatorOpenExternalResult>
  }
  automation: {
    browser: {
      call(action: string, params?: Record<string, unknown>): Promise<BrowserResult>
      getUrl(): Promise<BrowserGetUrlResult>
      get(params: AutomationBrowserGetParams): Promise<BrowserGetResult>
      snapshot(params?: AutomationBrowserSnapshotParams): Promise<BrowserSnapshotResult>
      snapshotElements(params?: AutomationBrowserSnapshotParams): Promise<BrowserResult<{ elements: unknown[] }>>
      screenshot(params?: AutomationBrowserScreenshotParams): Promise<BrowserScreenshotResult>
      wait(params?: BrowserWaitParams): Promise<BrowserResult>
      open(url: string, params?: Omit<AutomationBrowserOpenParams, 'url'>): Promise<BrowserResult>
      open(params: AutomationBrowserOpenParams): Promise<BrowserResult>
      click(target: string, params?: Omit<AutomationBrowserTargetParams, 'target'>): Promise<BrowserResult>
      click(params: AutomationBrowserTargetParams): Promise<BrowserResult>
      fill(target: string, value: string, params?: Omit<AutomationBrowserFillParams, 'target' | 'value'>): Promise<BrowserResult>
      fill(params: AutomationBrowserFillParams): Promise<BrowserResult>
      press(key: string, params?: Omit<AutomationBrowserPressParams, 'key'>): Promise<BrowserResult>
      press(params: AutomationBrowserPressParams): Promise<BrowserResult>
      scroll(params?: AutomationBrowserScrollParams): Promise<BrowserResult>
    }
  }
  command: {
    run(command: string, params?: Omit<CommandRunParams, 'command'>): Promise<CommandRunResult>
    run(params: CommandRunParams): Promise<CommandRunResult>
  }
  shell: {
    run(command: string, params?: Omit<ShellRunParams, 'command'>): Promise<ShellRunResult>
    run(params: ShellRunParams): Promise<ShellRunResult>
  }
  agent: {
    dispatch(prompt: string): Promise<AgentDispatchResult>
    dispatch(params: { prompt: string }): Promise<AgentDispatchResult>
    cancel(): Promise<{ ok: true }>
  }
  /** ZenBin brain / contacts / identity. Read-only data accessors; the host
   *  never returns the private JWK over this bridge (only public fingerprint). */
  zenbin: {
    identityGet(): Promise<{ hasIdentity: boolean; keyId: string; publicKeyFingerprint: string; error?: string }>
    identityList(): Promise<{ ok: boolean; identities: ZenbinIdentity[]; error?: string }>
    identityActive(): Promise<{ ok: boolean; name: string; cwd: string; error?: string }>
    brainList(category?: string): Promise<BrainEntry[]>
    brainGet(slug: string): Promise<BrainPage | null>
    brainSearch(query: string, category?: string, limit?: number): Promise<{ ok: boolean; count: number; hits: BrainSearchHit[] }>
    contactsList(): Promise<ContactEntry[]>
    contactsAdd(contact: { name: string; fingerprint: string; keyId?: string; note?: string }): Promise<{ ok: boolean } & ContactEntry>
    contactsRemove(name: string): Promise<{ removed: boolean }>
    messagesList(): Promise<{ ok: boolean; messages: ZenbinMessage[]; error?: string }>
    messagesSent(): Promise<{ ok: boolean; messages: ZenbinMessage[]; error?: string }>
    messagesGet(id: string): Promise<{ ok: boolean; subject: string; body: string; frontmatter: Record<string, unknown>; url: string; error?: string }>
    messagesSend(params: { recipientKeyId?: string; to?: string; subject: string; body: string; inReplyTo?: string; threadId?: string; pageId?: string; subdomain?: string }): Promise<{ ok: boolean; url: string; keyId: string; publicKeyFingerprint: string; pageId: string }>
    publishesList(cursor?: string): Promise<{ ok: boolean; publishes: ZenbinPublish[]; total: number; nextCursor: string | null; error?: string }>
    publishesGet(id: string, subdomain?: string): Promise<{ ok: boolean; id: string; body: string; url: string; error?: string }>
    publishesVerify(id: string, subdomain?: string): Promise<{ ok: boolean; id: string; verified: boolean; fingerprintMatches: boolean; keyId: string; signedMethod: string; signedPath: string; timestamp: string; verificationUrl: string; keyUrl: string; url: string; error?: string }>
    subdomainsMine(): Promise<{ ok: boolean; subdomains: { name: string; claimedAt: string }[]; error?: string }>
    subdomainsGet(name: string): Promise<{ ok: boolean; name: string; url: string; pageCount: number; error?: string; errorCode?: string }>
    subdomainsList(name: string, cursor?: string): Promise<{ ok: boolean; name: string; pages: ZenbinSubdomainPage[]; total: number; nextCursor: string | null; error?: string }>
  }
}

export interface ZenbinMessage {
  id: string
  slug: string
  subject: string
  fromKeyId: string
  fromFingerprint: string
  toFingerprint: string
  threadId: string
  inReplyTo: string
  messageKind: string
  created: string
  url: string
  body: string
}

export interface BrainEntry {
  slug: string
  title: string
  category: 'people' | 'subject' | 'company' | 'other'
  tags: string[]
  updated: string
  url: string
  valid: boolean
}

export interface BrainSearchHit {
  slug: string
  title: string
  category: string
  tags: string[]
  snippet: string
  path: string
  url: string
  score: number
}

export interface BrainPage {
  frontmatter: Record<string, unknown>
  body: string
  path: string
}

export interface ContactEntry {
  name: string
  fingerprint: string
  keyId: string
  note: string
  addedAt: string
}

export interface ZenbinPublish {
  id: string
  slug: string
  title: string
  kind: string
  subdomain: string | null
  publishedAt: string
  updatedAt: string
  url: string
  hasMarkdown: boolean
  hasImage: boolean
  hasVideo: boolean
  etag: string
  signToRead: boolean | null
  recipientKeyId: string | null
}

export interface ZenbinSubdomainPage {
  id: string
  path: string
  title: string
  url: string
  hasMarkdown: boolean
  hasImage: boolean
  hasVideo: boolean
  updatedAt: string
}

export interface ZenbinIdentity {
  name: string
  keyId: string
  publicKeyFingerprint: string
  createdAt: string
  isDefault: boolean
}

export interface HyperDeskWidgetGlobal {
  connect(options?: { bridgeToken?: string; target?: Window; timeoutMs?: number }): HyperDeskWidgetClient
}

declare global {
  interface Window {
    HyperDeskWidget: HyperDeskWidgetGlobal
  }
  const HyperDeskWidget: HyperDeskWidgetGlobal
}
