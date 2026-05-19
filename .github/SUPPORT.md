# Getting help

Need help with filegraph3d? Here's where to go.

## Where to ask

| Question type | Where to go |
|---|---|
| 🐛 **I found a bug** | [Open a bug report](https://github.com/YOUR_USER/filegraph3d/issues/new?template=bug_report.md) |
| 💡 **I have a feature idea** | [Open a feature request](https://github.com/YOUR_USER/filegraph3d/issues/new?template=feature_request.md) |
| 🔌 **Plugin development question** | [Open a plugin issue](https://github.com/YOUR_USER/filegraph3d/issues/new?template=plugin_issue.md) |
| ❓ **How do I…?** | [GitHub Discussions](https://github.com/YOUR_USER/filegraph3d/discussions) |
| 💬 **General chat / showing off what you built** | [Discussions](https://github.com/YOUR_USER/filegraph3d/discussions/categories/show-and-tell) |
| 🔒 **Security vulnerability** | Read [SECURITY.md](../SECURITY.md) — **don't open a public issue** |
| 💼 **Commercial licensing** | Email the maintainer (see [LICENSES.md](../LICENSES.md)) |

## Before asking

A few minutes of searching often saves an hour of waiting:

1. **Read the docs first.** Most questions are already answered in:
   - [Installation](../docs/installation.md)
   - [Features](../docs/features.md)
   - [Controls](../docs/controls.md)
   - [Architecture](../docs/architecture.md)
   - For plugin questions: [plugin-api/docs/](../plugin-api/docs/)

2. **Search existing issues and discussions** — open *and* closed.
   Many things have come up before.

3. **Try the latest version.** If you're not on the latest release,
   the bug might already be fixed. See [CHANGELOG.md](../CHANGELOG.md).

4. **Open DevTools.** Most app errors print to the console
   (View → Toggle Developer Tools). The error message often points
   straight at the answer.

## Writing a good question

If you do need to ask, you'll get a faster (and better) answer if you:

- **State what you tried** — not just what didn't work
- **Include your environment** — OS, version, install method
- **Share a minimal reproduction** — the smallest folder or code
  snippet that shows the problem
- **Paste the actual error text** — screenshots of error messages are
  hard to read and impossible to search

The bug-report and feature-request templates already prompt for these.
Use them.

## Response time expectations

filegraph3d is currently maintained by **one person in their spare time**.

Realistic timelines:

| Channel | Typical response |
|---|---|
| Bug reports | 1–3 days |
| Feature requests | 1–2 weeks (often longer to actually implement) |
| Security reports | Within 24 hours |
| Commercial licensing inquiries | 1–3 days |
| Discussions | Best-effort, no guarantees |

If you haven't heard back in twice the typical time, a polite bump
("Hi, just checking on this") is fine.

## What "support" doesn't mean

This project doesn't provide:

- **Real-time chat support** — there's no Discord/Slack/IRC channel
- **Phone or video support**
- **Custom development for free** — but commercial arrangements are possible
- **Onboarding sessions** — the docs are the onboarding
- **Tech support for code that isn't filegraph3d** — e.g., "my Electron
  app is broken" isn't this project's problem
- **24/7 uptime guarantees** — this is an offline desktop app; there
  is no service to be up

If you need any of the above, a commercial licensing arrangement is
the right path. See [LICENSES.md](../LICENSES.md).

## Plugin developers

If you're building a plugin and got stuck:

1. Read [plugin-api/docs/troubleshooting.md](../plugin-api/docs/troubleshooting.md)
   first — it covers 11 common failure modes.
2. Check the [example plugins](../plugin-api/examples/) — copy and
   modify.
3. If still stuck, open a [plugin issue](https://github.com/YOUR_USER/filegraph3d/issues/new?template=plugin_issue.md)
   with your manifest, your code, and the DevTools console output.

## Translating filegraph3d

Currently filegraph3d is English-only. The codebase isn't internationalized
yet — strings are inline. If you'd like to help internationalize it,
open a Discussion to coordinate.

## Reporting non-bug feedback

If something feels rough but isn't strictly a bug — the docs are
confusing, the UI is hard to discover, a feature is technically working
but isn't what people expect — Discussions is the right place. UX
feedback is welcome and read.
