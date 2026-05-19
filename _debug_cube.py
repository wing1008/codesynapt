"""Diagnose why view cube isn't rendering."""
from playwright.sync_api import sync_playwright

with sync_playwright() as pw:
    browser = pw.chromium.connect_over_cdp("http://127.0.0.1:9222")
    page = browser.contexts[0].pages[0]
    info = page.evaluate("""
        (() => {
            const c = document.getElementById('viewCubeCanvas')
            if (!c) return { err: 'no canvas' }
            // Check what contexts have been created on this canvas
            const ctxs = {}
            for (const t of ['2d', 'webgl', 'webgl2', 'bitmaprenderer']) {
                try { ctxs[t] = !!c.getContext(t) } catch (e) { ctxs[t] = e.message }
            }
            // Check globals
            return {
                canvas: { width: c.width, height: c.height, clientW: c.clientWidth, clientH: c.clientHeight },
                ctxs,
                // can we access app.js globals?
                viewCubeRenderer: typeof viewCubeRenderer !== 'undefined' ? !!viewCubeRenderer : 'undef',
                viewCubeMesh: typeof viewCubeMesh !== 'undefined' ? !!viewCubeMesh : 'undef',
                renderViewCube: typeof renderViewCube,
            }
        })()
    """)
    print(info)
    browser.close()
