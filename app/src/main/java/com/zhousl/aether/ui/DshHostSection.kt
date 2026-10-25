package com.zhousl.aether.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.zhousl.aether.ui.theme.AetherOnSurface
import com.zhousl.aether.ui.theme.AetherOnSurfaceVariant

/**
 * Server-side DeepSeek Harness facts, fetched after the connection is up:
 * host identity, the plugins its profile mounts (switchable from the phone) and
 * the provider routes + models the agent can use.
 */
@Composable
fun DshHostSection(
    host: DshHostUiState,
    onRefresh: () -> Unit,
    onSetPluginEnabled: (String, Boolean) -> Unit,
) {
    SettingsCardGroup(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "服务器与插件",
                        style = MaterialTheme.typography.titleMedium,
                        color = AetherOnSurface,
                    )
                    val subtitle = when {
                        host.isLoading -> "正在读取…"
                        host.error.isNotBlank() -> host.error
                        !host.loaded -> "连接后自动读取"
                        host.dshVersion.isNotBlank() -> "Harness ${host.dshVersion} · profile ${host.profile}"
                        else -> "Harness · profile ${host.profile}"
                    }
                    Text(
                        text = subtitle,
                        style = MaterialTheme.typography.bodySmall,
                        color = AetherOnSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (host.isLoading) {
                    CircularProgressIndicator(modifier = Modifier.height(18.dp), strokeWidth = 2.dp)
                } else {
                    OutlinedButton(
                        onClick = onRefresh,
                        shape = RoundedCornerShape(18.dp),
                    ) {
                        Text("刷新")
                    }
                }
            }

            if (host.mountPath.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                DetailLine(label = "接入路径", value = host.mountPath)
            }

            if (host.providers.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                Text(
                    text = "可用模型",
                    style = MaterialTheme.typography.labelLarge,
                    color = AetherOnSurfaceVariant,
                )
                host.providers.forEach { route ->
                    Spacer(Modifier.height(6.dp))
                    Text(
                        text = route.id,
                        style = MaterialTheme.typography.bodyMedium,
                        color = AetherOnSurface,
                        fontWeight = FontWeight.Medium,
                    )
                    Text(
                        text = route.models.joinToString(", ") { it.name.ifBlank { it.id } }
                            .ifBlank { "（无模型）" },
                        style = MaterialTheme.typography.bodySmall,
                        color = AetherOnSurfaceVariant,
                    )
                }
            }

            if (host.plugins.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                Text(
                    text = "插件（${host.plugins.count { it.enabled }}/${host.plugins.size} 已启用）",
                    style = MaterialTheme.typography.labelLarge,
                    color = AetherOnSurfaceVariant,
                )
                host.plugins.forEach { plugin ->
                    Spacer(Modifier.height(4.dp))
                    CardDivider()
                    Spacer(Modifier.height(4.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = plugin.name,
                                style = MaterialTheme.typography.bodyMedium,
                                color = AetherOnSurface,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = plugin.id,
                                style = MaterialTheme.typography.bodySmall,
                                color = AetherOnSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        SettingsToggleRow(
                            title = "",
                            subtitle = "",
                            checked = plugin.enabled,
                            onCheckedChange = { checked -> onSetPluginEnabled(plugin.id, checked) },
                        )
                    }
                }
            }

            if (host.loaded && host.plugins.isEmpty() && host.providers.isEmpty()) {
                Spacer(Modifier.height(10.dp))
                Text(
                    text = "该主机的 profile 里还没有可管理的条目。",
                    style = MaterialTheme.typography.bodySmall,
                    color = AetherOnSurfaceVariant,
                )
            }

            if (!host.managementAvailable && host.loaded) {
                Spacer(Modifier.height(10.dp))
                Text(
                    text = "此主机未检出 Harness CLI，插件开关不可用（其它信息仍可用）。",
                    style = MaterialTheme.typography.bodySmall,
                    color = AetherOnSurfaceVariant,
                )
            }
        }
    }
}
