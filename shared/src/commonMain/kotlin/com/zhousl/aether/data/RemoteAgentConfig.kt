package com.zhousl.aether.data

import kotlinx.serialization.Serializable

/**
 * Remote agent host configuration.
 *
 * When [enabled] the app stops spawning the Pi bridge inside its local Alpine
 * VM and instead connects to an `aether-server` instance (or a DeepSeek
 * Harness instance running the same plugin). The workspace then lives on the
 * server; the phone only renders the streamed agent work.
 */
@Serializable
data class RemoteAgentConfig(
    val enabled: Boolean = false,
    val serverUrl: String = "",
    val token: String = "",
    val workspace: String = DefaultRemoteWorkspace,
    /** Reconnect automatically after network changes or server restarts. */
    val autoReconnect: Boolean = true,
    /** Keep the local Alpine runtime available as a fallback. */
    val fallbackToLocal: Boolean = true,
) {
    val isConfigured: Boolean
        get() = enabled && serverUrl.trim().isNotEmpty() && token.trim().isNotEmpty()

    /** `http(s)://host:port` form, without a trailing slash or path suffix. */
    fun normalizedServerUrl(): String = normalizeRemoteServerUrl(serverUrl)

    /** `ws(s)://host:port/v1/agent` form used by the WebSocket transport. */
    fun webSocketUrl(): String = remoteWebSocketUrl(normalizedServerUrl())

    fun normalizedWorkspace(): String = workspace.trim().ifBlank { DefaultRemoteWorkspace }
}

const val DefaultRemoteWorkspace = "default"

/**
 * Accepts bare hosts (`192.168.1.10:8787`), full URLs and WebSocket URLs, and
 * normalizes them to an HTTP base URL.
 */
fun normalizeRemoteServerUrl(value: String): String {
    val trimmed = value.trim().trimEnd('/')
    if (trimmed.isEmpty()) return ""
    val withScheme = when {
        trimmed.startsWith("wss://", ignoreCase = true) -> "https://" + trimmed.substring(6)
        trimmed.startsWith("ws://", ignoreCase = true) -> "http://" + trimmed.substring(5)
        trimmed.startsWith("http://", ignoreCase = true) ||
            trimmed.startsWith("https://", ignoreCase = true) -> trimmed
        else -> "http://$trimmed"
    }
    return withScheme.removeSuffix("/v1/agent").trimEnd('/')
}

fun remoteWebSocketUrl(normalizedBaseUrl: String): String {
    if (normalizedBaseUrl.isEmpty()) return ""
    val socketBase = when {
        normalizedBaseUrl.startsWith("https://", ignoreCase = true) ->
            "wss://" + normalizedBaseUrl.substring(8)
        normalizedBaseUrl.startsWith("http://", ignoreCase = true) ->
            "ws://" + normalizedBaseUrl.substring(7)
        else -> normalizedBaseUrl
    }
    return "$socketBase/v1/agent"
}

/** Human-readable connection state for the settings screen. */
enum class RemoteAgentConnectionState(val storageValue: String) {
    Disabled("disabled"),
    Idle("idle"),
    Connecting("connecting"),
    Connected("connected"),
    Reconnecting("reconnecting"),
    Failed("failed"),
}
