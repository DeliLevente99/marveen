// Pure-logic detector for a tmux pane running Claude Code.
//
// Motivation: the scheduler used a single regex (`/esc to interrupt/`) to
// decide whether a target session could accept a new prompt. Between a
// user turn's submission and the spinner's first render there is a frame-
// scale window where the footer shows only `⏵⏵ bypass permissions on
// (shift+tab to cycle)` WITHOUT the `· esc to interrupt` suffix. A
// scheduler tick landing in that window mis-detected "ready", called
// sendPromptToSession, and the prompt sat in the input buffer until the
// post-send retry gave up. The new detector:
//
//   - Recognises a wider range of positive busy indicators (spinner
//     glyph labels + token-count pattern + tool-use mid-turn lines)
//     so the frame-level footer gap no longer yields a false positive.
//   - Returns a discrete state so the caller can distinguish idle /
//     busy / typing / unknown and react per state.
//
// The module has ZERO imports so it is trivially unit-testable against
// captured pane fixtures. The I/O (capture-pane + double-sample) lives
// in src/web.ts alongside the rest of the scheduler.

export type PaneState = 'idle' | 'busy' | 'typing' | 'unknown'

// Claude Code shows the footer in one of two modes: the default "bypass"
// permissions mode (permissive) and the "strict" mode. Both are "idle"
// surfaces. If neither is visible the pane is not a recognised Claude
// Code surface and we report 'unknown' rather than guess.
//
// The bypass-mode footer has known trailing variants after the
// "bypass permissions on" prefix: the original "(shift+tab to cycle)"
// hint, and the background-shells indicator which Claude Code
// substitutes when one or more BashTool background shells are running
// in the session. The background-shells indicator itself comes in two
// shapes depending on whether the tasks panel is visible:
//   - tasks visible:  "· N shells · ctrl+t to hide tasks · ↓ to manage"
//   - tasks hidden:   "· N shells · ↓ to manage"
// All variants must classify as idle, otherwise sessions that spawn
// background shells (gh poll, file watchers, long-running build) get
// stuck pending forever.
//
// The shells-variant requires either the "· ctrl+t" marker or the
// "· ↓ to manage" tail after the shell count, rather than just the
// bare "· N shell(s)" prefix. Two reasons:
//   (a) one of these tails is always what Claude Code actually renders,
//       so insisting on either rejects malformed or mid-render frames;
//   (b) it disambiguates the footer from scrollback content that
//       happens to contain "bypass permissions on · 1 shell" verbatim
//       (an echoed log line, a quoted message, etc.) which would
//       otherwise be misread as idle.
// Inter-word whitespace is `\s*` rather than a literal space: on Windows
// ConPTY collapses spaces inside the status-bar footer when repainting,
// so the same line shows up as `bypasspermissionson (shift+tabtocycle)`
// instead of `bypass permissions on (shift+tab to cycle)`. The strict
// literal-space form left every ConPTY session classified as 'unknown'
// (footer not matched -> detectPaneState falls out of the idle branch),
// freezing inter-agent message delivery and scheduled-task injection.
// `\s*` matches both shapes; tmux POSIX output (single spaces) still
// matches identically.
const IDLE_FOOTER_RX = /bypass\s*permissions\s*on(?:\s*\(shift\s*\+\s*tab\s*to\s*cycle\)|\s*·\s*\d+\s*shells?\s*·\s*(?:ctrl\s*\+\s*t|↓\s*to\s*manage))|\?\s*for\s*shortcuts/

