// Exports the current graph as a Mermaid diagram.
// Output renders inside GitHub Markdown, Notion, Obsidian, etc.

export default {
  activate(ctx) {
    ctx.exporters.register({
      name: 'Mermaid Diagram',
      extension: 'mmd',
      mimeType: 'text/plain',
      generate(graph) {
        const lines = ['graph LR']

        // Build a short alias for each node so the diagram stays readable
        // when file paths are long
        const aliases = new Map()
        for (const node of graph.nodes) {
          const short = node.id.split('/').pop() || node.id
          let alias = sanitize(short)
          // Disambiguate if two files share a basename
          let n = 2
          const taken = new Set(aliases.values())
          while (taken.has(alias)) {
            alias = sanitize(short) + n
            n++
          }
          aliases.set(node.id, alias)
        }

        // Declare nodes with their display names
        for (const node of graph.nodes) {
          const alias = aliases.get(node.id)
          const label = node.id.split('/').pop() || node.id
          lines.push(`  ${alias}["${escapeLabel(label)}"]`)
        }

        // Then edges
        for (const e of graph.edges) {
          const sa = aliases.get(e.s)
          const ta = aliases.get(e.t)
          if (sa && ta) lines.push(`  ${sa} --> ${ta}`)
        }

        return lines.join('\n')
      }
    })

    ctx.log('Mermaid exporter ready — use Export → Mermaid Diagram')
  }
}

// Mermaid requires alphanumeric node ids — strip everything else
function sanitize(s) {
  return s.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1')
}

function escapeLabel(s) {
  return s.replace(/"/g, '\\"')
}
