package com.zhousl.aether.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The remote agent host has to survive a process restart, otherwise the home
 * screen keeps showing the "connect your agent" card on every launch.
 */
class RemoteAgentConfigPersistenceTest {
    @Test
    fun configuredHostRoundTripsThroughTheStoredPayload() {
        val config = RemoteAgentConfig(
            enabled = true,
            serverUrl = "http://186.241.74.39:3193",
            token = "aether-token",
            workspace = "default",
            autoReconnect = true,
            fallbackToLocal = false,
        )

        val restored = parseRemoteAgentConfig(serializeRemoteAgentConfig(config))

        assertEquals(config, restored)
        assertTrue(restored.isConfigured)
    }

    @Test
    fun serverUrlIsRestoredVerbatimSoTheClientCanConnectAgain() {
        val config = RemoteAgentConfig(
            enabled = true,
            serverUrl = "http://186.241.74.39:3193/aether",
            token = "aether-token",
            workspace = "default",
        )

        val restored = parseRemoteAgentConfig(serializeRemoteAgentConfig(config))

        assertEquals("http://186.241.74.39:3193/aether", restored.serverUrl)
        assertEquals("aether-token", restored.token)
        assertTrue(restored.enabled)
    }

    @Test
    fun missingPayloadFallsBackToTheDisabledDefaults() {
        val restored = parseRemoteAgentConfig("")

        assertEquals(RemoteAgentConfig(), restored)
        assertFalse(restored.isConfigured)
    }

    @Test
    fun brokenPayloadFallsBackToTheDisabledDefaults() {
        val restored = parseRemoteAgentConfig("not-json")

        assertEquals(RemoteAgentConfig(), restored)
        assertFalse(restored.isConfigured)
    }

    @Test
    fun partialPayloadKeepsTheRemainingDefaults() {
        val restored = parseRemoteAgentConfig("""{"enabled":true,"token":"t"}""")

        assertTrue(restored.enabled)
        assertEquals("t", restored.token)
        assertEquals("", restored.serverUrl)
        assertEquals(DefaultRemoteWorkspace, restored.workspace)
        assertTrue(restored.autoReconnect)
        assertTrue(restored.fallbackToLocal)
    }
}
