package com.zhousl.aether.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * One-shot pairing payload served by `aether-server` (`GET /v1/pair`) and shown
 * on its dashboard, so a user can paste a single string instead of typing an
 * address, a token and a workspace name.
 *
 * Accepts:
 * - `aether://host:port/v1/agent?token=...&workspace=default`
 * - `host:port` (token/workspace stay blank)
 * - `https://host/path` (plain URL, as typed before)
 * - `{"server_url":"...","token":"...","workspace":"..."}`
 */
fun parseRemoteConnectionString(text: String): RemoteAgentConfig? {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return null

    if (trimmed.startsWith("aether://", ignoreCase = true)) {
        val body = trimmed.substring("aether://".length)
        val queryStart = body.indexOf('?')
        val hostPart = if (queryStart >= 0) body.substring(0, queryStart) else body
        val query = if (queryStart >= 0) body.substring(queryStart + 1) else ""
        val params = query.split('&')
            .mapNotNull { pair ->
                val separator = pair.indexOf('=')
                if (separator <= 0) return@mapNotNull null
                val key = pair.substring(0, separator).trim()
                val value = pair.substring(separator + 1).trim()
                if (key.isEmpty()) null else key to value
            }
            .toMap()
        val host = hostPart.trimEnd('/')
            .removeSuffix("/v1/agent")
            .trimEnd('/')
        if (host.isEmpty()) return null
        val token = params["token"].orEmpty()
        if (token.isEmpty()) return null
        return RemoteAgentConfig(
            enabled = true,
            serverUrl = "http://$host",
            token = token,
            workspace = params["workspace"]?.takeIf { it.isNotBlank() } ?: DefaultRemoteWorkspace,
        )
    }

    if (trimmed.startsWith("{")) {
        val parsed = runCatching {
            Json { ignoreUnknownKeys = true }.decodeFromString<RemoteConnectionBundle>(trimmed)
        }.getOrNull() ?: return null
        val url = parsed.serverUrl ?: parsed.server_url ?: parsed.url ?: return null
        if (url.isBlank()) return null
        return RemoteAgentConfig(
            enabled = true,
            serverUrl = url,
            token = parsed.token.orEmpty(),
            workspace = parsed.workspace?.takeIf { it.isNotBlank() } ?: DefaultRemoteWorkspace,
        )
    }

    // Anything else: keep the previous "type your address" behaviour.
    val normalized = normalizeRemoteServerUrl(trimmed)
    if (normalized.isEmpty()) return null
    return RemoteAgentConfig(enabled = false, serverUrl = normalized)
}

@Serializable
private data class RemoteConnectionBundle(
    val serverUrl: String? = null,
    val server_url: String? = null,
    val url: String? = null,
    val token: String? = null,
    val workspace: String? = null,
)
