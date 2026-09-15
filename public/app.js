let reconnectTimeout = 1000 // initial 1 second delay

function data() {
  return {
    theme: {},
    bookmarks: [],
    connected: false,
    ws: null,
    editing: false,
    modal: { open: false, creating: false, id: null, group_id: null, form: {} },
    modalDownAt: null,
    dragId: null,
    dragGroup: null,
    dragTargetId: null,
    dragAppend: false,
    themes: {},
    lan: { open: false, busy: false, progress: 0, total: 1, hosts: [], host: null, ports: [], portsBusy: false, range: "", group: null },

    init() {
      this.initPointerHandlers()
      this.connectWebSocket()
      this.fetchThemes()
      document.addEventListener('keydown', (e) => {
        if (e.key.toLowerCase() === 'e' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          this.toggleEdit()
        }
      })
    },

    async toggleEdit() {
      const el = document.activeElement
      const hasFocus = el && el !== document.body &&
        (el.matches('input, select, textarea') || el.isContentEditable)
      if (hasFocus) {
        el.blur()
        return
      }
      if (this.editing) {
        // leaving edit mode: discard categories that were never customized
        const stale = this.bookmarks.filter((g) => this.isNewGroup(g))
        for (const g of stale) await this.api('/api/groups/' + g.id, 'DELETE')
      }
      this.editing = !this.editing
    },

    isNewGroup(group) {
      return group.group === 'New category' && group.links.length === 0
    },

    // ---- websocket ----
    connectWebSocket() {
      this.ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws/bookmarks1234')

      this.ws.onopen = () => {
        this.connected = true
        reconnectTimeout = 1000
        this.ws.send(JSON.stringify('init'))
      }

      this.ws.onmessage = (event) => {
        const input = JSON.parse(event.data)
        if (input.bookmarks !== undefined) this.bookmarks = input.bookmarks
        if (input.theme) { this.theme = input.theme; this.normalizeTheme() }
        if (input.scan) this.onScanEvent(input.scan)
      }

      this.ws.onclose = () => {
        this.connected = false
        this.reconnect()
      }

      this.ws.onerror = () => this.ws.close()
    },

    reconnect() {
      setTimeout(() => {
        this.connectWebSocket()
        reconnectTimeout = Math.min(reconnectTimeout * 2, 30000)
      }, reconnectTimeout)
    },

    // ---- viewing ----
    isIndicator(bookmark) {
      return bookmark.is_indicator || !bookmark.address || !bookmark.address.includes('http')
    },

    openBookmark(bookmark) {
      if (!this.isIndicator(bookmark))
        window.open(bookmark.address, '_blank')
    },

    getHostname(bookmark) {
      if (bookmark.description) return bookmark.description
      if (bookmark.address && bookmark.address.includes('http')) {
        try {
          return new URL(bookmark.address).hostname
        } catch {
          return bookmark.address
        }
      }
      return bookmark.address || ''
    },

    // ---- edit mode: drag & drop (pointer-based, Safari-safe) ----
    // The dragged card's existing node becomes the dashed ghost slot and is
    // repositioned via CSS order — the DOM is never mutated during a drag.
    dragMouseDown(group, bookmark, event) {
      if (!this.editing || event.button !== 0) return
      event.preventDefault() // stop Safari's native text-selection drag
      this._pending = { group, bookmark, x: event.clientX, y: event.clientY }
    },

    initPointerHandlers() {
      document.addEventListener('pointermove', (e) => this.dragPointerMove(e))
      document.addEventListener('pointerup', (e) => this.dragPointerUp(e))
    },

    dragPointerMove(e) {
      if (!this.editing) return
      if (!this.dragId) {
        // not dragging yet: start after a small movement threshold
        if (!this._pending) return
        const dx = e.clientX - this._pending.x, dy = e.clientY - this._pending.y
        if (Math.hypot(dx, dy) < 6) return
        this.dragId = this._pending.bookmark.id
        this.dragGroup = this._pending.group.id
        this.dragTargetId = null
        this.dragAppend = false
        document.body.classList.add('select-none')
        this.refreshHitSnapshot()
        this._pending = null
        this.createDragPreview(this.dragId, e.clientX, e.clientY)
      }
      this.moveDragPreview(e.clientX, e.clientY)
      // pointer over the current slot: keep insertion state
      const g = this._ghostRect
      if (g && e.clientX >= g.x1 && e.clientX <= g.x2 && e.clientY >= g.y1 && e.clientY <= g.y2) return
      // hit-test against the STATIC drag-start snapshot (the ghost-free layout).
      // it never moves during the drag, so results are rock-stable while the
      // cards animate. left of a card's center = insert before it; right of
      // center = insert before the next card in reading order; a row's last
      // card right of center = first card of the next row; last of all = append.
      const PAD = 10
      const cand = (this._hitCards || []).filter(
        (c) => e.clientX >= c.x1 - PAD && e.clientX <= c.x2 + PAD && e.clientY >= c.y1 - PAD && e.clientY <= c.y2 + PAD
      )
      if (cand.length) {
        cand.sort((a, b) => Math.hypot(e.clientX - a.cx, e.clientY - a.cy) - Math.hypot(e.clientX - b.cx, e.clientY - b.cy))
        const c = cand[0]
        if (e.clientX <= c.cx) {
          this.setDragState(c.gid, c.bid)
        } else {
          const next = (this._hitCards || [])
            .filter((o) => o.gid === c.gid)
            .sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1)
            .find((o) => o.y1 > c.y1 + 5 || (Math.abs(o.y1 - c.y1) < 5 && o.x1 > c.x1))
          this.setDragState(c.gid, next ? next.bid : null)
        }
        return
      }
      const grid = (this._hitGrids || []).find((gr) => e.clientX >= gr.x1 && e.clientX <= gr.x2 && e.clientY >= gr.y1 && e.clientY <= gr.y2)
      if (grid) this.setDragState(grid.gid, null)
    },

    // static drag-start snapshot: the layout without the ghost
    refreshHitSnapshot() {
      this._hitCards = []
      this._hitGrids = []
      this._ghostRect = null
      document.querySelectorAll('[data-bid]').forEach((el) => {
        const r = el.getBoundingClientRect()
        const rect = { bid: Number(el.dataset.bid), gid: Number(el.dataset.gid), x1: r.x, y1: r.y, x2: r.x + r.width, y2: r.y + r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
        if (Number(el.dataset.bid) === this.dragId) this._ghostRect = rect
        else this._hitCards.push(rect)
      })
      document.querySelectorAll('.grid[data-gid]').forEach((el) => {
        const r = el.getBoundingClientRect()
        this._hitGrids.push({ gid: Number(el.dataset.gid), x1: r.x, y1: r.y, x2: r.x + r.width, y2: r.y + r.height })
      })
    },

    // ---- floating drag preview ----
    createDragPreview(id, x, y) {
      const card = document.querySelector(`[data-bid="${id}"]`)
      if (!card) return
      const r = card.getBoundingClientRect()
      const clone = card.cloneNode(true)
      // strip Alpine bindings so the MutationObserver doesn't re-init the clone
      const strip = (el) => {
        for (const attr of [...el.attributes]) {
          const n = attr.name
          if (n.startsWith('x-') || n.startsWith(':') || n.startsWith('@') || n.startsWith('#')) el.removeAttribute(n)
        }
      }
      strip(clone)
      clone.querySelectorAll('*').forEach(strip)
      clone.removeAttribute('data-bid')
      clone.removeAttribute('data-gid')
      clone.style.cssText = `position:fixed;left:0;top:0;width:${r.width}px;height:${r.height}px;margin:0;pointer-events:none;z-index:1000;opacity:0.9;box-shadow:0 8px 24px rgba(0,0,0,0.5);will-change:transform;`
      document.body.appendChild(clone)
      this._preview = { el: clone, dx: x - r.x, dy: y - r.y }
      this.moveDragPreview(x, y)
    },

    moveDragPreview(x, y) {
      const p = this._preview
      if (!p) return
      p.el.style.transform = `translate(${x - p.dx}px, ${y - p.dy}px)`
    },

    removeDragPreview() {
      this._preview?.el.remove()
      this._preview = null
    },

    // apply a drag-state change and FLIP-animate the cards into their new spots
    setDragState(gid, bid) {
      const append = bid === null
      if (this.dragGroup === gid && this.dragTargetId === bid && this.dragAppend === append) return
      const fromGid = this.dragGroup
      const prevRects = this.snapRects(fromGid)
      const prevRectsTarget = gid !== fromGid ? this.snapRects(gid) : null
      this.dragGroup = gid
      this.dragTargetId = bid
      this.dragAppend = append
      requestAnimationFrame(() => {
        this.flipAnimate(prevRects, fromGid)
        this.flipAnimate(prevRectsTarget, gid)
      })
    },

    snapRects(gid) {
      if (!gid) return null
      const grid = document.querySelector(`[data-gid="${gid}"]`)
      if (!grid) return null
      const map = {}
      grid.querySelectorAll('[data-bid]').forEach((el) => {
        // offsetLeft/offsetTop = layout position, unaffected by FLIP transforms
        map[el.dataset.bid] = { x: el.offsetLeft, y: el.offsetTop }
      })
      return map
    },

    flipAnimate(prevRects, gid) {
      if (!prevRects) return
      const grid = document.querySelector(`[data-gid="${gid}"]`)
      if (!grid) return
      grid.querySelectorAll('[data-bid]').forEach((el) => {
        const prev = prevRects[el.dataset.bid]
        if (!prev) return
        const dx = prev.x - el.offsetLeft, dy = prev.y - el.offsetTop
        if (!dx && !dy) return
        el.style.transition = 'none'
        el.style.transform = `translate(${dx}px, ${dy}px)`
        requestAnimationFrame(() => {
          el.style.transition = 'transform 150ms ease-out'
          el.style.transform = ''
        })
      })
    },

    dragPointerUp(e) {
      document.body.classList.remove('select-none')
      this.removeDragPreview()
      if (this.dragId) {
        const group = this.bookmarks.find((g) => g.id === this.dragGroup)
        if (group && (this.dragTargetId !== null || this.dragAppend)) {
          this.moveBookmark(this.dragId, group, this.resolveBeforeId(group))
        } else {
          // released without choosing a position: cancel
          this.dragId = null
          this.dragGroup = null
          this.dragTargetId = null
          this.dragAppend = false
        }
        this._justDragged = true
        setTimeout(() => (this._justDragged = false), 0)
      } else {
        this._pending = null
      }
    },

    isGhost(group, bookmark) {
      return (
        this.dragId === bookmark.id &&
        this.dragGroup === group.id &&
        (this.dragTargetId !== null || this.dragAppend)
      )
    },

    // desired position of every card in the target group, applied via CSS order.
    // while a ghost position is active, ALL cards get an explicit order so the
    // empty slot (the dragged card) slots in exactly where the pointer is —
    // identical whether it came from the start or the end of the list.
    dragCardStyle(group, bookmark) {
      if (!this.dragId || this.dragGroup !== group.id) return {}
      // ghost not positioned yet: keep the original layout untouched
      if (this.dragTargetId === null && !this.dragAppend) return {}
      const links = [...group.links]
      const i = links.findIndex((l) => l.id === this.dragId)
      if (i === -1) return {}
      links.splice(i, 1)
      let insertAt = links.length
      if (this.dragTargetId !== null) {
        const j = links.findIndex((l) => l.id === this.dragTargetId)
        if (j !== -1) insertAt = j
      }
      links.splice(insertAt, 0, { id: this.dragId })
      const order = links.findIndex((l) => l.id === bookmark.id)
      return order === -1 ? {} : { order }
    },

    // placeholder slot position inside the target group
    ghostOrderStyle(group) {
      if (!this.dragId || this.dragGroup !== group.id) return {}
      const links = [...group.links]
      let insertAt = links.length
      if (this.dragTargetId !== null) {
        const j = links.findIndex((l) => l.id === this.dragTargetId)
        if (j !== -1) insertAt = j
      }
      return { order: insertAt }
    },

    // resolve the before_id for the current ghost position
    resolveBeforeId(group) {
      if (this.dragAppend || this.dragTargetId === null || this.dragTargetId === this.dragId) return null
      const idx = group.links.findIndex((l) => l.id === this.dragTargetId)
      if (idx === -1) return null
      return group.links[idx].id
    },

    async moveBookmark(id, group, beforeId) {
      const payload = beforeId ? { group_id: group.id, before_id: beforeId } : { group_id: group.id }
      await this.api('/api/bookmarks/' + id + '/move', 'POST', payload)
      this.dragId = null
      this.dragGroup = null
      this.dragTargetId = null
    },

    // ---- edit mode: theme switching ----
    async fetchThemes() {
      this.themes = await (await fetch('/api/themes')).json()
      this.normalizeTheme()
    },

    // theme card styling without hover/cursor (for static elements like the
    // details chevron strip)
    themeItemStatic() {
      // strip the static background classes — the chevron is transparent so
      // the card's background (and its hover variant) shows through it
      return (this.theme.item || 'text-white/80 bg-gray-600')
        .replace(/(^|\s)(bg|border|shadow|ring)-\S+/g, '$1') // card shows through
        .replace(/(^|\s)(border|shadow|ring)(?=\s|$)/g, '$1')  // bare variants too
        .replace(/hover:\S+/g, '')                            // no hover state
        .replace('cursor-pointer', '')
        .trim()
    },

    // older stored themes lack the heading color — fill it from the preset
    normalizeTheme() {
      if (this.theme.heading) return
      const preset = this.themes[this.theme.name] || this.themes.default
      if (preset && preset.heading) this.theme = { ...this.theme, heading: preset.heading }
    },

    async applyTheme(name) {
      const preset = this.themes[name]
      if (!preset) return
      this.theme = {
        ...preset,
        title_text: this.theme.title_text,
        title: this.theme.title,
        subtitle: this.theme.subtitle,
        name,
      }
      await this.api('/api/settings', 'PUT', { theme: this.theme })
    },

    // ---- edit mode: theme/title ----
    async saveTheme() {
      await this.api('/api/settings', 'PUT', { theme: this.theme })
    },

    renameTitle(event) {
      const t = event.target.textContent.trim()
      if (!t || t === this.theme.title_text) {
        event.target.textContent = this.theme.title_text
        return
      }
      this.theme.title_text = t
      this.saveTheme()
    },

    toggleTitle() {
      this.theme.title = this.theme.title === 'hide' ? 'show' : 'hide'
      this.saveTheme()
    },

    // ---- edit mode: categories ----
    async renameGroup(event, group) {
      const name = event.target.textContent.trim()
      if (!name || name === group.group) {
        event.target.textContent = group.group
        return
      }
      await this.api('/api/groups/' + group.id, 'PUT', { name, sort: group.sort ?? 0 })
    },

    // ---- lan discovery ----
    onScanEvent(e) {
      if (e.phase === "hosts") { this.lan.busy = true; this.lan.progress = e.done; this.lan.total = e.total }
      else if (e.phase === "hosts-done") { this.lan.hosts = e.hosts; this.lan.busy = false }
      else if (e.phase === "ports") { this.lan.portsBusy = true; this.lan.progress = e.done; this.lan.total = e.total }
      else if (e.phase === "ports-done") { this.lan.ports = e.ports; this.lan.portsBusy = false }
    },

    async openDiscover() {
      this.lan.open = true
      this.lan.busy = false; this.lan.portsBusy = false
      const info = await this.api("/api/lan/info")
      this.lan.range = info.suggestion
      // cached scan results: pick directly, or scan again
      if (info.lastHosts?.length) {
        this.lan.hosts = info.lastHosts
        if (info.lastPortsHost) {
          this.lan.host = this.lan.hosts.find((h) => h.ip === info.lastPortsHost) || this.lan.hosts[0]
          this.lan.ports = info.lastPorts || []
        }
      }
    },

    async startScan() {
      if (!this.lan.range || this.lan.busy) return
      this.lan.hosts = []; this.lan.ports = []; this.lan.host = null
      this.lan.busy = true; this.lan.progress = 0; this.lan.total = 254 * 19
      await this.api("/api/lan/scan", "POST", { range: this.lan.range })
    },

    async scanHostPorts() {
      if (!this.lan.host || this.lan.portsBusy) return
      this.lan.ports = []
      this.lan.portsBusy = true; this.lan.progress = 0; this.lan.total = 9999
      await this.api("/api/lan/ports", "POST", { host: this.lan.host.ip })
    },

    addDiscovered(port) {
      const host = this.lan.host
      const group = this.bookmarks[0]
      const name = host.hostname || host.ip
      // port title probe first; else the host's discovery title ("device - Main
      // Menu" style), trimmed to the device part
      const hostTitle = (host.title || '').split(' - ')[0].trim()
      const title = port.title || hostTitle || name
      const subtitle = host.hostname || host.ip
      // prefer the dns name over the raw ip in the address, for every port
      const address = port.url.replace(host.ip, name)
      this.lan.open = false
      this.addBookmark(group, { title, subtitle, address })
    },

    async addGroup() {
      const sort = this.bookmarks.length ? Math.max(...this.bookmarks.map((g) => g.sort ?? 0)) + 1 : 0
      const r = await this.api('/api/groups', 'POST', { name: 'New category', sort })
      // wait for the websocket to deliver the new group, then focus its name
      for (let i = 0; i < 40 && !this.bookmarks.some((g) => g.id === r.id); i++) {
        await new Promise((res) => setTimeout(res, 50))
      }
      await this.$nextTick()
      const el = document.querySelector(`[data-group-title="${r.id}"]`)
      if (!el) return
      el.focus()
      const sel = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(el)
      sel.removeAllRanges()
      sel.addRange(range)
    },

    async moveGroup(group, direction) {
      await this.api('/api/groups/' + group.id + '/move', 'POST', { direction: direction < 0 ? 'up' : 'down' })
    },

    async deleteGroup(group) {
      if (!this.isNewGroup(group) && !confirm('Delete category "' + group.group + '" and all its bookmarks?')) return
      await this.api('/api/groups/' + group.id, 'DELETE')
    },

    // ---- edit mode: bookmarks ----
    openEdit(bookmark) {
      if (this._justDragged) return
      this.modal = {
        open: true,
        creating: false,
        credEdit: null,
        id: bookmark.id,
        group_id: bookmark.group_id,
        sort: bookmark.sort ?? 0,
        form: {
          title: bookmark.title,
          address: bookmark.address,
          description: bookmark.description ?? '',
          check_type: bookmark.check_type ?? 'none',
          is_indicator: !!bookmark.is_indicator,
        },
      }
    },

    addBookmark(group, prefill = {}) {
      this.modal = {
        open: true,
        creating: true,
        credEdit: null,
        id: null,
        group_id: group.id,
        form: {
          title: prefill.title || 'New bookmark',
          address: prefill.address || 'https://',
          description: prefill.subtitle || '',
          check_type: 'none',
          is_indicator: false,
        },
      }
    },

    closeEdit() {
      this.modal.open = false
    },

    async saveEdit() {
      const payload = {
        group_id: this.modal.group_id,
        title: this.modal.form.title,
        address: this.modal.form.address,
        description: (this.modal.form.description || '').trim().toUpperCase() || null,
        sort: this.modal.sort ?? 0,
        check_type: this.modal.form.check_type,
        is_indicator: !!this.modal.form.is_indicator,
        enabled: true,
      }
      if (this.modal.creating) {
        await this.api('/api/bookmarks', 'POST', payload)
      } else {
        await this.api('/api/bookmarks/' + this.modal.id, 'PUT', payload)
      }
      this.closeEdit()
    },

    async deleteBookmark() {
      if (!confirm('Delete "' + this.modal.form.title + '"?')) return
      await this.api('/api/bookmarks/' + this.modal.id, 'DELETE')
      this.closeEdit()
    },

    // ---- helpers ----
    async api(url, method, body) {
      const res = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!res.ok) console.warn('API error', url, res.status)
      return res.json().catch(() => ({}))
    },
  }
}
