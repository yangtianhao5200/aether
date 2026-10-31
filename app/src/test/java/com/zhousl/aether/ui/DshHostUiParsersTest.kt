package com.zhousl.aether.ui

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DshHostUiParsersTest {
    @Test
    fun composedProfileKeepsConditionalAndPatchFlags() {
        val payload = JSONObject(
            """
            {"total":3,"enabled":2,"plugins":[
              {"id":"timer","name":"@deepseek-ai/timer","enabled":true,"conditional":false,"config_keys":[]},
              {"id":"hmr","name":"@deepseek-ai/hmr","enabled":false,"conditional":true,"config_keys":["root"]},
              {"id":"llm","name":"@deepseek-ai/llm","enabled":false,"patch":true,"config_keys":[]}
            ]}
            """.trimIndent(),
        )
        val plugins = parseDshComposedProfile(payload)

        assertEquals(3, plugins.size)
        assertEquals("timer", plugins[0].id)
        assertTrue(plugins[0].enabled)
        assertTrue(plugins[1].conditional)
        assertTrue(plugins[2].patched)
        assertFalse(plugins[2].enabled)
    }

    @Test
    fun settingsDescribeRendersScalarFields() {
        val payload = JSONObject(
            """
            {"namespaces":[
              {"ns":"agent-default-model","applies":"live","writable":true,
               "schema":{"dict":{"provider":1,"model":2,"reasoningEffort":3},
                         "refs":{"1":{"type":"string","meta":{"required":true}},
                                 "2":{"type":"string","meta":{"required":true}},
                                 "3":{"type":"string","meta":{}}}},
               "value":{"provider":"free","model":"deepseek-v4.1-flash"}}
            ]}
            """.trimIndent(),
        )
        val namespaces = parseDshSettingsDescribe(payload)

        assertEquals(1, namespaces.size)
        val ns = namespaces[0]
        assertEquals("agent-default-model", ns.ns)
        assertEquals("live", ns.applies)
        val provider = ns.fields.first { it.key == "provider" }
        assertEquals("free", provider.value)
        assertTrue(provider.required)
        // A field with no value is still rendered, so the user can fill it.
        val effort = ns.fields.first { it.key == "reasoningEffort" }
        assertFalse(effort.hasValue)
    }

    @Test
    fun modelCatalogFlattensProviderGroups() {
        val payload = JSONObject(
            """
            {"groups":[
              {"id":"free","name":"Free","models":[{"id":"deepseek-v4.1-flash","name":"DeepSeek"}]},
              {"id":"catwork","name":"CatWork","models":[{"id":"minimax-m3.1-flash"}]}
            ]}
            """.trimIndent(),
        )
        val models = parseDshModelCatalog(payload)

        assertEquals(2, models.size)
        assertEquals("free/deepseek-v4.1-flash", models[0].key)
        assertEquals("DeepSeek", models[0].name)
        assertEquals("catwork", models[1].provider)
    }

    @Test
    fun emptyPayloadsYieldEmptyLists() {
        assertTrue(parseDshComposedProfile(null).isEmpty())
        assertTrue(parseDshSettingsDescribe(JSONObject("{}")).isEmpty())
        assertTrue(parseDshModelCatalog(null).isEmpty())
    }
}
