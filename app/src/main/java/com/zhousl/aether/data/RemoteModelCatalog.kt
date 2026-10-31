package com.zhousl.aether.data

import org.json.JSONArray
import org.json.JSONObject

/** A model the remote agent host exposes. */
data class RemoteHostModel(
    val id: String,
    val name: String = "",
    val contextWindow: Long? = null,
)

/** A provider route on the remote agent host. */
data class RemoteHostProvider(
    val id: String,
    val name: String = "",
    val baseUrl: String = "",
    val models: List<RemoteHostModel> = emptyList(),
)

/**
 * The model catalog of the connected remote agent host (an `aether-server`
 * running inside DeepSeek Harness).
 *
 * In remote mode the host owns the providers, the credentials and the model
 * routes, so the phone offers exactly these models instead of asking the user
 * to configure a second, local provider.
 */
data class RemoteModelCatalog(
    val providers: List<RemoteHostProvider> = emptyList(),
) {
    val isEmpty: Boolean get() = providers.isEmpty()

    val modelCount: Int get() = providers.sumOf { it.models.size }

    /**
     * Model options for the chat composer.
     *
     * The credentials stay empty on purpose: the host performs the calls, the
     * phone only picks which of the host's models to use.
     */
    fun toModelOptions(): List<ProviderModelOption> = providers.flatMap { provider ->
        val providerId = provider.id.trim()
        if (providerId.isBlank()) return@flatMap emptyList()
        provider.models.mapNotNull { model ->
            val modelId = model.id.trim()
            if (modelId.isBlank()) return@mapNotNull null
            ProviderModelOption(
                key = buildModelOptionKey(RemoteProviderConfigId(providerId), modelId),
                providerConfigId = RemoteProviderConfigId(providerId),
                providerId = providerId,
                providerName = provider.name.trim().ifBlank { providerId },
                piProviderId = providerId,
                authMethod = ProviderAuthMethod.Ambient,
                apiKey = "",
                oauthCredentialJson = "",
                providerEnvironmentVariables = emptyList(),
                baseUrl = provider.baseUrl.trim(),
                modelId = modelId,
                userAgent = AetherLlmUserAgent,
                customHeaders = emptyList(),
                compatibilityMode = false,
                developerRoleUnsupported = false,
                fullLabel = "$providerId/$modelId",
                chatLabel = model.name.trim().ifBlank { modelId },
            )
        }
    }

    fun toJson(): String = JSONObject().apply {
        put("providers", JSONArray().apply {
            providers.forEach { provider ->
                put(JSONObject().apply {
                    put("id", provider.id)
                    put("name", provider.name)
                    put("base_url", provider.baseUrl)
                    put("models", JSONArray().apply {
                        provider.models.forEach { model ->
                            put(JSONObject().apply {
                                put("id", model.id)
                                put("name", model.name)
                                model.contextWindow?.let { put("context_window", it) }
                            })
                        }
                    })
                })
            }
        })
    }.toString()

    companion object {
        fun parse(rawValue: String): RemoteModelCatalog {
            if (rawValue.isBlank()) return RemoteModelCatalog()
            return runCatching {
                val root = JSONObject(rawValue)
                val array = root.optJSONArray("providers") ?: JSONArray()
                val providers = (0 until array.length()).mapNotNull { index ->
                    val row = array.optJSONObject(index) ?: return@mapNotNull null
                    val id = row.optString("id").trim()
                    if (id.isBlank()) return@mapNotNull null
                    val modelsArray = row.optJSONArray("models") ?: JSONArray()
                    val models = (0 until modelsArray.length()).mapNotNull { position ->
                        val model = modelsArray.optJSONObject(position) ?: return@mapNotNull null
                        val modelId = model.optString("id").trim()
                        if (modelId.isBlank()) return@mapNotNull null
                        RemoteHostModel(
                            id = modelId,
                            name = model.optString("name").trim(),
                            contextWindow = when (val window = model.opt("context_window")) {
                                is Number -> window.toLong()
                                else -> null
                            },
                        )
                    }
                    RemoteHostProvider(
                        id = id,
                        name = row.optString("name").trim(),
                        baseUrl = row.optString("base_url").trim(),
                        models = models,
                    )
                }
                RemoteModelCatalog(providers = providers)
            }.getOrDefault(RemoteModelCatalog())
        }
    }
}

/** Stable provider config id used for a host provider route. */
fun RemoteProviderConfigId(providerId: String): String = "remote-${providerId.trim()}"