// Positive busy signals. ANY match anywhere in the pane means the turn
// is mid-flight, even if the footer looks idle for a frame.
//
// Deliberately narrow: only signals that disappear THE MOMENT a turn
// ends. Two failure modes we explicitly avoid:
//
//   (A) Scrollback persistence. Tool-use summary lines (`Searched for /
//       Listed / Read`) stay rendered above the input box after the
//       turn ends, and Claude Code never overwrites them. A regex
//       matching those would starve the scheduler forever.
//
//   (B) Prose false positive. The standalone word "Thinking…" or
//       "Crafting…" could legitimately appear in Claude's reply text
//       (Markdown headings, list items, quoted content). Matching the
//       label alone would read that prose as mid-turn. To avoid this
//       we require the label to be followed by the parenthesised
//       runtime marker `(Ns · ↓` -- an UI chrome signature that
//       cannot appear in reply text.
//
// The load-bearing signal is the tokens-down-arrow pattern `(Ns · ↓N`,
// which every extended-thinking turn renders regardless of spinner
// label. `esc to interrupt` is the footer-scoped fallback. A future
// Claude Code release that renames the spinner labels will miss the
// label regex but still be caught by the tokens pattern.
const BUSY_INDICATORS: RegExp[] = [
  /\besc to interrupt\b/,
  // Tokens-down-arrow counter: "(52s · ↓ 2.6k tokens ..." Turn-scoped,
  // overwritten with whitespace the moment the turn completes -- on
  // POSIX. On Windows ConPTY the completed-turn summary persists in
  // the output region above the input box (e.g.
  // `Baking… (4s · ↓ 95 tokens · thought for 2s)`) and tripped a false
  // busy until detectPaneState's idle pane was unreachable. The negative
  // lookahead `(?!thought for)` excludes the completed-turn shape: live
  // spinners show `thinking)` or a bare token tail, completed ones show
  // `thought for Xs)` between the open paren and close. Active matches
  // (BUSY_TOKENS_ONLY fixture and friends) still hit because their tail
  // never contains "thought for".
  /\(\s*\d+s\s*·\s*↓\s*\d(?:(?!thought for).)*?\)/,
  // Known spinner labels paired with the turn-scoped `(Ns · ↓` tail on
  // the same line. The tail requirement kills the "Thinking…" prose
  // false positive. Non-exhaustive by design; the bare tokens pattern
  // above is the authoritative fallback. Same `thought for` exclusion
  // applied here for symmetry.
  /\b(?:Combobulating|Beaming|Thinking|Pondering|Reticulating|Configuring|Noodling|Ruminating|Percolating|Cogitating|Deliberating|Contemplating|Musing|Brewing|Synthesizing|Distilling|Refining|Simmering|Crafting|Formulating|Consulting|Unfurling|Unspooling|Unraveling)…\s*\(\s*\d+s\s*·\s*↓(?:(?!thought for).)*?\)/,
]

