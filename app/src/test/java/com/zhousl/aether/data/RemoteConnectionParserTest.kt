package com.zhousl.aether.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteConnectionParserTest {
    @Test
    fun parsesThePairingStringFromTheServer() {
        val parsed = parseRemoteConnectionString(
            "aether://192.168.1.10:8787/v1/agent?token=secret-token&workspace=project-a",
        )
        requireNotNull(parsed)
        assertTrue(parsed.enabled)
        assertEquals("http://192.168.1.10:8787", parsed.serverUrl)
        assertEquals("secret-token", parsed.token)
        assertEquals("project-a", parsed.workspace)
    }

    @Test
    fun pairingStringWithoutWorkspaceFallsBackToDefault() {
        val parsed = parseRemoteConnectionString("aether://agent.example.com/v1/agent?token=t")
        requireNotNull(parsed)
        assertEquals("http://agent.example.com", parsed.serverUrl)
        assertEquals(DefaultRemoteWorkspace, parsed.workspace)
    }

    @Test
    fun parsesJsonBundles() {
        val parsed = parseRemoteConnectionString(
            """{"serverUrl":"https://agent.example.com","token":"abc","workspace":"main"}""",
        )
        requireNotNull(parsed)
        assertEquals("https://agent.example.com", parsed.serverUrl)
        assertEquals("abc", parsed.token)
        assertEquals("main", parsed.workspace)
    }

    @Test
    fun keepsPlainTypedAddresses() {
        val parsed = parseRemoteConnectionString("192.168.1.10:8787")
        requireNotNull(parsed)
        assertEquals("http://192.168.1.10:8787", parsed.serverUrl)
        assertTrue(parsed.token.isEmpty())
    }

    @Test
    fun rejectsEmptyAndPartialStrings() {
        assertNull(parseRemoteConnectionString(""))
        assertNull(parseRemoteConnectionString("   "))
        // aether:// without a token is not usable.
        assertNull(parseRemoteConnectionString("aether://192.168.1.10:8787/v1/agent"))
    }
}
