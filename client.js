window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState, useSyncExternalStore } = React

    const NS = 'session-delete'
    const ROUTE = '/plugin-session-delete'
    const PENDING_ROUTE = '/plugin-session-delete/pending'
    const PENDING_ACK_ROUTE = '/plugin-session-delete/pending/ack'
    // How often the frame-wide dialog asks the Host whether `/delete` raised a
    // confirmation. Cheap loopback GET; the Host drops stale entries itself.
    const PENDING_POLL_MS = 1200

    // The host menu-row primitive is an implicit baseline external for a Module
    // Loader package. It is optional here: when the module table does not expose
    // it, the plugin falls back to its own native-looking button.
    let MenuItemButton = null
    try {
      MenuItemButton = require('@deepseek-ai/dsh-client-ui-primitives').MenuItemButton || null
    } catch {
      MenuItemButton = null
    }

    const EN = {
      menuDelete: 'Delete session',
      dialogTitle: 'Delete session',
      dialogBody: 'The stored log is removed from disk. This cannot be undone.',
      dialogNote: 'An open session is archived and stopped first; a log that stays locked is left in place.',
      cancel: 'Cancel',
      confirm: 'Delete permanently',
      working: 'Deleting…',
      done: 'Session deleted',
      started: 'Deletion started',
      nothingDone: 'Session not deleted: {reason}',
      reasonBusy: 'the session log is still locked by its running session',
      reasonMissing: 'the session files were not found',
      reasonArchive: 'the session could not be archived, so its files were left untouched',
      reasonFailed: 'the request failed',
      failed: 'Delete request failed',
      unnamed: 'Untitled session',
      currentSession: 'This session',
      dialogAria: 'Delete session',
    }

    const ZH = {
      menuDelete: '删除会话',
      dialogTitle: '删除会话',
      dialogBody: '该会话的日志将从磁盘移除，此操作无法撤销。',
      dialogNote: '打开中的会话会先归档并停止运行；日志仍被占用时会跳过。',
      cancel: '取消',
      confirm: '永久删除',
      working: '正在删除…',
      done: '已删除会话',
      started: '已开始删除',
      nothingDone: '未删除会话：{reason}',
      reasonBusy: '会话仍在运行，日志文件被占用',
      reasonMissing: '未找到会话文件',
      reasonArchive: '会话归档失败，文件未改动',
      reasonFailed: '请求失败',
      failed: '删除请求失败',
      unnamed: '未命名会话',
      currentSession: '当前会话',
      dialogAria: '删除会话',
    }

    /**
     * The single pending delete request shown by the frame-wide dialog, opened
     * either by a Session menu row or by the Host after `/delete`.
     *
     * `detached` marks a request against the session that is open right now: its
     * archival stops that very session, so the Host finishes the removal after
     * answering instead of inside the request.
     */
    function createRequests() {
      let request = null
      const listeners = new Set()
      const publish = next => {
        if (next === request) return
        request = next
        for (const listener of [...listeners]) listener()
      }
      return {
        getSnapshot: () => request,
        subscribe(fn) {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
        open(sessionId, title, detached) {
          publish({ sessionId, title, detached: detached === true })
        },
        close() {
          publish(null)
        },
      }
    }

    const fallbackMenuStyle = hover => ({
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      width: '100%',
      minHeight: 34,
      padding: '6px 8px',
      border: 'none',
      borderRadius: 'var(--dsw-radius-md, 8px)',
      background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      textAlign: 'left',
      cursor: 'pointer',
    })

    const ghostButtonStyle = {
      padding: '5px 10px',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 8,
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: 13,
      cursor: 'pointer',
    }

    const dangerButtonStyle = busy => ({
      padding: '5px 12px',
      border: '1px solid transparent',
      borderRadius: 8,
      background: 'var(--dsw-alias-state-error-primary)',
      color: 'var(--dsw-alias-bg-base)',
      font: 'inherit',
      fontSize: 13,
      fontWeight: 600,
      cursor: busy ? 'progress' : 'pointer',
      opacity: busy ? 0.7 : 1,
    })

    const backdropStyle = {
      position: 'fixed',
      inset: 0,
      zIndex: 70,
      display: 'grid',
      placeItems: 'center',
      padding: 24,
      background: 'rgba(0, 0, 0, 0.45)',
      pointerEvents: 'auto',
    }

    const cardStyle = {
      width: 'min(420px, 100%)',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      padding: '16px 18px',
      borderRadius: 14,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      boxShadow: '0 18px 48px rgba(0, 0, 0, 0.35)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      lineHeight: 1.5,
    }

    const titleStyle = {
      margin: 0,
      fontSize: 15,
      fontWeight: 600,
    }

    const subjectStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
      padding: '7px 10px',
      borderRadius: 8,
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
    }

    const subjectTitleStyle = {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    // The session id under the title: smaller, dimmed, mono so it reads as an id.
    const subjectIdStyle = {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      fontSize: 11.5,
      color: 'var(--dsw-alias-label-tertiary)',
    }

    const noteStyle = {
      color: 'var(--dsw-alias-state-warn-primary)',
      fontSize: 12,
    }

    const footerStyle = {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 8,
    }

    const noticeStyle = {
      pointerEvents: 'auto',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      padding: '7px 12px',
      borderRadius: 10,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-overlay)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 12.5,
    }

    const noticeDotStyle = kind => ({
      width: 8,
      height: 8,
      borderRadius: 4,
      background: kind === 'ok'
        ? 'var(--dsw-alias-state-success-primary)'
        : 'var(--dsw-alias-state-error-primary)',
    })

    // The host menu row paints its icon slot (14px, --dsw-alias-menu-icon), so
    // the artwork only has to be a currentColor glyph at that size.
    function trashIcon() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        'aria-hidden': true,
        focusable: 'false',
      }, [
        h('path', {
          key: 'lid',
          d: 'M2.6 4.3h10.8M6.1 4.3V2.9a.8.8 0 0 1 .8-.8h2.2a.8.8 0 0 1 .8.8v1.4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          key: 'body',
          d: 'M4.2 4.3 4.9 13a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.7-8.7',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ])
    }

    function MenuDelete(props) {
      const requests = props.requests
      const t = props.t || props.fallbackT
      const sessionId = props.sessionId
      const displayTitle = props.displayTitle
      const [hover, setHover] = useState(false)
      const useMenuOpenState = props.useMenuOpenState
      const menuState = useMenuOpenState ? useMenuOpenState() : undefined
      const setMenuOpen = menuState ? menuState[1] : () => {}

      const act = () => {
        setMenuOpen(false)
        requests.open(sessionId, displayTitle, false)
      }

      // The host primitive owns the row layout: `icon` fills its 14px icon slot
      // (colored by --dsw-alias-menu-icon), children are the label slot.
      if (MenuItemButton) {
        return h(MenuItemButton, { icon: trashIcon(), onSelect: act }, t('menuDelete'))
      }
      return h('button', {
        type: 'button',
        role: 'menuitem',
        style: fallbackMenuStyle(hover),
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onClick: act,
      }, [
        h('span', {
          key: 'icon',
          style: {
            display: 'inline-flex',
            flex: 'none',
            alignItems: 'center',
            justifyContent: 'center',
            width: 14,
            height: 14,
            color: 'var(--dsw-alias-menu-icon, currentColor)',
          },
        }, trashIcon()),
        h('span', { key: 'label', style: { flex: 1, minWidth: 0 } }, t('menuDelete')),
      ])
    }

    function DeleteDialog(props) {
      const requests = props.requests
      const t = props.t || props.fallbackT
      const request = useSyncExternalStore(requests.subscribe, requests.getSnapshot)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const cancelRef = useRef(null)

      useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => setNotice(null), 9000)
        return () => clearTimeout(timer)
      }, [notice])

      useEffect(() => {
        if (!request) return undefined
        if (cancelRef.current && typeof cancelRef.current.focus === 'function') cancelRef.current.focus()
        return undefined
      }, [request])

      useEffect(() => {
        if (!request || busy) return undefined
        const onKeyDown = event => {
          if (event.key === 'Escape') requests.close()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [request, busy, requests])

      // `/delete` raises its confirmation on the Host; pick it up and show the
      // same dialog a Session menu row shows.
      useEffect(() => {
        let stopped = false
        let timer = null
        const ack = id => {
          fetch(PENDING_ACK_ROUTE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          }).catch(() => {})
        }
        const tick = async () => {
          try {
            const response = await fetch(PENDING_ROUTE, {
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            })
            if (response.ok) {
              const payload = await response.json().catch(() => null)
              const open = payload && payload.ok === true && Array.isArray(payload.requests)
                ? payload.requests
                : []
              const first = open[0]
              if (first && !requests.getSnapshot()) {
                requests.open(first.sessionId, '', true)
                ack(first.id)
              }
            }
          } catch {
            /* offline or Host restarting: the next tick retries */
          }
          if (!stopped) timer = setTimeout(tick, PENDING_POLL_MS)
        }
        tick()
        return () => {
          stopped = true
          if (timer) clearTimeout(timer)
        }
      }, [requests])

      if (!request && !notice) return null

      const closeDialog = () => {
        if (busy) return
        requests.close()
      }

      const report = status => {
        if (status === 'deleted') return setNotice({ kind: 'ok', text: t('done') })
        if (status === 'accepted') return setNotice({ kind: 'ok', text: t('started') })
        const reason = status === 'missing'
          ? t('reasonMissing')
          : status === 'archive-failed'
            ? t('reasonArchive')
            : status === 'busy'
              ? t('reasonBusy')
              : t('reasonFailed')
        return setNotice({ kind: 'error', text: t('nothingDone', { reason }) })
      }

      const runDelete = async entry => {
        setBusy(true)
        const lookup = props.service
        const uiWorkspace = lookup ? lookup('uiWorkspace') : undefined
        const sessions = lookup ? lookup('sessions') : undefined
        // Archive through the Client's own workspace service first: it is the
        // route the shipped "Archive session" row takes, so the sidebar drops
        // this row right away. A Host-side archive alone stays invisible to the
        // Client list, which is how deleted sessions used to linger until a
        // page reload.
        if (uiWorkspace && typeof uiWorkspace.archiveSession === 'function') {
          try {
            await uiWorkspace.archiveSession(entry.sessionId, { stopActivity: true })
          } catch {
            /* the Host retries the archive while removing the files */
          }
        }
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: entry.sessionId, detached: entry.detached === true }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || !payload || payload.ok !== true) {
            setNotice({ kind: 'error', text: t('failed') })
            return
          }
          report(payload.status)
        } catch {
          setNotice({ kind: 'error', text: t('failed') })
        } finally {
          if (sessions && typeof sessions.refresh === 'function') {
            try {
              await sessions.refresh()
            } catch {
              /* the list refreshes on its own schedule */
            }
          }
          setBusy(false)
          requests.close()
        }
      }

      const layers = []

      if (request) {
        layers.push(h('div', {
          key: 'dialog',
          style: backdropStyle,
          onMouseDown(event) {
            if (event.target === event.currentTarget) closeDialog()
          },
        }, h('div', {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('dialogAria'),
          style: cardStyle,
        }, [
          h('h2', { key: 'title', style: titleStyle }, t('dialogTitle')),
          h('p', { key: 'body', style: { margin: 0 } }, t('dialogBody')),
          h('div', {
            key: 'subject',
            style: subjectStyle,
            title: request.title || '',
          }, [
            h('div', {
              key: 'title',
              style: subjectTitleStyle,
            }, request.title || (request.detached ? t('currentSession') : t('unnamed'))),
            h('div', {
              key: 'id',
              style: subjectIdStyle,
              title: request.sessionId,
            }, request.sessionId),
          ]),
          h('div', { key: 'note', style: noteStyle }, t('dialogNote')),
          h('div', { key: 'footer', style: footerStyle }, [
            h('button', {
              key: 'cancel',
              ref: cancelRef,
              type: 'button',
              style: ghostButtonStyle,
              disabled: busy,
              onClick: closeDialog,
            }, t('cancel')),
            h('button', {
              key: 'confirm',
              type: 'button',
              style: dangerButtonStyle(busy),
              disabled: busy,
              onClick: () => runDelete(request),
            }, busy ? t('working') : t('confirm')),
          ]),
        ])))
      }

      if (notice) {
        layers.push(h('div', { key: 'notice', style: noticeStyle }, [
          h('span', { key: 'dot', style: noticeDotStyle(notice.kind) }),
          h('span', { key: 'text' }, notice.text),
        ]))
      }

      return h('div', {
        style: {
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 60,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          paddingBottom: 18,
          pointerEvents: 'none',
        },
      }, layers)
    }

    function apply(ctx) {
      ctx.effect(() => {
        const offEn = ctx.locale.register(NS, 'en', EN)
        const offZh = ctx.locale.register(NS, 'zh', ZH)
        const offZhCn = ctx.locale.register(NS, 'zh-CN', ZH)
        return () => {
          offZhCn()
          offZh()
          offEn()
        }
      }, 'session-delete: dictionaries')

      const requests = createRequests()
      // Resolved per call: the Client services mount independently of this plugin.
      const service = key => {
        try {
          return ctx.get(key)
        } catch {
          return undefined
        }
      }
      const inject = () => ({ requests, fallbackT: ctx.locale.bind(NS), service })

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'session-delete.menu',
        order: 500,
        locale: NS,
        inject,
      }, MenuDelete))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'session-delete.dialog',
        order: 20,
        locale: NS,
        inject,
      }, DeleteDialog))
    }

    return {
      // `uiWorkspace` and `sessions` are the Client services this plugin needs to
      // make a deletion visible: the archive the sidebar understands, and the
      // list refresh that drops a session whose log is gone. Declaring them here
      // is what guarantees they exist on this context.
      inject: ['slots', 'locale', 'uiWorkspace', 'sessions'],
      apply,
    }
  },
})