// Pasted-text placeholder. Claude Code lifts bursts of input keys into
// `[Pasted text #N +X chars]` stubs, which sit in the input buffer and
// never auto-submit on Enter. Treat as busy so the scheduler doesn't pile
// a second prompt on top. Inter-word whitespace is `\s*` rather than a
// literal space because Windows ConPTY collapses spaces inside the
// placeholder rendering -- `[Pasted text #1]` on POSIX arrives as
// `[Pastedtext#1]` on Windows. Same root cause as the IDLE_FOOTER_RX
// relaxation; pre-fix, shouldRetrySubmit's PASTE-detection path never
// fired on ConPTY, the retry-Enter never ran, and inter-agent messages
// stayed stuck as placeholders in the input box forever (status=delivered
// in the DB because sendText succeeded, but never actually submitted).
const PENDING_PASTE_RX = /\[Pasted\s*text\s*#\d+/

// Input-box separator lines are made of U+2500 BOX DRAWINGS LIGHT
// HORIZONTAL. At least 10 in a run to ignore stray `-` glyphs.
const BOX_SEP_RX = /^─{10,}/

// Prompt line inside the input box. `❯` followed by at least one tab/
// space and then a non-whitespace character means the user (or a
// send-keys that didn't submit) parked text there. Single-line match
// ([ \t] not \s) to avoid crossing into the next line.
const PARKED_INPUT_RX = /❯[ \t]+\S/

export interface DetectPaneStateOptions {
  /** If true, the 'typing' state (text parked in input box) is
   * merged into 'busy'. Default false -- callers that care about
   * "user actively composing" vs "mid-turn" can distinguish. */
  mergeTypingAsBusy?: boolean
}

/**
 * Classify a raw `tmux capture-pane -p` string into a pane state.
 *
 * Algorithm, in order:
 *   1. Empty / whitespace-only -> 'unknown'.
 *   2. Any BUSY_INDICATOR matches anywhere -> 'busy'. This includes the
 *      wider spinner/token-count fallbacks that catch the frame-level
 *      footer gap.
 *   3. No idle footer visible -> 'unknown' (pane is not Claude Code).
 *   4. Pending paste placeholder -> 'busy'.
 *   5. Text parked inside the bottom input box -> 'typing'.
 *   6. Otherwise -> 'idle'.
 */
export function detectPaneState(
  pane: string,
  opts: DetectPaneStateOptions = {},
): PaneState {
  if (!pane || !pane.trim()) return 'unknown'

  // Exclude the input box content from BUSY_INDICATORS scanning. On
  // ConPTY a completed turn can leave its summary line (e.g.
  // `Sketching… (3s · ↓ 49 tokens · thinking)`) rendered INSIDE the input
  // box between the two separators -- the tokens-arrow regex then false-
  // positives forever on what is actually post-turn scrollback. The
  // output area above the input box (where the LIVE spinner is painted
  // during an active turn) and the status area below the input box
  // (where "esc to interrupt" surfaces) remain in scope. Falls back to
  // the whole pane when the input box structure isn't identifiable
  // (no footer or single-separator panes during startup) so we stay
  // conservative on under-formed states.
  const scanRegion = busyScanRegion(pane)
  for (const rx of BUSY_INDICATORS) {
    if (rx.test(scanRegion)) return 'busy'
  }

  if (!IDLE_FOOTER_RX.test(pane)) return 'unknown'

  // Find the input box: two BOX_SEP_RX lines framing the current prompt.
  // Scan UPWARDS from the footer so we stay inside the live box and
  // don't pick up historical ❯ lines from scrollback.
  const lines = pane.split('\n')
  const footerIdx = lines.findLastIndex(l => IDLE_FOOTER_RX.test(l))
  if (footerIdx >= 0) {
    let bottomSep = -1
    for (let i = footerIdx - 1; i >= 0; i--) {
      if (BOX_SEP_RX.test(lines[i])) { bottomSep = i; break }
    }
    let topSep = -1
    if (bottomSep > 0) {
      for (let i = bottomSep - 1; i >= 0; i--) {
        if (BOX_SEP_RX.test(lines[i])) { topSep = i; break }
      }
    }
    if (topSep >= 0 && bottomSep > topSep) {
      const inputLines = lines.slice(topSep + 1, bottomSep)
      // PENDING_PASTE_RX scoped strictly to the live input box. A whole-
      // pane scan would catch stale `[Pastedtext#N] paste again to expand`
      // strings rendered into scrollback by completed turns -- pre-fix
      // this misclassified the session 'busy' forever on long-running
      // ConPTY sessions where the placeholder render lingered in
      // scrollback after the originating turn finished.
      if (inputLines.some(l => PENDING_PASTE_RX.test(l))) return 'busy'
      if (inputLines.some(l => PARKED_INPUT_RX.test(l))) {
        return opts.mergeTypingAsBusy ? 'busy' : 'typing'
      }
    }
  }

  return 'idle'
}

/**
 * True when the pane is in the specific "accepting a new prompt" state.
 * 'typing' counts as not-ready because the user has unsubmitted text
 * in the input box and a new prompt would concatenate into it.
 */
export function isReadyForPrompt(pane: string): boolean {
  return detectPaneState(pane) === 'idle'
}

// Return the pane with the input box interior excised, so BUSY_INDICATORS
// regexes never match scrollback artifacts that ConPTY may have parked
// inside the input box. Preserves the OUTPUT region above the top
// separator (where Claude Code paints the live spinner during an active
// turn) and the STATUS region below the bottom separator (where the
// "esc to interrupt" prompt surfaces) so the busy-detection semantics
// existing fixtures depend on are unchanged.
//
// Falls back to the whole pane when the input box can't be located
// (no footer, no separator, only one separator) -- under-formed pane
// states should remain conservative.
function busyScanRegion(pane: string): string {
  const lines = pane.split('\n')
  const footerIdx = lines.findLastIndex(l => IDLE_FOOTER_RX.test(l))
  if (footerIdx < 0) return pane
  let bottomSep = -1
  for (let i = footerIdx - 1; i >= 0; i--) {
    if (BOX_SEP_RX.test(lines[i])) { bottomSep = i; break }
  }
  if (bottomSep < 0) return pane
  let topSep = -1
  for (let i = bottomSep - 1; i >= 0; i--) {
    if (BOX_SEP_RX.test(lines[i])) { topSep = i; break }
  }
  if (topSep < 0) return pane
  // Anchor the "output above" upper edge to the latest completed-turn
  // marker (`thought for Xs)`) or to the previous footer, whichever is
  // closer to topSep. The previous footer alone is unreliable on
  // long-running ConPTY sessions: intermediate turn footers get merged
  // into the separator scrollback or overwritten, so prevFooter often
  // points way up at the session-start header, leaving 80+ lines of
  // mixed-turn output (including stale "thinking)" spinners from older
  // sub-turns) in scope. The completed-turn marker IS reliably
  // preserved by ConPTY, so anchoring above it cleanly cuts off all
  // prior-turn artifacts. Live spinners ("thinking)") above it are
  // also stale by definition -- they belong to a turn that has since
  // completed.
  const COMPLETED_TURN_MARKER_RX = /thought for \d+s\)/
  let lastCompletedAt = -1
  for (let i = topSep - 1; i >= 0; i--) {
    if (COMPLETED_TURN_MARKER_RX.test(lines[i])) { lastCompletedAt = i; break }
  }
  let prevFooter = -1
  for (let i = topSep - 1; i >= 0; i--) {
    if (IDLE_FOOTER_RX.test(lines[i])) { prevFooter = i; break }
  }
  // Additionally clamp the upper edge to two lines above topSep. Even
  // when a completed-turn marker or prior footer is far above (long
  // session with intermediate footers ConPTY didn't preserve), the
  // LIVE busy indicator is anchored within ~1-2 lines above the
  // current input box -- POSIX 1-frame-gap spinner sits immediately
  // above, ConPTY's lingering post-turn spinner sits several lines
  // back behind the reply text + tip. The clamp lets the genuine
  // live signal through while excluding the stale render.
  const semanticStart = Math.max(lastCompletedAt + 1, prevFooter + 1)
  const outputStart = Math.max(semanticStart, topSep - 2)
  const above = lines.slice(outputStart, topSep + 1)
  const below = lines.slice(bottomSep)
  return [...above, ...below].join('\n')
}

