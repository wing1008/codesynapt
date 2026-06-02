// Rust parser plugin for filegraph3d.
//
// Recognizes:
//   - `use path::to::thing;`  → an import to "path::to::thing"
//   - `mod foo;`              → an import to the sibling/child module
//   - `extern crate foo;`     → an import to the named crate
//
// Skips:
//   - Statements inside line comments (`// use foo`)
//   - Statements inside block comments (`/* use foo */`)
//   - Use statements inside macro definitions (rare, would need a
//     real parser; we accept some false positives)

export default {
  activate(ctx) {
    ctx.parsers.register({
      name: 'Rust',
      extensions: ['rs'],
      parse(filePath, content) {
        // Strip comments first so we don't match `use` statements
        // that are commented out.
        const stripped = stripComments(content)

        const imports = []

        // `use path::to::thing;` — match the path portion only.
        // Groups, aliases, and wildcards complicate this; we capture
        // the leading path which is enough for graph edges.
        const useRegex = /^\s*(?:pub\s+)?use\s+([a-zA-Z_][\w:]*)/gm
        let m
        while ((m = useRegex.exec(stripped)) !== null) {
          imports.push({
            path: m[1],
            kind: 'import',
            line: lineNumberAt(stripped, m.index),
          })
        }

        // `mod foo;` — local module declaration
        const modRegex = /^\s*(?:pub\s+)?mod\s+([a-zA-Z_]\w*)\s*;/gm
        while ((m = modRegex.exec(stripped)) !== null) {
          imports.push({
            path: m[1],
            kind: 'import',
            line: lineNumberAt(stripped, m.index),
          })
        }

        // `extern crate foo;` — older crate import syntax
        const externRegex = /^\s*extern\s+crate\s+([a-zA-Z_]\w*)/gm
        while ((m = externRegex.exec(stripped)) !== null) {
          imports.push({
            path: m[1],
            kind: 'import',
            line: lineNumberAt(stripped, m.index),
          })
        }

        return { imports }
      }
    })

    ctx.log('Rust parser registered — .rs files will now be parsed')
  }
}

// Replace comments with spaces so regex line numbers stay accurate
function stripComments(src) {
  let result = ''
  let i = 0
  while (i < src.length) {
    // Line comment: //...\n
    if (src[i] === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        result += ' '
        i++
      }
      continue
    }
    // Block comment: /* ... */ (non-nested; Rust allows nested but
    // for our purposes flat handling is sufficient)
    if (src[i] === '/' && src[i + 1] === '*') {
      result += '  '
      i += 2
      while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) {
        result += src[i] === '\n' ? '\n' : ' '
        i++
      }
      result += '  '
      i += 2
      continue
    }
    // String literal — skip past it so `use` inside strings doesn't
    // produce a false positive
    if (src[i] === '"') {
      result += '"'
      i++
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          result += '  '
          i += 2
          continue
        }
        result += src[i] === '\n' ? '\n' : ' '
        i++
      }
      result += '"'
      i++
      continue
    }
    result += src[i]
    i++
  }
  return result
}

function lineNumberAt(str, offset) {
  let line = 1
  for (let i = 0; i < offset && i < str.length; i++) {
    if (str[i] === '\n') line++
  }
  return line
}
