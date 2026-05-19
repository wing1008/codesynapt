// Minimal plugin example.
// Listens for node selections and shows a toast with stats.

export default {
  activate(ctx) {
    ctx.log('Hello World plugin loaded')

    // Subscribe to selection events
    const unsub = ctx.events.on('selection:changed', (id) => {
      if (!id) return
      const node = ctx.graph.getNode(id)
      if (!node) return

      const outCount = ctx.graph.outgoing(id).length
      const inCount = ctx.graph.incoming(id).length

      ctx.toast(`${id} — ${outCount} out, ${inCount} in`)
    })

    // Register a context-menu item
    ctx.ui.registerContextMenuItem({
      label: 'Hello from plugin',
      icon: '👋',
      action: (nodeId) => {
        ctx.toast(`You picked: ${nodeId}`)
      }
    })

    // Cleanup function — called when plugin is disabled
    this._unsub = unsub
  },

  deactivate() {
    if (this._unsub) this._unsub()
  }
}