// Locate the live Claude Code input box and return its inner content as
// one string. Bounded strictly to the region between the two most
// recent BOX_SEP_RX separators above the idle footer, so a parked input
// in scrollback (post-turn artifact) is never mistaken for live state.
//
// Returns null when the pane does not have a live input box (no idle
// footer, only one separator, etc.) -- callers should treat null as
// "not enough signal to act, do nothing".
function liveInputBox(pane: string): string | null {
  const lines = pane.split('\n')
  const footerIdx = lines.findLastIndex(l => IDLE_FOOTER_RX.test(l))
  if (footerIdx < 0) return null
  let bottomSep = -1
  for (let i = footerIdx - 1; i >= 0; i--) {
    if (BOX_SEP_RX.test(lines[i])) { bottomSep = i; break }
  }
  if (bottomSep <= 0) return null
  let topSep = -1
  for (let i = bottomSep - 1; i >= 0; i--) {
    if (BOX_SEP_RX.test(lines[i])) { topSep = i; break }
  }
  if (topSep < 0) return null
  return lines.slice(topSep + 1, bottomSep).join('\n')
}

// Marker strings from prompt-safety.ts preambles. We do NOT import them
// to keep this module dependency-free for unit testing; the markers
// here are stable opening phrases pinned to the first sentence of each
// preamble. A prompt-safety.ts test pins the preamble shape so a rename
// will surface as a failing test there, not here.
//
// Each regex requires an extended opening fragment so prose that
// merely echoes the marker ("Let me search for TEAM MEMBER NOTICE in
// the logs", "SECURITY NOTICE -- read carefully before deploying")
// does not trigger a false-positive clear. The longer tail
// (`<trusted-peer source` / `before acting`) is unique enough that a
// random typed sentence is implausible to reproduce it verbatim.
// Whitespace classes (`\s+`) intentionally include newline so a
// terminal-wrapped preamble (TUI re-flow at narrow widths) still
// matches -- that wrapped preamble is the genuine article, not a
// false-positive.
const TRUSTED_PREAMBLE_MARKER = /TEAM MEMBER NOTICE\s+--\s+the next\s+<trusted-peer\s+source/
const UNTRUSTED_PREAMBLE_MARKER = /SECURITY NOTICE\s+--\s+read carefully before acting/

