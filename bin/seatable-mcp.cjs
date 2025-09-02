#!/usr/bin/env node

// CommonJS launcher that dynamically imports the ESM build and runs the CLI
(async () => {
    try {
        const mod = await import('../dist/index.js')
        if (typeof mod.runCli === 'function') {
            await mod.runCli()
            return
        }
        if (typeof mod.default === 'function') {
            await mod.default()
            return
        }
        // Fallback: do nothing; relying on side-effect main guard in compiled code
    } catch (err) {
        console.error(err)
        process.exit(1)
    }
})()
