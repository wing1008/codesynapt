// @codesynapt/plugin-api — public API surface for plugins
// MIT licensed — free to use, fork, distribute.

/* ════════════════════════════════════════════════════════════
   Plugin manifest
   ════════════════════════════════════════════════════════════ */

export interface PluginManifest {
  /** Unique identifier (kebab-case, e.g. "tokyo-night-theme") */
  id: string

  /** Display name */
  name: string

  /** Plugin version (semver) */
  version: string

  /** Author name (no email required) */
  author: string

  /** One-line description shown in plugin list */
  description: string

  /** Plugin type — determines what API surface it gets */
  type: 'theme' | 'exporter' | 'parser' | 'layout' | 'panel' | 'action'

  /**
   * Entry point file (relative to manifest.json):
   * - For theme: a .css file
   * - For others: a .js module
   */
  main: string

  /** Minimum codesynapt app version (semver range) */
  minAppVersion: string

  /** SPDX license identifier (MIT, Apache-2.0, etc) */
  license: string

  /** Optional URL for the plugin homepage / repo */
  homepage?: string

  /** Optional: which app capabilities does this plugin need? */
  permissions?: PluginPermission[]
}

export type PluginPermission =
  | 'read-files'        // Read source file contents
  | 'read-graph'        // Read the current node/edge state
  | 'modify-graph'      // Add nodes/edges (rare, dangerous)
  | 'ui-panel'          // Render in a side panel
  | 'context-menu'      // Add right-click items
  | 'export'            // Provide an export format
  | 'parse'             // Provide a language parser

/* ════════════════════════════════════════════════════════════
   Plugin context — passed to every plugin's activate() function
   ════════════════════════════════════════════════════════════ */

export interface PluginContext {
  /** This plugin's manifest */
  manifest: PluginManifest

  /** App version at load time */
  appVersion: string

  /** Read-only access to graph state */
  graph: GraphAPI

  /** UI registration */
  ui: UIAPI

  /** Export format registration */
  exporters: ExporterRegistry

  /** Parser registration */
  parsers: ParserRegistry

  /** Layout algorithm registration */
  layouts: LayoutRegistry

  /** Event subscription */
  events: EventBus

  /** Persistent per-plugin storage (localStorage-backed) */
  storage: PluginStorage

  /** Helper: show a toast message */
  toast: (message: string) => void

  /** Helper: log to plugin-specific console */
  log: (...args: unknown[]) => void
}

/* ════════════════════════════════════════════════════════════
   Graph API
   ════════════════════════════════════════════════════════════ */

export interface GraphNode {
  /** File path relative to project root */
  id: string

  /** File extension (without dot) */
  ext: string

  /** File size in bytes */
  size: number

  /** Lines of code */
  loc: number

  /** Display color (hex) */
  hex: string
}

export interface GraphEdge {
  /** Source node id */
  s: string

  /** Target node id */
  t: string

  /** Edge kind: 'import' | 'require' | 'css' | etc */
  k: string
}

export interface GraphAPI {
  /** Current project root path */
  readonly root: string

  /** All nodes (read-only) */
  readonly nodes: ReadonlyArray<GraphNode>

  /** All edges (read-only) */
  readonly edges: ReadonlyArray<GraphEdge>

  /** Currently selected node id (or null) */
  readonly selectedId: string | null

  /** Currently active set of file ids (or null if disabled) */
  readonly activeSet: ReadonlySet<string> | null

  /** Read file contents (requires "read-files" permission) */
  readFile(id: string): Promise<string>

  /** Get node by id, or null */
  getNode(id: string): GraphNode | null

  /** Get all outgoing edges from a node */
  outgoing(id: string): GraphEdge[]

  /** Get all incoming edges to a node */
  incoming(id: string): GraphEdge[]
}

/* ════════════════════════════════════════════════════════════
   UI API
   ════════════════════════════════════════════════════════════ */

export interface UIAPI {
  /**
   * Register a panel that appears in the right rail.
   * Returns a handle for later removal.
   */
  registerPanel(opts: PanelOptions): PanelHandle

  /**
   * Register a context-menu item that appears when right-clicking
   * a node in the graph.
   */
  registerContextMenuItem(opts: ContextMenuOptions): MenuItemHandle

  /**
   * Register a command (shows up in command palette if available).
   */
  registerCommand(opts: CommandOptions): CommandHandle
}

export interface PanelOptions {
  /** Unique id within this plugin */
  id: string

  /** Title shown in panel header */
  title: string

  /** Position (default: 'right') */
  position?: 'right' | 'left' | 'bottom'

  /**
   * Render function — return HTML string or DOM element.
   * Called when the panel becomes visible or when refresh() is called.
   */
  render: (container: HTMLElement) => void