// A "real" opening tag has source="<alphanumeric/colon/underscore/dash>",
// because sanitizeAgentSource() (prompt-safety.ts) strips every other
// character. The preambles themselves reference the tag shape with
// source="..." (three literal full stops), which sanitizeAgentSource
// would scrub -- so a literal "..." source can only originate from the
// preamble text, never from a real wrapped message. Distinguishing on
// the source content is what lets us tell a stale preamble (no real
// tag yet) from a fully-landed message (real tag with a sanitised
// source).
const REAL_OPENING_TAG_RX = /<(?:trusted-peer|untrusted)\s+source="[A-Za-z0-9:_-]+"/

/**
 * Returns true when the pane likely has just-sent text sitting in the
 * Claude Code prompt buffer that the trailing Enter never submitted --
 * i.e. a stuck-after-send-keys state from which a retry-Enter is
 * warranted.
 *
 * Two stuck signatures are handled:
 *
 *   1. A `[Pasted text #N]` placeholder visible in the input box. Claude
 *      Code's bracketed-paste detector lifts long bursts of input into
 *      stubs that do not auto-submit on the trailing Enter. The
 *      placeholder shape is unambiguous, so any occurrence inside the
 *      live input box is treated as stuck.
 *
 *   2. A verbatim payload sitting in the input box. The detector
 *      requires `payloadHint` to be a substring of the live input box's
 *      content, so a parked input the operator typed manually is not
 *      mistaken for a stuck send. The minimum hint length is
 *      configurable via opts.minHintChars (default 16) to keep short
 *      hints from false-positiving on common UI text.
 *
 * Negative cases (returns false):
 *
 *   - The pane is busy (spinner / token counter / esc-to-interrupt) --
 *     the prompt is being processed, no retry needed.
 *   - The pane is not a Claude Code surface (no idle footer found).
 *   - The input box is empty and no paste placeholder is visible.
 *   - The verbatim path is requested but `payloadHint` is shorter than
 *     `minHintChars` (caller passed a too-short hint).
 *
 * @param pane The raw `tmux capture-pane -p` output to inspect.
 * @param payloadHint A substring of the prompt just sent. Used by the
 *   verbatim-detection path; pass an empty string to limit the check
 *   to the placeholder path only.
 * @param opts.minHintChars Minimum length the hint must reach before
 *   the verbatim path is attempted. Default 16.
 */
export function shouldRetrySubmit(
  pane: string,
  payloadHint: string,
  opts: { minHintChars?: number } = {},
): boolean {
  if (!pane || !pane.trim()) return false

  // Busy pane: the turn is mid-flight, no retry needed. Scope is the
  // current-turn live region (same as detectPaneState) so stale
  // "esc to interrupt" footers in scrollback don't block the retry
  // path -- otherwise a stuck [Pasted text #N] placeholder in the
  // current input box would never get the rescue Enter on long
  // sessions with multiple prior turn footers baked into the
  // capture buffer.
  const busyScan = busyScanRegion(pane)
  for (const rx of BUSY_INDICATORS) {
    if (rx.test(busyScan)) return false
  }
  // Without an idle footer the pane is either not Claude Code or in an
  // unknown render state. Be conservative and skip.
  if (!IDLE_FOOTER_RX.test(pane)) return false

  const inputBox = liveInputBox(pane)
  if (inputBox == null) return false

  // Path 1: placeholder is unambiguous, retry regardless of hint.
  if (PENDING_PASTE_RX.test(inputBox)) return true

  // Path 2: verbatim payload parked in the input box.
  // Clamp the minimum hint length to >= 1. minHintChars=0 paired with
  // an empty payloadHint would otherwise let `inputBox.includes("")`
  // return true for every non-empty box, retrying Enter on every idle
  // pane. Non-finite inputs (NaN, Infinity) fall back to the default
  // so a malformed caller can't silently disable or saturate the
  // verbatim path either.
  const rawMin = opts.minHintChars
  const safeMin = typeof rawMin === 'number' && Number.isFinite(rawMin) ? rawMin : 16
  const minHint = Math.max(safeMin, 1)
  if (payloadHint.length < minHint) return false
  return inputBox.includes(payloadHint)
}

