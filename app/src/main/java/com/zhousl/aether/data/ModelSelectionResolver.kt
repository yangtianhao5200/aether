package com.zhousl.aether.data

/**
 * The models the chat may use.
 *
 * In remote mode the agent runs on the DeepSeek Harness host, which already
 * owns the provider routes, the credentials and the models. The phone then
 * offers the host's catalog instead of the locally configured providers, so no
 * second provider setup is needed.
 */
fun effectiveModelOptions(
    settings: AppSettings,
    providerConfigs: List<LlmProviderConfig>,
    remoteModelOptions: List<ProviderModelOption> = emptyList(),
): List<ProviderModelOption> =
    if (settings.remoteAgent.isConfigured && remoteModelOptions.isNotEmpty()) {
        remoteModelOptions
    } else {
        providerConfigs.availableModelOptions()
    }

fun normalizeSelectableModelKey(
    modelKey: String,
    options: List<ProviderModelOption>,
): String = if (options.any { it.key == modelKey }) modelKey else ""

fun resolveStoredOrAutomaticModelKey(
    modelKey: String,
    options: List<ProviderModelOption>,
    purpose: AutomaticModelPurpose,
    fallbackPurpose: AutomaticModelPurpose? = null,
    preferredAutomaticModelKey: String = "",
): String = normalizeSelectableModelKey(modelKey, options)
    .ifBlank {
        normalizeSelectableModelKey(preferredAutomaticModelKey, options).ifBlank {
            options.resolveAutomaticModelKey(purpose)
        }.ifBlank {
            fallbackPurpose?.let(options::resolveAutomaticModelKey).orEmpty()
        }
    }

fun resolveDefaultChatModelKey(
    settings: AppSettings,
    providerConfigs: List<LlmProviderConfig>,
    remoteModelOptions: List<ProviderModelOption> = emptyList(),
): String {
    val options = effectiveModelOptions(settings, providerConfigs, remoteModelOptions)
    return resolveStoredOrAutomaticModelKey(
        modelKey = settings.defaultChatModelKey,
        options = options,
        purpose = AutomaticModelPurpose.Chat,
    )
}

fun resolveDefaultTitleModelKey(
    settings: AppSettings,
    providerConfigs: List<LlmProviderConfig>,
    remoteModelOptions: List<ProviderModelOption> = emptyList(),
): String {
    val options = effectiveModelOptions(settings, providerConfigs, remoteModelOptions)
    return resolveStoredOrAutomaticModelKey(
        modelKey = settings.defaultTitleModelKey,
        options = options,
        purpose = AutomaticModelPurpose.Title,
        fallbackPurpose = AutomaticModelPurpose.Chat,
    )
}

fun resolveDefaultNamingModelKey(
    settings: AppSettings,
    providerConfigs: List<LlmProviderConfig>,
    remoteModelOptions: List<ProviderModelOption> = emptyList(),
): String {
    val options = effectiveModelOptions(settings, providerConfigs, remoteModelOptions)
    return resolveStoredOrAutomaticModelKey(
        modelKey = settings.defaultNamingModelKey,
        options = options,
        purpose = AutomaticModelPurpose.Naming,
        fallbackPurpose = AutomaticModelPurpose.Chat,
    )
}

fun resolveDefaultCompactingModelKey(
    settings: AppSettings,
    providerConfigs: List<LlmProviderConfig>,
    remoteModelOptions: List<ProviderModelOption> = emptyList(),
): String {
    val options = effectiveModelOptions(settings, providerConfigs, remoteModelOptions)
    return resolveStoredOrAutomaticModelKey(
        modelKey = settings.defaultCompactingModelKey,
        options = options,
        purpose = AutomaticModelPurpose.Compacting,
        fallbackPurpose = AutomaticModelPurpose.Chat,
    )
}

fun AppSettings.withExplicitDefaultChatModel(
    providerConfig: LlmProviderConfig,
): AppSettings {
    val selectedModelId = providerConfig.modelId.trim()
    if (selectedModelId.isBlank()) return this
    val selectableConfig = providerConfig.copy(
        isEnabled = true,
        cachedModels = providerConfig.cachedModels + selectedModelId,
        enabledModelIds = providerConfig.enabledModelIds + selectedModelId,
    )
    val selectedOption = listOf(selectableConfig)
        .availableModelOptions()
        .firstOrNull { it.modelId == selectedModelId }
        ?: return this
    return withModelOption(selectedOption).copy(defaultChatModelKey = selectedOption.key)
}

fun resolveModelSettings(
    baseSettings: AppSettings,
    providerConfigs: List<LlmProviderConfig>,
    preferredModelKey: String,
    fallbackModelKey: String,
    remoteModelOptions: List<ProviderModelOption> = emptyList(),
): AppSettings {
    val options = effectiveModelOptions(baseSettings, providerConfigs, remoteModelOptions)
    val selectedOption = options.findModelOption(preferredModelKey)
        ?: options.firstOrNull { it.modelId == preferredModelKey }
        ?: options.firstOrNull { it.fullLabel == preferredModelKey }
        ?: options.findModelOption(fallbackModelKey)
        ?: options.firstOrNull()
    if (selectedOption != null) return baseSettings.withModelOption(selectedOption)
    // Remote mode without a known host model: send no model at all so the
    // harness keeps using the model it is configured with.
    return if (baseSettings.remoteAgent.isConfigured) {
        baseSettings.copy(modelId = "", apiKey = "", oauthCredentialJson = "")
    } else {
        baseSettings
    }
}