  /** Whether the panel is visible by default */
  defaultVisible?: boolean
}

export interface PanelHandle {
  /** Force re-render */
  refresh(): void

  /** Show the panel */
  show(): void

  /** Hide the panel */
  hide(): void

  /** Remove the panel entirely */
  dispose(): void
}

export interface ContextMenuOptions {
  /** Display label */
  label: string

  /** Optional icon (single character or short string) */
  icon?: string

  /** When to show — return true to enable */
  enabled?: (nodeId: string) => boolean

  /** Click handler */
  action: (nodeId: string) => void | Promise<void>
}

export interface MenuItemHandle {
  dispose(): void
}

export interface CommandOptions {
  /** Unique command id */
  id: string

  /** Display name in command palette */
  name: string

  /** Optional keyboard shortcut suggestion */
  shortcut?: string

  /** Handler */
  action: () => void | Promise<void>
}

export interface CommandHandle {
  dispose(): void
}

/* ════════════════════════════════════════════════════════════
   Exporter registration
   ════════════════════════════════════════════════════════════ */

export interface ExporterRegistry {
  register(opts: ExporterOptions): ExporterHandle
}

export interface ExporterOptions {
  /** Display name (e.g. "Mermaid diagram") */
  name: string

  /** File extension (e.g. "mmd") */
  extension: string

  /** MIME type for the download */
  mimeType: string

  /**
   * Generate the export content.
   * Receives the current graph state and returns the file content.
   */
  generate: (graph: GraphAPI) => string | Promise<string>
}

export interface ExporterHandle {
  dispose(): void
}

/* ════════════════════════════════════════════════════════════
   Parser registration
   ════════════════════════════════════════════════════════════ */

export interface ParserRegistry {
  register(opts: ParserOptions): ParserHandle
}

export interface ParserOptions {
  /** Language name (e.g. "Rust") */
  name: string

  /** File extensions this parser handles (without dot) */
  extensions: string[]

  /**
   * Parse a file and return its imports.
   * Resolution from import path to file id is done by the app.
   */
  parse: (filePath: string, content: string) => ParseResult
}

export interface ParseResult {
  /** Import statements found in this file */
  imports: ParseImport[]

  /** Optional: lines of code count (if not given, app counts newlines) */
  loc?: number
}

export interface ParseImport {
  /** The raw import path (e.g. "./foo", "react", "@/utils") */
  path: string

  /** Import kind */
  kind: 'import' | 'require' | 'dynamic' | 'css' | 'asset' | 'other'

  /** Source line number (optional, for debugging) */
  line?: number
}

export interface ParserHandle {
  dispose(): void
}

/* ════════════════════════════════════════════════════════════
   Layout algorithm registration
   ════════════════════════════════════════════════════════════ */

export interface LayoutRegistry {
  register(opts: LayoutOptions): LayoutHandle
}

export interface LayoutOptions {
  /** Display name (e.g. "Hierarchical") */
  name: string

  /** Unique id */
  id: string

  /**
   * Compute positions for all nodes.
   * Called once when this layout is activated, then again whenever
   * the graph topology changes.
   *
   * Should return a Map from node id to {x, y, z} coordinates.
   */
  compute: (nodes: ReadonlyArray<GraphNode>, edges: ReadonlyArray<GraphEdge>)
    => Map<string, { x: number; y: number; z: number }>
    | Promise<Map<string, { x: number; y: number; z: number }>>
}

export interface LayoutHandle {
  dispose(): void
}

/* ════════════════════════════════════════════════════════════
   Event bus
   ════════════════════════════════════════════════════════════ */

export type EventName =
  | 'snapshot:applied'      // New graph data loaded — { root: string }
  | 'selection:changed'     // User selected a node — string | null
  | 'filter:changed'        // Filter text changed
  | 'focus:changed'         // Focused node changed
  | 'graph:cleared'         // Graph was cleared
  | 'activeset:changed'     // Active set updated

export interface EventBus {
  on<T = unknown>(event: EventName, handler: (payload: T) => void): () => void
  off(event: EventName, handler: (payload: unknown) => void): void
}

/* ════════════════════════════════════════════════════════════
   Plugin storage (persistent per-plugin key-value store)
   ════════════════════════════════════════════════════════════ */

export interface PluginStorage {
  get<T = unknown>(key: string): T | null
  set<T = unknown>(key: string, value: T): void
  delete(key: string): void
  clear(): void
  keys(): string[]
}

/* ════════════════════════════════════════════════════════════
   Plugin entry-point signature
   ════════════════════════════════════════════════════════════ */

/**
 * Every plugin's main module must default-export an object with at
 * least an `activate` function. `deactivate` is optional, called when
 * the user disables or uninstalls the plugin.
 */
export interface Plugin {
  activate(ctx: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}
