(function () {
  function uuid() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID()
    return `hd-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  function bridgeTokenFromLocation() {
    return new URLSearchParams(globalThis.location.hash.slice(1)).get('hyperdeskBridgeToken') || ''
  }

  function connect(options = {}) {
    const bridgeToken = options.bridgeToken || bridgeTokenFromLocation()
    const target = options.target || globalThis.parent
    const timeoutMs = Number(options.timeoutMs || 30000)
    const pending = new Map()
    const commandHandlers = new Map()
    const eventHandlers = new Set()
    const themeHandlers = new Set()

    function request(method, params = {}, requestOptions = {}) {
      if (!bridgeToken) return Promise.reject(new Error('HyperDesk bridge token is missing'))
      const requestId = uuid()
      target.postMessage({ type: 'hyperdesk:request', requestId, method, params, bridgeToken }, '*')
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!pending.has(requestId)) return
          pending.delete(requestId)
          reject(new Error(`${method} timed out`))
        }, Number(requestOptions.timeoutMs || timeoutMs))
        pending.set(requestId, { resolve, reject, timeout })
      })
    }

    function onMessage(event) {
      const message = event.data || {}
      if (message.type === 'hyperdesk:response') {
        const waiter = pending.get(message.requestId)
        if (!waiter) return
        pending.delete(message.requestId)
        clearTimeout(waiter.timeout)
        if (message.error) waiter.reject(new Error(message.error))
        else waiter.resolve(message.payload)
        return
      }
      if (message.type === 'hyperdesk:theme') {
        for (const handler of themeHandlers) handler(message.payload || {})
        return
      }
      if (message.type === 'hyperdesk:event') {
        for (const handler of eventHandlers) handler(message.payload || {})
        return
      }
      if (message.type === 'hyperdesk:command') {
        const payload = message.payload || {}
        const command = String(payload.command || '')
        const handlers = commandHandlers.get(command) || []
        for (const handler of handlers) handler(payload.data, payload)
      }
    }

    globalThis.addEventListener('message', onMessage)

    function onCommand(command, handler) {
      const name = String(command || '')
      const handlers = commandHandlers.get(name) || []
      handlers.push(handler)
      commandHandlers.set(name, handlers)
      return () => {
        const next = (commandHandlers.get(name) || []).filter(item => item !== handler)
        if (next.length) commandHandlers.set(name, next)
        else commandHandlers.delete(name)
      }
    }

    function onTheme(handler) {
      themeHandlers.add(handler)
      return () => themeHandlers.delete(handler)
    }

    function onAgentEvent(handler) {
      eventHandlers.add(handler)
      return () => eventHandlers.delete(handler)
    }

    function destroy() {
      globalThis.removeEventListener('message', onMessage)
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timeout)
        waiter.reject(new Error('HyperDesk widget bridge destroyed'))
      }
      pending.clear()
      commandHandlers.clear()
      eventHandlers.clear()
      themeHandlers.clear()
    }

    return {
      bridgeToken,
      request,
      destroy,
      onCommand,
      onTheme,
      onAgentEvent,
      theme: { current: () => request('theme.current') },
      session: { summary: () => request('session.summary') },
      // Project-scoped file reads. New intent-first name; workspace.* and
      // file.* are accepted as legacy aliases and route to the same handlers.
      project: {
        listFiles: (params = {}) => request('project.listFiles', params),
        readFile: (pathOrParams, params = {}) => request('project.readFile', typeof pathOrParams === 'string' ? { ...params, path: pathOrParams } : (pathOrParams || {}))
      },
      workspace: {
        listFiles: (params = {}) => request('workspace.listFiles', params),
        readFile: (pathOrParams, params = {}) => request('workspace.readFile', typeof pathOrParams === 'string' ? { ...params, path: pathOrParams } : (pathOrParams || {}))
      },
      // User-visible navigation from widget UI (links, docs, dashboards).
      // navigator.open opens in the HyperDesk visible Chrome/workspace; it never
      // routes to the hidden background browser. Use automation.browser.* for
      // scripted browser control.
      navigator: {
        open: (urlOrParams, params = {}) => request('navigator.open', typeof urlOrParams === 'string' ? { ...params, url: urlOrParams } : (urlOrParams || {})),
        openExternal: (urlOrParams, params = {}) => request('navigator.openExternal', typeof urlOrParams === 'string' ? { ...params, url: urlOrParams } : (urlOrParams || {}))
      },
      // Browser automation/inspection. Intent-first name for widgets that drive
      // a browser backend (may be background or visible depending on mode/risk).
      // For normal user-visible link clicks, prefer navigator.open.
      automation: {
        browser: {
          call: (action, params = {}) => request(`automation.browser.${action}`, params),
          getUrl: () => request('automation.browser.getUrl'),
          get: (params = {}) => request('automation.browser.get', params),
          snapshot: (params = {}) => request('automation.browser.snapshot', params),
          snapshotElements: (params = {}) => request('automation.browser.snapshotElements', params),
          screenshot: (params = {}) => request('automation.browser.screenshot', params),
          wait: (params = {}) => request('automation.browser.wait', params),
          open: (urlOrParams, params = {}) => request('automation.browser.open', typeof urlOrParams === 'string' ? { ...params, url: urlOrParams } : (urlOrParams || {})),
          click: (targetOrParams, params = {}) => request('automation.browser.click', typeof targetOrParams === 'string' ? { ...params, target: targetOrParams } : (targetOrParams || {})),
          fill: (targetOrParams, value, params = {}) => request('automation.browser.fill', typeof targetOrParams === 'string' ? { ...params, target: targetOrParams, value } : (targetOrParams || {})),
          press: (keyOrParams, params = {}) => request('automation.browser.press', typeof keyOrParams === 'string' ? { ...params, key: keyOrParams } : (keyOrParams || {})),
          scroll: (params = {}) => request('automation.browser.scroll', params)
        }
      },
      browser: {
        call: (action, params = {}) => request(`browser.${action}`, params),
        getUrl: () => request('browser.getUrl'),
        get: (params = {}) => request('browser.get', params),
        snapshot: (params = {}) => request('browser.snapshot', params),
        snapshotElements: (params = {}) => request('browser.snapshotElements', params),
        screenshot: (params = {}) => request('browser.screenshot', params),
        wait: (params = {}) => request('browser.wait', params),
        open: (urlOrParams, params = {}) => request('browser.open', typeof urlOrParams === 'string' ? { ...params, url: urlOrParams } : (urlOrParams || {})),
        click: (targetOrParams, params = {}) => request('browser.click', typeof targetOrParams === 'string' ? { ...params, target: targetOrParams } : (targetOrParams || {})),
        fill: (targetOrParams, value, params = {}) => request('browser.fill', typeof targetOrParams === 'string' ? { ...params, target: targetOrParams, value } : (targetOrParams || {})),
        press: (keyOrParams, params = {}) => request('browser.press', typeof keyOrParams === 'string' ? { ...params, key: keyOrParams } : (keyOrParams || {})),
        scroll: (params = {}) => request('browser.scroll', params)
      },
      shell: {
        run: (commandOrParams, params = {}) => {
          const payload = typeof commandOrParams === 'string' ? { ...params, command: commandOrParams } : (commandOrParams || {})
          return request('shell.run', payload, { timeoutMs: payload.timeoutMs || timeoutMs })
        }
      },
      // Approved local command execution. Intent-first name for shell.run; legacy
      // shell.* stays as an alias and routes to the same approval-gated handler.
      command: {
        run: (commandOrParams, params = {}) => {
          const payload = typeof commandOrParams === 'string' ? { ...params, command: commandOrParams } : (commandOrParams || {})
          return request('command.run', payload, { timeoutMs: payload.timeoutMs || timeoutMs })
        }
      },
      agent: {
        dispatch: (promptOrParams) => request('agent.dispatch', typeof promptOrParams === 'string' ? { prompt: promptOrParams } : (promptOrParams || {})),
        cancel: () => request('agent.cancel')
      },
      // ZenBin brain / contacts / identity. Read-only data accessors; the host
      // never returns the private JWK over this bridge (only public fingerprint).
      zenbin: {
        identityGet: () => request('zenbin.identity.get'),
        identityList: () => request('zenbin.identity.list'),
        identityActive: () => request('zenbin.identity.active'),
        brainList: (category) => request('zenbin.brain.list', { category }),
        brainGet: (slug) => request('zenbin.brain.get', { slug }),
        brainSearch: (query, category, limit) => request('zenbin.brain.search', { query, category, limit }),
        contactsList: () => request('zenbin.contacts.list'),
        contactsAdd: (contact) => request('zenbin.contacts.add', contact),
        contactsRemove: (name) => request('zenbin.contacts.remove', { name }),
        messagesList: () => request('zenbin.messages.list'),
        messagesSent: () => request('zenbin.messages.sent'),
        messagesGet: (id) => request('zenbin.messages.get', { id }),
        messagesSend: (params = {}) => request('zenbin.messages.send', params),
        publishesList: (cursor) => request('zenbin.publishes.list', { cursor }),
        publishesGet: (id, subdomain) => request('zenbin.publishes.get', { id, subdomain }),
        publishesVerify: (id, subdomain) => request('zenbin.publishes.verify', { id, subdomain }),
        subdomainsMine: () => request('zenbin.subdomains.mine'),
        subdomainsGet: (name) => request('zenbin.subdomains.get', { name }),
        subdomainsList: (name, cursor) => request('zenbin.subdomains.list', { name, cursor })
      }
    }
  }

  globalThis.HyperDeskWidget = { connect }
})()
