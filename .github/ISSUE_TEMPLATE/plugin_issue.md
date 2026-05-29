---
name: Plugin API issue
about: Issue with the plugin API, plugin development, or built-in plugin samples
title: '[Plugin] '
labels: ['plugin-api', 'needs-triage']
assignees: ''
---

<!--
Use this template for:
- Issues with the plugin API surface (types, behavior, missing methods)
- Issues with how plugins are loaded, validated, or sandboxed
- Bugs in the built-in example plugins
- Questions about how to do something in a plugin

NOT for:
- Bugs in the main app (use Bug report instead)
- Issues with a community plugin you found elsewhere (file there instead)
-->

## Issue type

<!-- Check one: -->
- [ ] API surface — a method is missing, has wrong types, or behaves differently than documented
- [ ] Plugin loader — my valid plugin isn't loading, or an invalid plugin crashed the app
- [ ] Example plugin — bug in one of the `plugin-api/examples/*`
- [ ] Documentation — the plugin docs are wrong, missing, or confusing
- [ ] How-to — I'm trying to build something and got stuck

## What you're trying to do

<!--
The goal, not the implementation. Example: "I want to highlight all
files that have been modified in the last week."
-->

## What you tried

<!--
- The plugin manifest
- The plugin code (or a minimal example)
- What you expected to happen
-->

```json
// manifest.json
{
}
```

```js
// main.js
```

## What happened instead

<!-- Error messages, unexpected behavior, etc. Include DevTools console output. -->

## Environment

- **CodeSynapt version**: <!-- Settings → About -->
- **Plugin type**: <!-- theme / exporter / parser / layout / panel / action -->
- **OS**: <!-- macOS / Windows / Linux -->

## Have you checked

- [ ] [Plugin API docs](https://github.com/wing1008/codesynapt/tree/main/plugin-api/docs)
- [ ] [Troubleshooting guide](https://github.com/wing1008/codesynapt/blob/main/plugin-api/docs/troubleshooting.md)
- [ ] [Example plugins](https://github.com/wing1008/codesynapt/tree/main/plugin-api/examples)
- [ ] [types.d.ts](https://github.com/wing1008/codesynapt/blob/main/plugin-api/types.d.ts)

## Additional context

<!-- Anything else that might help. -->
