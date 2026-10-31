package com.zhousl.aether.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * In remote mode the harness host owns the providers and the credentials; the
 * phone only offers the host's models, so no local provider setup is needed.
 */
class RemoteModelCatalogTest {
    private val catalog = RemoteModelCatalog(
        providers = listOf(
            RemoteHostProvider(
                id = "deepseek",
                name = "DeepSeek",
                baseUrl = "https://api.deepseek.com",
                models = listOf(
                    RemoteHostModel(id = "deepseek-v4", name = "DeepSeek V4"),
                    RemoteHostModel(id = "deepseek-v4-flash", name = "DeepSeek V4 Flash"),
                ),
            ),
            RemoteHostProvider(
                id = "anthropic",
                baseUrl = "https://api.anthropic.com",
                models = listOf(RemoteHostModel(id = "claude-sonnet-4-5")),
            ),
        ),
    )

    @Test
    fun catalogRoundTripsThroughJson() {
        assertEquals(catalog, RemoteModelCatalog.parse(catalog.toJson()))
    }

    @Test
    fun unknownOrBrokenPayloadYieldsAnEmptyCatalog() {
        assertTrue(RemoteModelCatalog.parse("").isEmpty)
        assertTrue(RemoteModelCatalog.parse("not-json").isEmpty)
        assertTrue(RemoteModelCatalog.parse("""{"providers":[{"id":""}]}""").isEmpty)
    }

    @Test
    fun modelOptionsCarryNoLocalCredentials() {
        val options = catalog.toModelOptions()

        assertEquals(3, options.size)
        assertTrue(options.all { it.apiKey.isEmpty() })
        assertTrue(options.all { it.authMethod == ProviderAuthMethod.Ambient })
        assertEquals("deepseek", options.first().piProviderId)
        assertEquals("deepseek-v4", options.first().modelId)
        // The key is stable and distinct per host model.
        assertEquals(options.size, options.map { it.key }.distinct().size)
    }

    @Test
    fun remoteModelsReplaceLocalOnesOnlyWhenRemoteModeIsConfigured() {
        val localConfig = LlmProviderConfig(
            providerId = "openai",
            name = "OpenAI",
            piProviderId = "openai",
            apiKey = "local-key",
            baseUrl = "https://api.openai.com/v1",
            modelId = "gpt-x",
        )
        val localConfigs = listOf(localConfig)
        val remoteOptions = catalog.toModelOptions()

        val remoteSettings = AppSettings(
            remoteAgent = RemoteAgentConfig(
                enabled = true,
                serverUrl = "http://186.241.74.39:3193",
                token = "aether-token",
            ),
        )
        assertEquals(remoteOptions, effectiveModelOptions(remoteSettings, localConfigs, remoteOptions))

        val localSettings = AppSettings()
        assertEquals(
            localConfigs.availableModelOptions(),
            effectiveModelOptions(localSettings, localConfigs, remoteOptions),
        )
    }

    @Test
    fun remoteModeWithoutAHostCatalogKeepsNoModelSoTheHostKeepsItsOwn() {
        val remoteSettings = AppSettings(
            remoteAgent = RemoteAgentConfig(enabled = true, serverUrl = "http://host", token = "t"),
        )
        val resolved = resolveModelSettings(
            baseSettings = remoteSettings.copy(modelId = "stale-local-model", apiKey = "k"),
            providerConfigs = emptyList(),
            preferredModelKey = "",
            fallbackModelKey = "",
            remoteModelOptions = emptyList(),
        )

        assertEquals("", resolved.modelId)
        assertEquals("", resolved.apiKey)
        // The remote host config itself is untouched.
        assertTrue(resolved.remoteAgent.isConfigured)
    }

    @Test
    fun pickingAHostModelSelectsExactlyThatModel() {
        val options = catalog.toModelOptions()
        val target = options.first { it.modelId == "claude-sonnet-4-5" }
        val remoteSettings = AppSettings(
            remoteAgent = RemoteAgentConfig(enabled = true, serverUrl = "http://host", token = "t"),
        )

        val resolved = resolveModelSettings(
            baseSettings = remoteSettings,
            providerConfigs = emptyList(),
            preferredModelKey = target.key,
            fallbackModelKey = "",
            remoteModelOptions = options,
        )

        assertEquals("claude-sonnet-4-5", resolved.modelId)
        assertEquals("anthropic", resolved.piProviderId)
        assertFalse(resolved.apiKey.isNotEmpty())
    }
}
