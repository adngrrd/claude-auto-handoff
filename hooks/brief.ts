import type { SessionMessage } from 'claude-code'
import { renderTemplate, sectionHeadings } from './templates.ts'

// Brief building.
// Files, commits, issues and the last real request come from the transcript in code;
// Haiku only writes the judgment sections. Its reply is checked, and the facts alone
// stand in when it fails.

const MAX_MESSAGES = 120
const MAX_MSG_CHARS = 2_000
const MAX_TRANSCRIPT_CHARS = 150_000

// Harness signals that arrive as user messages but are never the user's words.
const META_PREFIXES = ['Stop hook feedback', '[Automatic handoff]', '[auto-handoff]', '[Image', '<system-reminder>', '<command-name>', '<local-command']

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const GIT_COMMIT_OUTPUT = /^\[[\w./-]+(?: \(root-commit\))? ([0-9a-f]{7,})\] (.+)$/m

export type Facts = {
  filesModified: string[]
  commits: string[]
  issues: string[]
  lastUserMessage?: string
  handoffTokens?: number
  threshold?: number
  /** Where the base threshold came from: the env override or the /config setting. */
  thresholdSource?: string
  seededSessionStartSize?: number
  /** Handoffs since the user last typed, this one included. */
  unattendedCount?: number
  /** Which handoff this is in its chain (1 for the first, 2 for the second, etc.). */
  depth?: number
}

/** The user's own words, or undefined for a harness signal or a tool-result-only message. */
export function userText(m: SessionMessage): string | undefined {
  if (m.role !== 'user') return undefined
  const raw = m.text.trim()
  if (!raw) return undefined
  return isMeta(raw) ? undefined : raw
}

function isMeta(text: string): boolean {
  return META_PREFIXES.some(p => text.startsWith(p))
}

