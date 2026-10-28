/**
 * Host half of the session delete plugin.
 *
 * The Harness ships no session deletion (sessions are archived, never removed),
 * so this plugin removes the durable session artifacts itself:
 *
 *   <DSH_HOME>/sessions/<project>/session-<id>/          (the append-only log dir)
 *   <DSH_HOME>/storages/session_projcache/sessions/<id>.json  (derived cache)
 *
 * Two entry points, one confirmation:
 *
 *   - the sidebar Session menu ("Delete session") opens the confirm dialog in
 *     the Client half directly;
 *   - `/delete` raises the same confirmation through a small queue the Client
 *     half polls, so the command never deletes without asking.
 *
 * Both then POST `/plugin-session-delete`. Before touching the files the delete
 * archives the session through the shipped registry (with `stopActivity`), which
 * is what makes the sidebar row disappear live and stops any running work. The
 * archive mark is left in place as a tombstone, so a stale in-memory summary
 * never resurfaces as a visible row.
 *
 * Deleting the session the command was typed in is supported: the Client asks
 * for `detached` deletion there, because that archival stops the very session
 * holding the log and the runtime has to let the file go first.
 */

import { existsSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ROUTE_PATH = '/plugin-session-delete'
const PENDING_PATH = '/plugin-session-delete/pending'
const PENDING_ACK_PATH = '/plugin-session-delete/pending/ack'
const MAX_BODY_BYTES = 64 * 1024
const SESSION_ID_PATTERN = /^session-[A-Za-z0-9-]{1,80}$/
const PENDING_TTL_MS = 2 * 60 * 1000

/** The human command that asks to delete the session it is typed in. */
const COMMAND_NAME = 'delete'
const COMMAND_DESCRIPTION = 'Delete this session and its stored log permanently'

/** Confirmation requests raised by `/delete`, drained by the Client half. */
const pendingConfirms = new Map()
let pendingSeq = 0

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function sessionRoot() {
  return path.join(dshHome(), 'sessions')
}

function projectionCacheFile(sessionId) {
  return path.join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
}

function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Every on-disk directory of one session (project directories are one level deep). */
async function findSessionDirs(sessionId) {
  const root = sessionRoot()
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = path.join(root, project.name, sessionId)
    if (existsSync(candidate)) found.push(candidate)
  }
  return found
}

async function removeProjectionCache(sessionId) {
  try {
    await rm(projectionCacheFile(sessionId), { force: true })
  } catch {
    /* best effort: a stale cache file for a deleted session is never read */
  }
}

/** Subagent descendants of one session, breadth first (parents before children). */
async function collectDescendants(ctx, root) {
  const persistence = ctx.get('sessionPersistence')
  if (!persistence || typeof persistence.list !== 'function') return []
  let snapshots
  try {
    snapshots = await persistence.list()
  } catch {
    return []
  }
  const children = new Map()
  for (const snapshot of snapshots) {
    const header = snapshot && snapshot.header
    if (!header || !header.parentSession) continue
    const list = children.get(header.parentSession) || []
    list.push(header.id)
    children.set(header.parentSession, list)
  }
  const seen = new Set([root])
  const descendants = []
  const queue = [root]
  while (queue.length > 0) {
    const id = queue.shift()
    for (const child of children.get(id) || []) {
      if (seen.has(child)) continue
      seen.add(child)
      descendants.push(child)
      queue.push(child)
    }
  }
  return descendants
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Tell the Host session catalogue that this session left the registry, so the
 * sidebar drops its row in place instead of waiting for a page reload (and so a
 * stale row can never be "unarchived" back into the list).
 */
function notifyRemoved(ctx, sessionId) {
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch {
    /* a notification with no listener is not a failure */
  }
}

/** Wait (briefly) for a stopped session's runtime to drop its handles. */
async function waitForRelease(isLive, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!isLive()) return
    await delay(120)
  }
}

/**
 * Release the live runtime of one session.
 *
 * Archiving only stops running work; it leaves an idle Agent registered, and an
 * idle Agent keeps the session in `sessionQuery.listSessions()`, which is what
 * the Client session list renders. Disposing the Agent's scope is the same
 * teardown the agent loop itself performs: it emits `session/disposed`, so the
 * session controller emits `api-session/removed` and the Client drops the row.
 */
async function releaseAgent(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') return false
  const agent = agents.get(sessionId)
  if (!agent) return false
  const scope = agent.scope
  if (!scope || typeof scope.dispose !== 'function') return false
  try {
    await scope.dispose()
    return true
  } catch {
    return false
  }
}

/**
 * Remove one session from the in-memory store, the same way its owning fiber
 * would: this is what emits `session/disposed`, which the session controller
 * turns into `api-session/removed`, which is what actually drops the row from
 * the Client session list.
 *
 * The store has no public removal API: `enter()` returns the only detach
 * handle, and it rejects a second entry for the same id. The store keeps the
 * live entries in `store`, and `detachEntered(entry)` is the teardown those
 * handles call, so we reuse it on the existing entry.
 */
function detachStoredSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions !== 'object') return false
  const store = sessions.store
  if (!store || typeof store.get !== 'function') return false
  const entry = store.get(sessionId)
  if (!entry) return false
  try {
    if (typeof sessions.detachEntered === 'function') {
      sessions.detachEntered(entry)
      return true
    }
    if (typeof entry.detach === 'function') {
      entry.detach()
      return true
    }
  } catch {
    return false
  }
  return false
}

/** Session ids this DSH home has archived, read from the workspace registry file. */
async function readArchivedIds() {
  try {
    const raw = await readFile(path.join(dshHome(), 'storages', 'workspace.json'), 'utf8')
    const document = JSON.parse(raw)
    const ids = document && document.global && document.global.archivedSessionIds
    return new Set(Array.isArray(ids) ? ids : [])
  } catch {
    return new Set()
  }
}

/**
 * Release runtimes whose session is already gone from disk.
 *
 * Deleting the files leaves the Agent registered until the process ends, which
 * is why a removed session could keep showing up in the sidebar (and why only a
 * restart cleared it). Restricting the sweep to archived ids keeps ordinary
 * blank sessions, which have no log yet, out of it.
 */
async function purgeOrphans(ctx) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.list !== 'function') return
  const archived = await readArchivedIds()
  if (archived.size === 0) return
  const persistence = ctx.get('sessionPersistence')
  for (const agent of agents.list()) {
    const sessionId = String(agent.id)
    if (!archived.has(sessionId)) continue
    if ((await findSessionDirs(sessionId)).length > 0) continue
    let stored = false
    if (persistence && typeof persistence.stat === 'function') {
      try {
        stored = Boolean(await persistence.stat(sessionId))
      } catch {
        stored = false
      }
    }
    if (stored) continue
    await releaseAgent(ctx, sessionId)
    detachStoredSession(ctx, sessionId)
  }
}

async function deleteSession(ctx, sessionId, options = {}) {
  const releaseMs = options.releaseMs === undefined ? 2500 : options.releaseMs
  const attempts = options.attempts === undefined ? 8 : options.attempts
  const agents = ctx.get('agents')
  const registry = ctx.get('workspaceRegistry')
  const persistence = ctx.get('sessionPersistence')
  const isLive = () => Boolean(agents && typeof agents.get === 'function' && agents.get(sessionId))

  let dirs = await findSessionDirs(sessionId)
  let stored = false
  if (persistence && typeof persistence.stat === 'function') {
    try {
      stored = Boolean(await persistence.stat(sessionId))
    } catch {
      stored = false
    }
  }
  if (dirs.length === 0 && !stored) {
    await removeProjectionCache(sessionId)
    notifyRemoved(ctx, sessionId)
    return { id: sessionId, status: 'missing' }
  }

  // Archive first: it hides the sidebar row immediately, releases the main-view
  // reference when this is the open session, and asks the stop providers to end
  // any running work before the files disappear. The Client half normally
  // archived already (so its own list drops the row), which makes this a
  // best-effort no-op; a failure here must not block the removal itself.
  const live = isLive()
  if (registry && typeof registry.archiveSession === 'function') {
    try {
      await registry.archiveSession(sessionId, { stopActivity: true })
    } catch {
      /* already archived, or the registry refused: the files still go */
    }
  }

  // Release the runtime before the files disappear: archiving alone leaves an
  // idle Agent registered, and that Agent keeps the session in the Host list the
  // sidebar renders. A runtime that refuses to go gets the old grace period.
  if (live && !(await releaseAgent(ctx, sessionId))) await waitForRelease(isLive, releaseMs)
  detachStoredSession(ctx, sessionId)
  await delay(120)

  dirs = await findSessionDirs(sessionId)
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      for (const dir of dirs) await rm(dir, { recursive: true, force: true })
      lastError = undefined
      break
    } catch (error) {
      lastError = error
      await delay(150)
    }
  }
  if (lastError) {
    // The session is already archived (hidden); the log itself is still locked.
    return { id: sessionId, status: live ? 'busy' : 'delete-failed', detail: describe(lastError) }
  }
  await removeProjectionCache(sessionId)
  notifyRemoved(ctx, sessionId)
  return { id: sessionId, status: 'deleted' }
}

/** Delete one session and its subagent descendants, children first. */
async function deleteTree(ctx, sessionId, options) {
  const descendants = await collectDescendants(ctx, sessionId)
  let target
  for (const id of [...descendants.reverse(), sessionId]) {
    let result
    try {
      result = await deleteSession(ctx, id, options)
    } catch (error) {
      result = { id, status: 'delete-failed', detail: describe(error) }
    }
    if (id === sessionId) target = result
  }
  return { target, descendants: descendants.length }
}

/**
 * Remove one session without holding the caller open, for a session that must
 * stop first (the one the `/delete` command was typed in). The small head start
 * lets the `command/run` and `command/done` records land in the log before the
 * log itself disappears.
 */
