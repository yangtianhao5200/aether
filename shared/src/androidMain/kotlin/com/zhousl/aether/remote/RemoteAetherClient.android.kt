package com.zhousl.aether.remote

import io.ktor.client.HttpClient
import io.ktor.client.plugins.websocket.WebSockets

actual fun createRemoteAgentHttpClient(): HttpClient = HttpClient {
    install(WebSockets)
}

actual fun platformRemotePlatformName(): String = "android"
