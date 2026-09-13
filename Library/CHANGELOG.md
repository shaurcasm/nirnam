# [2.1.0](https://github.com/shaurcasm/nirnam/compare/v2.0.0...v2.1.0) (2026-09-13)


### Bug Fixes

* **build:** worker staleness check ignores line endings ([0b6a7b5](https://github.com/shaurcasm/nirnam/commit/0b6a7b5856ab392c746c53786f6e88756029dd72))
* **canvas:** stop the frame loop while the page is hidden ([a5b9787](https://github.com/shaurcasm/nirnam/commit/a5b978712c467057341344bbda446ff139d4a929))
* typesVersions so node10 resolution finds the subpath types ([7dd5dcf](https://github.com/shaurcasm/nirnam/commit/7dd5dcfbe098ee8190cd534545eab4bed66f94d8))


### Features

* **canvas:** layers on one canvas and a per-surface DPR cap ([62e2d8a](https://github.com/shaurcasm/nirnam/commit/62e2d8acdd50ddabd155f5ec7f73f8829ff1cd38))

# [2.0.0](https://github.com/shaurcasm/nirnam/compare/v1.4.1...v2.0.0) (2026-09-12)


* feat!: run the hub in a dedicated worker by default ([bd8ec6a](https://github.com/shaurcasm/nirnam/commit/bd8ec6a92e6edd9ae734d5fe3b35d9e416e29d08))
* feat!: run the hub in a dedicated worker by default ([d0005ed](https://github.com/shaurcasm/nirnam/commit/d0005ed9762f221571422c356fcf438d6fd83115))


### Features

* **canvas:** off-main-thread animation runtime ([8624cd5](https://github.com/shaurcasm/nirnam/commit/8624cd5e0b262a846682d16bf73d34871ad28e2e))
* **canvas:** off-main-thread animation runtime ([6ed3a71](https://github.com/shaurcasm/nirnam/commit/6ed3a71a3f9640c89dbc5724b416fab1a8b2496d))
* **worker:** let a dedicated worker join the bus ([c45b4f0](https://github.com/shaurcasm/nirnam/commit/c45b4f069bee3c4ce3c90bf6d3c42b156fef9a62))
* **worker:** let a dedicated worker join the bus ([2a316c4](https://github.com/shaurcasm/nirnam/commit/2a316c46371a885f8575443f1ed68940ccb25e28))


### BREAKING CHANGES

* the default hub is a dedicated Worker, scoped to the page.
Cross-tab request-reply and scope: 'page' agents now need
createBus({ hub: 'shared' }) on a static worker URL. publish() still reaches
other tabs via BroadcastChannel regardless of hub.
* the default hub is a dedicated Worker, scoped to the page.
Cross-tab request-reply and `scope: 'page'` agents now need
`createBus({ hub: 'shared' })` on a static worker URL. Build plugins keep
serving that URL and remain useful under every hub for a strict
`worker-src` CSP. `publish()` still reaches other tabs via BroadcastChannel
regardless of hub.

Claude-Session: https://claude.ai/code/session_01BRpgsUrFFSL37zB7RnQiSs

## [1.4.1](https://github.com/shaurcasm/nirnam/compare/v1.4.0...v1.4.1) (2026-06-26)


### Bug Fixes

* README for npm add github link ([e9da38e](https://github.com/shaurcasm/nirnam/commit/e9da38e05a8642a550c57e32f55da3045b477a17))

# [1.4.0](https://github.com/shaurcasm/nirnam/compare/v1.3.0...v1.4.0) (2026-06-25)


### Features

* static worker deployment tooling (build plugin) + cross tab passive agents ([ba360a2](https://github.com/shaurcasm/nirnam/commit/ba360a246a6611ca0c15985392726fd8bded072c))

# [1.3.0](https://github.com/shaurcasm/nirnam/compare/v1.2.0...v1.3.0) (2026-06-25)


### Features

* IndexedDB Message persistence with replay ([f55bd13](https://github.com/shaurcasm/nirnam/commit/f55bd1310793cb10e8acadbfe92757f6e07d9038))

# [1.2.0](https://github.com/shaurcasm/nirnam/compare/v1.1.0...v1.2.0) (2026-06-22)


### Features

* browser-native agents framework ([b25b8a9](https://github.com/shaurcasm/nirnam/commit/b25b8a9ec6e7470cde9f9239f68a560d798eac4d))

# [1.1.0](https://github.com/shaurcasm/nirnam/compare/v1.0.0...v1.1.0) (2026-06-21)


### Features

* initial release of @palinc/nirnam ([18a4699](https://github.com/shaurcasm/nirnam/commit/18a46993ff2e9d13f42cba4b1ba8c78662dbe97f))

# 1.0.0 (2026-06-21)


### Bug Fixes

* cd package fix ([b37cf3d](https://github.com/shaurcasm/nirnam/commit/b37cf3dd793c13e56ec1c47c3ee805cc6876bea4))
* **mcp-agent:** add async bootstrap boundary to fix MF RUNTIME-006 ([0a784e5](https://github.com/shaurcasm/nirnam/commit/0a784e5515ed7aaad0e74e609054889fe9db50fa))
* **mcp-agent:** eager:true on host react, dts:false on remotes ([c97e41b](https://github.com/shaurcasm/nirnam/commit/c97e41bdcbe4e536b7267cf767afaee494b54fbf))
* **mcp-agent:** remove UTF-8 BOM from JSON files, add type:module ([cc5490a](https://github.com/shaurcasm/nirnam/commit/cc5490a81be929f695a0b1f7fefd909a80423089))
* **mcp-agent:** wait for agent registration before MCP connect ([f1de625](https://github.com/shaurcasm/nirnam/commit/f1de62527da0359f47a2b842a88616cec32bd0a1))
* strip UTF-8 BOM from Library/package.json and remaining example JSON files ([97c3cbc](https://github.com/shaurcasm/nirnam/commit/97c3cbc5cfbb51be589376a320657ae89349bd37))


### Features

* **bus:** complete request-reply layer (feature [#1](https://github.com/shaurcasm/nirnam/issues/1)) ([5f006a4](https://github.com/shaurcasm/nirnam/commit/5f006a4a5a0fa7a69a41272002ffe8a553ac877b))
* **v2.1.0:** agent registration protocol, NirnamMCPTransport, MCP example ([80e2092](https://github.com/shaurcasm/nirnam/commit/80e209249eb1a6b59dd5a69bc425debd8bbbcde7))