async function deleteDetached(ctx, sessionId) {
  await delay(600)
  try {
    await deleteTree(ctx, sessionId, { releaseMs: 20000, attempts: 40 })
  } catch {
    /* the session stays archived and hidden; nothing is left to report to */
  }
}

/** Queue one confirmation for the Client half, replacing any earlier one. */
function enqueueConfirm(sessionId) {
  for (const [id, entry] of pendingConfirms) {
    if (entry.sessionId === sessionId) pendingConfirms.delete(id)
  }
  pendingSeq += 1
  const id = String(pendingSeq)
  pendingConfirms.set(id, { id, sessionId, at: Date.now() })
  return id
}

function drainPending() {
  const now = Date.now()
  const open = []
  for (const [id, entry] of pendingConfirms) {
    if (now - entry.at > PENDING_TTL_MS) {
      pendingConfirms.delete(id)
      continue
    }
    open.push({ id, sessionId: entry.sessionId })
  }
  return open
}

function respond(res, status, payload) {
  if (res.writableEnded) return
  const body = payload === undefined ? '' : JSON.stringify(payload)
  res.writeHead(status, body ? { 'content-type': 'application/json; charset=utf-8' } : undefined)
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/** Reuse the application's own Host/Origin and browser-credential checks. */
function reject(ctx, req, res) {
  const connection = ctx.get('connection')
  if (!connection || typeof connection.requestRejection !== 'function') return false
  const rejection = connection.requestRejection({ headers: req.headers })
  if (!rejection) return false
  respond(res, rejection, { ok: false, error: 'rejected' })
  return true
}

async function handleDeleteRequest(ctx, req, res) {
  if (reject(ctx, req, res)) return

  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }

  const body = await readJsonBody(req)
  if (body === undefined) {
    respond(res, 413, { ok: false, error: 'body-too-large' })
    return
  }
  if (body === null || typeof body !== 'object') {
    respond(res, 400, { ok: false, error: 'invalid-json' })
    return
  }

  const sessionId = body.sessionId
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    respond(res, 400, { ok: false, error: 'invalid-session-id' })
    return
  }

  // The Client asks for `detached` when the target is the session that is open
  // right now: archiving it stops it from under the request.
  if (body.detached === true) {
    deleteDetached(ctx, sessionId)
    respond(res, 200, { ok: true, id: sessionId, status: 'accepted' })
    return
  }

  const { target, descendants } = await deleteTree(ctx, sessionId)
  respond(res, 200, {
    ok: true,
    id: sessionId,
    status: target.status,
    detail: target.detail,
    children: descendants,
  })
}

async function handlePendingRequest(ctx, req, res) {
  if (reject(ctx, req, res)) return
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' })
    res.end()
    return
  }
  respond(res, 200, { ok: true, requests: drainPending() })
}

async function handleAckRequest(ctx, req, res) {
  if (reject(ctx, req, res)) return
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  const body = await readJsonBody(req)
  if (!body || typeof body !== 'object' || typeof body.id !== 'string') {
    respond(res, 400, { ok: false, error: 'invalid-id' })
    return
  }
  pendingConfirms.delete(body.id)
  respond(res, 200, { ok: true })
}

/** `/delete`: raise the same confirmation the Session menu raises. */
function registerCommand(ctx) {
  return ctx.effect(() => ctx.commands.register({
    name: COMMAND_NAME,
    description: COMMAND_DESCRIPTION,
    handler: (invocation) => {
      if (invocation.rawInput.trim().length > 0) {
        return { kind: 'error', text: 'Usage: /delete (no arguments)' }
      }
      const sessionId = String(invocation.agent.id)
      if (!SESSION_ID_PATTERN.test(sessionId)) {
        return { kind: 'error', text: 'This session could not be identified; nothing was deleted.' }
      }
      enqueueConfirm(sessionId)
      return { kind: 'success', text: 'Confirm the deletion in the dialog that just opened.' }
    },
  }), 'session-delete: command')
}

// Only the route carrier and the command registry are hard dependencies; every
// other Host service used by the handler is resolved lazily through ctx.get()
// so the plugin still activates in a composition that lacks one of them.
export const inject = ['webServer', 'commands']

export function apply(ctx) {
  // Heal sessions deleted by an older build: their files are gone but they were
  // never detached from the live store, so they kept showing in the sidebar.
  purgeOrphans(ctx).catch(() => {})
  const fail = res => (error) => {
    try {
      respond(res, 500, { ok: false, error: 'internal', detail: describe(error) })
    } catch {
      /* the response owner already closed the socket */
    }
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (req, res) => { handleDeleteRequest(ctx, req, res).catch(fail(res)) },
    }),
    'session-delete: delete route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: PENDING_PATH,
      handler: (req, res) => { handlePendingRequest(ctx, req, res).catch(fail(res)) },
    }),
    'session-delete: pending route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: PENDING_ACK_PATH,
      handler: (req, res) => { handleAckRequest(ctx, req, res).catch(fail(res)) },
    }),
    'session-delete: pending ack route',
  )

  registerCommand(ctx)
}