/**
 * Returns true when the pane shows a stale preamble from a wrapped
 * message that never fully landed -- a `SECURITY NOTICE` (untrusted) or
 * `TEAM MEMBER NOTICE` (trusted-peer) preamble visible in the input
 * box without a matching real opening tag (`<untrusted source="...">`
 * or `<trusted-peer source="...">` with a sanitised source value).
 *
 * When this returns true the caller must issue a buffer-clear (Ctrl-U)
 * before sending the next message. Otherwise a fresh prompt would be
 * concatenated onto the stale preamble and the receiving agent could
 * inherit its trust semantics: e.g. an untrusted external payload
 * landing behind a stale `TEAM MEMBER NOTICE` preamble could be read
 * as if it came from a trusted peer.
 *
 * The check is scoped strictly to the live input box (between the two
 * most recent box-separators above the idle footer). A preamble in
 * deep scrollback (a long-ago turn's artifact) never triggers a clear.
 *
 * Distinguishing a stale preamble from a fully-landed message relies
 * on the source-attribute content: real wrapped messages always carry
 * a sanitised `source="agent:NAME"` (or similar) value, while the
 * preambles themselves only reference the tag shape with the literal
 * placeholder `source="..."`. The literal three full stops are
 * impossible to produce from `sanitizeAgentSource()`, so their
 * presence proves we are looking at preamble text rather than a real
 * opening tag.
 */
export function shouldClearTruncatedPreamble(pane: string): boolean {
  if (!pane) return false
  const inputBox = liveInputBox(pane)
  if (inputBox == null) return false

  const hasPreamble =
    TRUSTED_PREAMBLE_MARKER.test(inputBox) ||
    UNTRUSTED_PREAMBLE_MARKER.test(inputBox)
  if (!hasPreamble) return false

  // A real opening tag means the wrapped content landed -- not stuck.
  if (REAL_OPENING_TAG_RX.test(inputBox)) return false

  return true
}

export type SubmitFollowupAction = 'retry-enter' | 'done' | 'give-up'

/**
 * Decide what the post-send-keys loop should do next, given the
 * current pane snapshot and how many retry-Enter attempts have already
 * been made. Returns one of three discrete actions so the caller can
 * branch without re-running the detection logic itself.
 *
 *   - 'done'        -- the prompt landed (or the pane is busy
 *                      processing); no further action.
 *   - 'retry-enter' -- the pane shows a stuck send; send another Enter
 *                      and re-sample.
 *   - 'give-up'     -- the retry budget is spent, or the capture failed
 *                      and we cannot tell whether retry would help.
 *                      Caller should log a warning and move on.
 *
 * Splitting the decision out as pure logic keeps the I/O-bound loop in
 * src/web/agent-process.ts trivially testable without mocking tmux or
 * child_process: feed snapshot strings + attempt counters in, assert
 * the action out.
 *
 * @param pane         The most recent capture-pane snapshot, or null
 *                     if the capture itself failed.
 * @param payloadHint  Substring of the just-sent prompt, used for the
 *                     verbatim-stuck detection path. Pass empty to
 *                     restrict detection to the placeholder path.
 * @param attempt      How many retry-Enters have ALREADY been sent
 *                     (0 on the first decision after the initial send).
 * @param maxAttempts  How many retry-Enters the caller is willing to
 *                     send total. The decision returns 'give-up' once
 *                     attempt >= maxAttempts and the pane is still
 *                     stuck.
 */
export function decideSubmitFollowup(
  pane: string | null,
  payloadHint: string,
  attempt: number,
  maxAttempts: number,
): SubmitFollowupAction {
  if (pane == null) return 'give-up'
  if (!shouldRetrySubmit(pane, payloadHint)) return 'done'
  if (attempt >= maxAttempts) return 'give-up'
  return 'retry-enter'
}
