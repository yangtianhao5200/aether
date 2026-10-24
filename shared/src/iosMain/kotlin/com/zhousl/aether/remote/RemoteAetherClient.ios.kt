package com.zhousl.aether.remote

import io.ktor.client.HttpClient
import io.ktor.client.engine.darwin.Darwin
import io.ktor.client.plugins.websocket.WebSockets

actual fun createRemoteAgentHttpClient(): HttpClient = HttpClient(Darwin) {
    engine {
        configureSession {
            // Aether remote hosts usually run on a LAN or a private server; the
            // system HTTP proxy must not intercept the WebSocket upgrade.
            connectionProxyDictionary = emptyMap<Any?, Any>()
        }
    }
    install(WebSockets)
}

actual fun platformRemotePlatformName(): String = "ios"
