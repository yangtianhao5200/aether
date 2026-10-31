package com.zhousl.aether.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.input.TextFieldValue
import com.zhousl.aether.ui.theme.AetherOnSurface
import com.zhousl.aether.ui.theme.AetherOnSurfaceVariant

/**
 * Everything the phone can change on the DeepSeek Harness itself: its settings
 * namespaces (rendered from the host's own schema), the model catalog,
 * permission presets, agent presets and workspaces.
 *
 * All of it goes through the harness's native `/api` (via the aether-server RPC
 * gateway), so the changes take effect on the host, not just locally.
 */
@Composable
fun DshConfigPage(
    host: DshHostUiState,
    onLoadSettings: () -> Unit,
    onSaveSettings: (String, Map<String, String>) -> Unit,
    onLoadModels: () -> Unit,
    onLoadConfiguration: () -> Unit,
    onBack: () -> Unit,
) {
    LaunchedEffect(Unit) {
        if (host.settings.isEmpty()) onLoadSettings()
        if (host.configModels.isEmpty()) onLoadModels()
        if (host.permissionOptions.isEmpty() && host.agentPresets.isEmpty()) onLoadConfiguration()
    }

    SubPageScaffold(title = "DSH 主机设置", onBack = onBack) {
        // ── Model catalog ────────────────────────────────────────────────
        SettingsCardGroup {
            Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
                SectionHeaderRow(
                    title = "模型目录",
                    subtitle = if (host.configModelsLoading) "正在读取…" else
                        if (host.configModelsError.isNotBlank()) host.configModelsError
                        else "共 ${host.configModels.size} 个模型",
                    onRefresh = onLoadModels,
                )
            }
            host.configModels
                .groupBy { it.providerName }
                .forEach { (providerName, models) ->
                    CardDivider()
                    Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) {
                        Text(
                            text = providerName,
                            style = MaterialTheme.typography.labelLarge,
                            color = AetherOnSurfaceVariant,
                        )
                        Text(
                            text = models.joinToString(", ") { it.name },
                            style = MaterialTheme.typography.bodySmall,
                            color = AetherOnSurface,
                        )
                    }
                }
        }

        Spacer(Modifier.height(16.dp))

        // ── Runtime presets ─────────────────────────────────────────────
        if (host.permissionOptions.isNotEmpty() || host.agentPresets.isNotEmpty() || host.workspaces.isNotEmpty()) {
            SettingsCardGroup {
                Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
                    SectionHeaderRow(
                        title = "运行时",
                        subtitle = "权限 / Agent 预设 / 工作区",
                        onRefresh = onLoadConfiguration,
                    )
                    if (host.permissionOptions.isNotEmpty()) {
                        Spacer(Modifier.height(6.dp))
                        DetailLine(label = "权限预设", value = host.permissionOptions.joinToString(", "))
                    }
                    if (host.agentPresets.isNotEmpty()) {
                        DetailLine(label = "Agent 预设", value = host.agentPresets.joinToString(", "))
                    }
                    if (host.workspaces.isNotEmpty()) {
                        DetailLine(label = "工作区", value = host.workspaces.joinToString(", "))
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
        }

        // ── Settings namespaces ─────────────────────────────────────────
        Column(modifier = Modifier.padding(horizontal = 4.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "Harness 设置（${host.settings.size} 项）",
                    style = MaterialTheme.typography.titleMedium,
                    color = AetherOnSurface,
                )
                OutlinedButton(onClick = onLoadSettings) { Text("刷新") }
            }
            if (host.settingsError.isNotBlank()) {
                Spacer(Modifier.height(6.dp))
                Text(
                    text = host.settingsError,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
        Spacer(Modifier.height(8.dp))

        if (host.settingsLoading && host.settings.isEmpty()) {
            SettingsCardGroup {
                Column(Modifier.padding(16.dp)) {
                    CircularProgressIndicator(modifier = Modifier.height(18.dp), strokeWidth = 2.dp)
                }
            }
        }

        host.settings.forEach { namespace ->
            DshSettingsNamespaceCard(
                namespace = namespace,
                saving = host.settingsSavingNs == namespace.ns,
                onSave = { fields -> onSaveSettings(namespace.ns, fields) },
            )
            Spacer(Modifier.height(12.dp))
        }
    }
}

@Composable
private fun SectionHeaderRow(title: String, subtitle: String, onRefresh: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(text = title, style = MaterialTheme.typography.titleSmall, color = AetherOnSurface)
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = AetherOnSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        OutlinedButton(onClick = onRefresh) { Text("刷新") }
    }
}

@Composable
private fun DshSettingsNamespaceCard(
    namespace: DshSettingsNamespace,
    saving: Boolean,
    onSave: (Map<String, String>) -> Unit,
) {
    // Edits are held per field until Save; a reload re-seeds from the host.
    val edits = remember(namespace) {
        mutableStateMapOf<String, TextFieldValue>().apply {
            namespace.fields.forEach { field ->
                put(field.key, TextFieldValue(field.value))
            }
        }
    }
    var expanded by remember { mutableStateOf(false) }

    SettingsCardGroup {
        Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = namespace.ns,
                        style = MaterialTheme.typography.bodyMedium,
                        color = AetherOnSurface,
                        fontWeight = FontWeight.Medium,
                    )
                    Text(
                        text = buildString {
                            append("${namespace.fields.size} 项")
                            if (namespace.applies.isNotBlank()) append(" · ${namespace.applies}")
                            if (!namespace.writable) append(" · 只读")
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = AetherOnSurfaceVariant,
                    )
                }
                OutlinedButton(onClick = { expanded = !expanded }) {
                    Text(if (expanded) "收起" else "编辑")
                }
            }
            if (expanded && namespace.fields.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                namespace.fields.forEach { field ->
                    val value = edits[field.key] ?: TextFieldValue(field.value)
                    ChatGptTextField(
                        label = field.key + if (field.required) " *" else "",
                        value = value,
                        placeholder = field.defaultValue.ifBlank { field.type },
                        supportingText = field.description,
                        onValueChange = { edits[field.key] = it },
                    )
                    Spacer(Modifier.height(6.dp))
                }
                Spacer(Modifier.height(4.dp))
                Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                    OutlinedButton(
                        onClick = {
                            onSave(namespace.fields.associate { field ->
                                field.key to (edits[field.key]?.text ?: field.value)
                            })
                        },
                    ) { Text(if (saving) "保存中…" else "保存本组") }
                }
            }
        }
    }
}
