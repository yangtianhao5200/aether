package com.zhousl.aether.ui

import com.zhousl.aether.data.RemoteHostModel
import com.zhousl.aether.data.RemoteHostProvider
import com.zhousl.aether.data.RemoteModelCatalog
import org.json.JSONArray
import org.json.JSONObject

/** A plugin mounted by the host profile (server-side). */
data class DshPluginRow(
    val id: String,
    val name: String,
    val enabled: Boolean,
    val configKeys: List<String>,
)

/** A provider route the host can use, with its models. */
data class DshProviderRoute(
    val id: String,
    val baseUrl: String,
    val apiKeyEnv: String,
    val models: List<DshModelOption>,
)

data class DshModelOption(
    val id: String,
    val name: String,
    val contextWindow: Long?,
)

/** DeepSeek Harness host snapshot shown on the remote-agent settings page. */
data class DshHostUiState(
    val loaded: Boolean = false,
    val isLoading: Boolean = false,
    val error: String = "",
    val runtime: String = "",
    val profile: String = "",
    val mountPath: String = "",
    val dshVersion: String = "",
    val managementAvailable: Boolean = false,
    val plugins: List<DshPluginRow> = emptyList(),
    val providers: List<DshProviderRoute> = emptyList(),
) {
    val hasData: Boolean get() = loaded && (plugins.isNotEmpty() || providers.isNotEmpty())
}

internal fun parseDshPlugins(payload: org.json.JSONObject?): List<DshPluginRow> {
    val array: JSONArray = payload?.optJSONArray("plugins") ?: return emptyList()
    return (0 until array.length()).mapNotNull { index ->
        val row = array.optJSONObject(index) ?: return@mapNotNull null
        val id = row.optString("id").trim()
        if (id.isBlank()) return@mapNotNull null
        DshPluginRow(
            id = id,
            name = row.optString("name").ifBlank { id },
            enabled = row.optBoolean("enabled", false),
            configKeys = row.optJSONArray("config_keys")?.let { keys ->
                (0 until keys.length()).mapNotNull { keys.optString(it).ifBlank { null } }
            } ?: emptyList(),
        )
    }
}

internal fun parseDshProviders(payload: org.json.JSONObject?): List<DshProviderRoute> {
    val array: JSONArray = payload?.optJSONArray("providers") ?: return emptyList()
    return (0 until array.length()).mapNotNull { index ->
        val row = array.optJSONObject(index) ?: return@mapNotNull null
        val id = row.optString("id").trim()
        if (id.isBlank()) return@mapNotNull null
        val models = row.optJSONArray("models")?.let { list ->
            (0 until list.length()).mapNotNull { position ->
                val model = list.optJSONObject(position) ?: return@mapNotNull null
                DshModelOption(
                    id = model.optString("id").trim(),
                    name = model.optString("name").ifBlank { model.optString("id") },
                    contextWindow = when (val window = model.opt("context_window")) {
                        is Number -> window.toLong()
                        else -> null
                    },
                )
            }
        } ?: emptyList()
        DshProviderRoute(
            id = id,
            baseUrl = row.optString("base_url"),
            apiKeyEnv = row.optString("api_key_env"),
            models = models,
        )
    }
}

/**
 * The host's provider routes as a model catalog the chat can use.
 *
 * Remote mode runs the agent on the harness, so these models — not a local
 * provider setup — are what the composer offers.
 */
internal fun List<DshProviderRoute>.toRemoteModelCatalog(): RemoteModelCatalog =
    RemoteModelCatalog(
        providers = mapNotNull { route ->
            val id = route.id.trim()
            if (id.isBlank()) return@mapNotNull null
            RemoteHostProvider(
                id = id,
                name = id,
                baseUrl = route.baseUrl,
                models = route.models.mapNotNull { model ->
                    val modelId = model.id.trim()
                    if (modelId.isBlank()) return@mapNotNull null
                    RemoteHostModel(
                        id = modelId,
                        name = model.name.trim(),
                        contextWindow = model.contextWindow,
                    )
                },
            )
        },
    )