function commitSubject(command: string): string | undefined {
  if (!/\bgit\b[^\n|;&]*\bcommit\b/.test(command)) return undefined
  const heredoc = command.match(/<<\s*'?(\w+)'?\n([\s\S]*?)\n\1/)
  if (heredoc) return heredoc[2]?.trim().split('\n')[0]
  return command.match(/-m\s+(["'])(.+?)\1/)?.[2]
}

/** ignoreFiles: paths that never count as edits (auto-synced state, caches); the ignoreFiles setting. */
export function extractFacts(messages: readonly SessionMessage[], ignoreFiles?: RegExp): Facts {
  const files = new Set<string>()
  const commits: string[] = []
  const issues = new Set<string>()
  let lastUserMessage: string | undefined
  for (const m of messages) {
    const said = userText(m)
    if (said) lastUserMessage = said
    for (const n of `${said ?? (m.role === 'assistant' ? m.text : '')}`.matchAll(/(?<![\w&/])#(\d{2,5})\b/g)) issues.add(`#${n[1]}`)
    for (const t of m.toolUses) {
      const path = t.input.file_path ?? t.input.notebook_path
      if (EDIT_TOOLS.has(t.tool) && typeof path === 'string' && !t.isError && !ignoreFiles?.test(path)) files.add(path)
      if (t.tool !== 'Bash' || typeof t.input.command !== 'string' || t.isError) continue
      // git's own "[main abc1234] subject" line is the proof a commit landed; the command is the fallback
      const out = t.text?.match(GIT_COMMIT_OUTPUT)
      const subject = out ? `${out[2]} (${out[1]})` : t.text === undefined ? commitSubject(t.input.command) : undefined
      if (subject && !commits.includes(subject)) commits.push(subject)
    }
  }
  return { filesModified: [...files].slice(-20), commits: commits.slice(-10), issues: [...issues].slice(-15), lastUserMessage }
}

/** The transcript as Haiku reads it. Harness signals are labelled so they are not taken for the user. */
export function renderTranscript(messages: readonly SessionMessage[], maxMessages = MAX_MESSAGES, maxChars = MAX_TRANSCRIPT_CHARS): string {
  const lines = messages.slice(-maxMessages).map(m => {
    const role = m.role === 'user' && m.text.trim() && !userText(m) ? 'system signal (not the user)' : m.role
    const text = m.text.length > MAX_MSG_CHARS ? m.text.slice(0, MAX_MSG_CHARS) + ' [truncated]' : m.text
    const tools = m.toolUses.map(t => `  [tool ${t.tool}${t.isError ? ' ERROR' : ''}] ${JSON.stringify(t.input).slice(0, 300)}`)
    return [`### ${role}`, text, ...tools].filter(Boolean).join('\n')
  })
  const joined = lines.join('\n\n')
  return joined.length > maxChars ? joined.slice(-maxChars) : joined
}

function list(items: string[], empty: string): string {
  return items.length ? items.map(i => `- ${i}`).join('\n') : empty
}

// The only token figures the brief may use. Haiku once wrote "burned its 200k budget" for a
// session at 93k because the prompt held no numbers at all.
function handoffNumbersBlock(f: Facts): string {
  const lines = []
  if (f.depth !== undefined) lines.push(`- **Handoff depth:** ${f.depth}`)
  if (f.handoffTokens !== undefined) lines.push(`- **Tokens at handoff:** ${f.handoffTokens} (${k(f.handoffTokens)})`)
  if (f.threshold !== undefined) lines.push(`- **Threshold:** ${f.threshold} (${k(f.threshold)})${f.thresholdSource ? `, from ${f.thresholdSource}` : ''}`)
  if (f.seededSessionStartSize !== undefined) lines.push(`- **This session's starting size (seeded from a handoff):** ${f.seededSessionStartSize} (${k(f.seededSessionStartSize)})`)
  if (f.unattendedCount !== undefined) lines.push(`- **Handoffs in a row with no user message:** ${f.unattendedCount}`)
  return lines.length ? `## Handoff Numbers\n${lines.join('\n')}\n` : ''
}

const k = (n: number) => `${Math.round(n / 1000)}k`

export function factsBlock(f: Facts, withLastMessage = true): string {
  const numbers = handoffNumbersBlock(f)
  const files = `## Files Modified (from Edit/Write calls)
${list(f.filesModified, 'None.')}

## Commits This Session
${list(f.commits, 'None.')}

## GitHub Issues Mentioned
${f.issues.length ? f.issues.join(', ') : 'None.'}`
  const all = [numbers, files].filter(Boolean).join('\n')
  return withLastMessage ? `${all}\n\n## Last Real User Message (verbatim)\n${f.lastUserMessage ?? 'None found.'}` : all
}

export function briefPrompt(messages: readonly SessionMessage[], facts: Facts, template: string): string {
  // Data first, instructions last. A single pass has nothing to append to, so the marks go.
  return `## Extracted Facts\n${factsBlock(facts)}\n\n## Conversation\n${renderTranscript(messages)}\n\n---\n\n${template.replaceAll(`${APPEND_MARK}\n`, '').trim()}`
}

// Rolling brief. With checkpoints on, Haiku updates the brief as the session grows, each pass
// reading only the conversation since the one before, so a brief written at 900k covers the whole
// session instead of its last MAX_MESSAGES messages. Sections marked APPEND_MARK in the template
// accumulate: Haiku writes only what is new and code appends it, so an early decision is never
// summarized away by later passes. Every other section is rewritten as of the latest pass.
export const APPEND_MARK = '<!-- rolling: append -->'
export const LAST_REQUEST_HEADING = '## Last Request from the User'
// A pass reads every message since the last one, so the message cap goes; the character cap
// stays, sized to Haiku's window with room for the brief so far.
const ROLLING_MAX_CHARS = 300_000

/** Where a session's rolling brief stands: messages covered, tokens at the last pass, the brief. */
export type Rolling = { covered: number; tokens: number; brief: string; passes: number }

type Section = { heading: string; body: string }

function sections(text: string): Section[] {
  return text.split(/^(?=## )/m).filter(p => p.startsWith('## ')).map(p => {
    const nl = p.indexOf('\n')
    return nl === -1 ? { heading: p.trim(), body: '' } : { heading: p.slice(0, nl).trim(), body: p.slice(nl + 1).trim() }
  })
}

const joinSections = (list: Section[]) => list.filter(s => s.body).map(s => `${s.heading}\n${s.body}`).join('\n\n')

export function dropSection(text: string, heading: string): string {
  return joinSections(sections(text).filter(s => sectionKey(s.heading) !== sectionKey(heading)))
}

export function rollingPrompt(previous: string | undefined, since: readonly SessionMessage[], facts: Facts, template: string): string {
  return `## Extracted Facts
${factsBlock(facts)}

## Brief So Far
<brief-so-far>
${previous?.trim() || 'None yet: this is the first pass.'}
</brief-so-far>

## Conversation Since the Brief So Far
${renderTranscript(since, Infinity, ROLLING_MAX_CHARS)}

---

This is one pass of a rolling handoff brief. The brief so far was written from earlier in this session; the conversation above is everything since. Write the sections below for the session as it stands at the end of that conversation:
- A section marked ${APPEND_MARK}: write only items from the conversation above that the brief so far does not already hold. Earlier items are kept for you, so do not repeat them. Leave the section out if there is nothing new.
- Every other section: write its whole current content, carrying forward anything from the brief so far that is still true. Leave it out if it would be empty.

${template.trim()}`
}

// Haiku's headings are matched loosely ("## Decisions made"), since a section it misspells would
// otherwise vanish from the merge.
const sectionKey = (heading: string) => heading.replace(/\s+/g, ' ').trim().toLowerCase()
const byKey = (text: string) => new Map(sections(text).map(s => [sectionKey(s.heading), s.body]))

/** Haiku's pass merged into the brief so far, in the template's section order. */
export function mergeBrief(previous: string, update: string, template: string): string {
  const append = new Set(sections(template).filter(s => s.body.includes(APPEND_MARK)).map(s => sectionKey(s.heading)))
  const before = byKey(previous)
  const after = byKey(update.replaceAll(APPEND_MARK, ''))
  return joinSections(sectionHeadings(template).map(heading => {
    const fresh = after.get(sectionKey(heading)) ?? ''
    if (!append.has(sectionKey(heading))) return { heading, body: fresh }
    const old = before.get(sectionKey(heading)) ?? ''
    const seen = new Set(old.split('\n').map(l => l.trim()))
    const added = fresh.split('\n').filter(l => l.trim() && !/^none\.?$/i.test(l.trim()) && !seen.has(l.trim()))
    return { heading, body: [old, ...added].filter(Boolean).join('\n') }
  }))
}

/** A reply that holds none of the template's sections is a dialogue fragment, not a brief. */
export function isValidBrief(text: string, template: string): boolean {
  return sectionHeadings(template).some(h => text.includes(h))
}

// Whether the brief's last-request section
// says the request is not (fully) answered. A chain with no user message is not a real request.
export function hasUnansweredLastRequest(text: string): boolean {
  const heading = /##\s*Last Request from the User/i.exec(text)
  if (!heading) return false
  const rest = text.slice(heading.index + heading[0].length)
  const next = /^#{1,6}\s/m.exec(rest)
  const section = next ? rest.slice(0, next.index) : rest
  if (/No user message found|^\s*\[auto-handoff\]/i.test(section)) return false
  return /\bStatus[\s*_`]*:[\s*_`"]*(Not (?:yet |fully )?answered|Partially answered|Unanswered)/i.test(section)
}

export type BriefContext = {
  sessionId: string
  /** The session's transcript file. */
  transcript: string
  /** The instructions template, rendered at the top of the brief. */
  instructions: string
  /** Set when a rolling brief was used: its passes, and whether the last one covered the session's end. */
  rolling?: { passes: number; complete: boolean }
}

function provenance(ctx: BriefContext, haiku: string | undefined): string {
  if (!haiku) return 'Haiku did not return a usable brief, so this holds only facts extracted in code. Read the transcript for the rest.'
  if (!ctx.rolling) return 'Haiku wrote the judgment sections from conversation text with tool output abbreviated. The facts sections came from tool calls in code.'
  const { passes, complete } = ctx.rolling
  const built = `Haiku built the judgment sections in ${passes} pass${passes === 1 ? '' : 'es'} as the session grew, each reading only the conversation since the one before, with tool output abbreviated.`
  return complete
    ? `${built} The facts sections came from tool calls in code.`
    : `${built} The last pass failed, so they stop at the last checkpoint: the conversation after it is only in the transcript, and the facts quote the last request.`
}

export function assembleBrief(ctx: BriefContext, facts: Facts, haiku: string | undefined): string {
  const header = `${renderTemplate(ctx.instructions, { priority: haiku ? hasUnansweredLastRequest(haiku) : false })}

## Session Handoff Brief

- **Previous Session:** ${ctx.sessionId}
- **Transcript:** \`${ctx.transcript}\`

## How to Use This Brief
${provenance(ctx, haiku)} Treat every line as a starting point, not a fact. Before acting on anything here, spawn a subagent to verify: run git status, gh pr view, or Read the file directly. If a fact is missing, grep the transcript before asking the user.`
  // A valid Haiku brief already quotes the last request in its own section; a rolling brief
  // whose last pass failed has had that stale section dropped.
  return [header, haiku?.trim(), factsBlock(facts, !haiku || ctx.rolling?.complete === false)].filter(Boolean).join('\n\n')
}

// A token figure: "93k", "93.1k", "93,105 tokens", "93105 tokens".
const TOKEN_FIGURE = /\b(\d{1,4}(?:\.\d+)?)k\b|\b(\d{1,3}(?:,\d{3})+|\d{4,7})(?= tokens\b)/gi

const figureValue = (k?: string, whole?: string) => k !== undefined ? Number(k) * 1000 : Number(whole!.replace(/,/g, ''))

/**
 * Marks every token figure in Haiku's text that the Handoff Numbers block does not hold, within
 * rounding to the nearest thousand. The template asks Haiku to copy those numbers; this makes it a
 * rule. Figures are marked, not removed, so the next session sees what was claimed and that it is
 * unchecked. With no numbers block, every figure is marked.
 */
export function markUnverifiedFigures(text: string, f: Facts): { text: string; flagged: string[] } {
  const block = handoffNumbersBlock(f)
  const allowed = [
    ...[...block.matchAll(/\b(\d{1,4}(?:\.\d+)?)k\b/g)].map(m => figureValue(m[1])),
    ...[...block.matchAll(/\b\d{4,7}\b/g)].map(m => Number(m[0])),
  ]
  const flagged: string[] = []
  const marked = text.replace(TOKEN_FIGURE, (match: string, k?: string, whole?: string) => {
    const value = figureValue(k, whole)
    if (allowed.some(a => Math.abs(a - value) < 1000)) return match
    flagged.push(match)
    return `${match} [unverified: not in Handoff Numbers]`
  })
  return { text: marked, flagged }
}
