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
    /** Enabled depends on a `!!js` condition the host evaluates. */
    val conditional: Boolean = false,
    /** This profile's patch overrides the bundle default for this plugin. */
    val patched: Boolean = false,
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
    // Native-RPC sections (the thin-client path): the host owns the session.
    val settings: List<DshSettingsNamespace> = emptyList(),
    val settingsLoading: Boolean = false,
    val settingsError: String = "",
    val settingsSavingNs: String = "",
    val configModels: List<DshCatalogModel> = emptyList(),
    val configModelsLoading: Boolean = false,
    val configModelsError: String = "",
    val currentModelKey: String = "",
    val permissionOptions: List<String> = emptyList(),
    val currentPermission: String = "",
    val agentPresets: List<String> = emptyList(),
    val currentPreset: String = "",
    val workspaces: List<String> = emptyList(),
) {
    val hasData: Boolean
        get() = loaded && (plugins.isNotEmpty() || providers.isNotEmpty() || settings.isNotEmpty())
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

/** Parse the composed plugin tree (`/v1/dsh/composed`). */
internal fun parseDshComposedProfile(payload: org.json.JSONObject?): List<DshPluginRow> {
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
            conditional = row.optBoolean("conditional", false),
            patched = row.optBoolean("patch", false),
        )
    }
}

/** One editable field of a DSH settings namespace (from `settings/describe`). */
data class DshSettingField(
    val key: String,
    val type: String,
    val value: String,
    val hasValue: Boolean,
    val defaultValue: String = "",
    val required: Boolean = false,
    val description: String = "",
)

/** One settings namespace: `value` is the effective config, `user` the override. */
data class DshSettingsNamespace(
    val ns: String,
    val applies: String = "",
    val writable: Boolean = true,
    val fields: List<DshSettingField> = emptyList(),
)

/** Parse `settings/describe` into app-friendly namespaces and fields. */
internal fun parseDshSettingsDescribe(payload: org.json.JSONObject?): List<DshSettingsNamespace> {
    val array: JSONArray = payload?.optJSONArray("namespaces") ?: return emptyList()
    return (0 until array.length()).mapNotNull { index ->
        val entry = array.optJSONObject(index) ?: return@mapNotNull null
        val ns = entry.optString("ns").trim()
        if (ns.isBlank()) return@mapNotNull null
        val schema = entry.optJSONObject("schema")
        val value = entry.optJSONObject("value")
        val dict = schema?.optJSONObject("dict")
        val refs = schema?.optJSONObject("refs")
        val fields = mutableListOf<DshSettingField>()
        if (dict != null) {
            for (key in dict.keys()) {
                val refId = dict.opt(key).toString()
                val ref = refs?.optJSONObject(refId)
                val meta = ref?.optJSONObject("meta")
                val type = ref?.optString("type").orEmpty()
                if (type == "object" || type == "array") continue
                val fieldValue = value?.opt(key)
                fields.add(
                    DshSettingField(
                        key = key,
                        type = type,
                        value = when (fieldValue) {
                            null, org.json.JSONObject.NULL -> ""
                            is String -> fieldValue
                            else -> fieldValue.toString()
                        },
                        hasValue = fieldValue != null && fieldValue != org.json.JSONObject.NULL,
                        defaultValue = when (val def = meta?.opt("default")) {
                            null, org.json.JSONObject.NULL -> ""
                            is String -> def
                            else -> def.toString()
                        },
                        required = meta?.optBoolean("required", false) ?: false,
                        description = meta?.optString("description").orEmpty(),
                    ),
                )
            }
        }
        DshSettingsNamespace(
            ns = ns,
            applies = entry.optString("applies"),
            writable = entry.optBoolean("writable", true),
            fields = fields,
        )
    }
}

/** A model in the host's model catalog. */
data class DshCatalogModel(
    val provider: String,
    val providerName: String,
    val id: String,
    val name: String,
    val efforts: List<String> = emptyList(),
    val defaultEffort: String = "",
) {
    val key: String get() = "$provider/$id"
}

/** Parse `session/modelCatalog`. */
internal fun parseDshModelCatalog(payload: org.json.JSONObject?): List<DshCatalogModel> {
    val groups = payload?.optJSONArray("groups") ?: return emptyList()
    val out = mutableListOf<DshCatalogModel>()
    for (i in 0 until groups.length()) {
        val group = groups.optJSONObject(i) ?: continue
        val provider = group.optString("id")
        val providerName = group.optString("name").ifBlank { provider }
        val models = group.optJSONArray("models") ?: continue
        for (j in 0 until models.length()) {
            val model = models.optJSONObject(j) ?: continue
            val id = model.optString("id")
            if (id.isBlank()) continue
            val reasoning = model.optJSONObject("reasoning")
            val efforts = reasoning?.optJSONArray("efforts")?.let { arr ->
                (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.optString("id")?.ifBlank { null } }
            } ?: emptyList()
            out.add(
                DshCatalogModel(
                    provider = provider,
                    providerName = providerName,
                    id = id,
                    name = model.optString("name").ifBlank { id },
                    efforts = efforts,
                    defaultEffort = reasoning?.optString("defaultEffort").orEmpty(),
                ),
            )
        }
    }
    return out
}
