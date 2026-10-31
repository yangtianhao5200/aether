package com.zhousl.aether.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.zhousl.aether.runtime.remote.DshChatController
import com.zhousl.aether.runtime.remote.DshSessionSummary
import com.zhousl.aether.ui.theme.AetherOnSurface
import com.zhousl.aether.ui.theme.AetherOnSurfaceVariant
import com.zhousl.aether.ui.theme.AetherSurface
import com.zhousl.aether.ui.theme.AetherSurfaceVariant

/**
 * The DSH-native conversation: the harness owns the session, this screen only
 * sends prompts and renders the followed stream. That is what makes the phone
 * a pure client - the turn keeps running server-side with the app closed.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DshChatScreen(
    controller: DshChatController,
    onBack: () -> Unit = {},
) {
    LaunchedEffect(Unit) {
        controller.start()
        controller.loadModels()
    }

    var showSessions by mutableStateOf(false)
    var showModels by mutableStateOf(false)
    val listState = rememberLazyListState()

    // Keep the transcript pinned to the newest line while streaming.
    LaunchedEffect(controller.turns.size, controller.turns.lastOrNull()?.text?.length) {
        val last = listState.layoutInfo.totalItemsCount - 1
        if (last >= 0) listState.animateScrollToItem(last)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = AetherSurface),
                navigationIcon = {
                    IconButton(onClick = { showSessions = true }) {
                        Icon(Icons.Rounded.Add, contentDescription = "会话列表")
                    }
                },
                title = {
                    Column {
                        Text(
                            text = controller.sessionTitle.ifBlank {
                                controller.sessionId?.let { "云端会话" } ?: "新任务"
                            },
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            color = AetherOnSurface,
                        )
                        val modelLabel = controller.models
                            .firstOrNull { it.key == controller.selectedModelKey }?.label
                        Text(
                            text = modelLabel ?: "点按选择模型",
                            style = MaterialTheme.typography.labelSmall,
                            color = AetherOnSurfaceVariant,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = {
                        controller.loadModels()
                        showModels = true
                    }) {
                        Icon(
                            imageVector = Icons.Rounded.Tune,
                            contentDescription = "模型",
                            tint = AetherOnSurfaceVariant,
                        )
                    }
                    if (controller.running) {
                        IconButton(onClick = controller::stop) {
                            Icon(Icons.Rounded.Stop, contentDescription = "停止", tint = MaterialTheme.colorScheme.error)
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).imePadding()) {
            // Transcript
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                when {
                    controller.connecting && controller.turns.isEmpty() -> Centered("正在连接云端会话…")
                    controller.error != null && controller.turns.isEmpty() -> Centered(
                        controller.error.orEmpty(),
                        color = MaterialTheme.colorScheme.error,
                    )
                    controller.turns.isEmpty() && controller.sessionId == null ->
                        Centered("发送消息即开始：回合在服务器上运行，手机可以断开。\n回来时会重新接上限进行中的会话。")
                    else -> LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(
                            start = 14.dp, end = 14.dp, top = 8.dp, bottom = 8.dp,
                        ),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        items(controller.turns) { turn ->
                            when (turn.role) {
                                "user" -> DshUserBubble(turn.text)
                                else -> DshAgentBubble(turn.text, turn.streaming)
                            }
                        }
                        if (controller.running && controller.turns.lastOrNull()?.role != "agent") {
                            item { DshThinkingRow() }
                        }
                    }
                }
            }

            // Input bar
            DshInputBar(
                sending = controller.sending,
                running = controller.running,
                enabled = !controller.connecting,
                onSend = controller::send,
            )
        }
    }

    if (showSessions) {
        DshSessionSheet(controller = controller, onDismiss = { showSessions = false })
    }
    if (showModels) {
        DshModelSheet(controller = controller, onDismiss = { showModels = false })
    }
}

@Composable
private fun Centered(text: String, color: Color = AetherOnSurfaceVariant) {
    Box(modifier = Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(text = text, style = MaterialTheme.typography.bodyMedium, color = color)
    }
}

@Composable
private fun DshUserBubble(text: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Box(
            modifier = Modifier
                .widthIn(max = 340.dp)
                .background(AetherSurfaceVariant, RoundedCornerShape(16.dp))
                .padding(12.dp),
        ) {
            Text(text, style = MaterialTheme.typography.bodyMedium, color = AetherOnSurface)
        }
    }
}

@Composable
private fun DshAgentBubble(text: String, streaming: Boolean) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(AetherSurface, RoundedCornerShape(16.dp))
            .padding(12.dp),
    ) {
        MarkdownContent(markdown = text, color = AetherOnSurface)
        if (streaming) {
            Spacer(Modifier.height(4.dp))
            CircularProgressIndicator(modifier = Modifier.height(14.dp), strokeWidth = 2.dp)
        }
    }
}

@Composable
private fun DshThinkingRow() {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        CircularProgressIndicator(modifier = Modifier.height(14.dp), strokeWidth = 2.dp)
        Text("云端执行中…", style = MaterialTheme.typography.labelMedium, color = AetherOnSurfaceVariant)
    }
}

@Composable
private fun DshInputBar(
    sending: Boolean,
    running: Boolean,
    enabled: Boolean,
    onSend: (String) -> Unit,
) {
    var text by remember { mutableStateOf("") }
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.weight(1f).heightIn(max = 140.dp),
            placeholder = { Text(if (running) "添加到队列…" else "发消息给云端 Agent…") },
            shape = RoundedCornerShape(20.dp),
            maxLines = 5,
            enabled = enabled,
        )
        IconButton(
            onClick = {
                if (text.isNotBlank()) {
                    onSend(text)
                    text = ""
                }
            },
            enabled = enabled && !sending && text.isNotBlank(),
        ) {
            Icon(Icons.AutoMirrored.Rounded.Send, contentDescription = "发送", tint = MaterialTheme.colorScheme.primary)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DshSessionSheet(controller: DshChatController, onDismiss: () -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    LaunchedEffect(Unit) { controller.refreshSessions() }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
            Text(
                text = "云端会话",
                style = MaterialTheme.typography.titleMedium,
                color = AetherOnSurface,
            )
            Spacer(Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = "＋ 新任务",
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.clickable {
                        controller.startDraft()
                        onDismiss()
                    }.padding(vertical = 8.dp),
                )
            }
            Spacer(Modifier.height(4.dp))
            if (controller.sessions.isEmpty()) {
                Text("（暂无会话）", style = MaterialTheme.typography.bodyMedium, color = AetherOnSurfaceVariant)
            }
            controller.sessions.forEach { summary: DshSessionSummary ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable {
                            controller.open(summary.id)
                            onDismiss()
                        }
                        .padding(vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            text = summary.title,
                            style = MaterialTheme.typography.bodyMedium,
                            color = AetherOnSurface,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            fontWeight = if (summary.id == controller.sessionId) FontWeight.Bold else FontWeight.Normal,
                        )
                        Text(
                            text = if (summary.running) "正在执行" else "空闲",
                            style = MaterialTheme.typography.labelSmall,
                            color = if (summary.running) MaterialTheme.colorScheme.primary else AetherOnSurfaceVariant,
                        )
                    }
                    if (summary.running) {
                        CircularProgressIndicator(modifier = Modifier.height(14.dp), strokeWidth = 2.dp)
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DshModelSheet(controller: DshChatController, onDismiss: () -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        LazyColumn(
            modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 8.dp),
        ) {
            item {
                Text(
                    text = "使用云端模型",
                    style = MaterialTheme.typography.titleMedium,
                    color = AetherOnSurface,
                    modifier = Modifier.padding(bottom = 8.dp),
                )
            }
            items(controller.models.groupBy { it.providerName }.toList(), key = { it.first }) { (providerName, models) ->
                Text(
                    text = providerName,
                    style = MaterialTheme.typography.labelLarge,
                    color = AetherOnSurfaceVariant,
                    modifier = Modifier.padding(top = 10.dp, bottom = 4.dp),
                )
                models.forEach { model ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                controller.selectModel(model)
                                onDismiss()
                            }
                            .padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(model.name, style = MaterialTheme.typography.bodyMedium, color = AetherOnSurface)
                        if (controller.selectedModelKey == model.key) {
                            Text("使用中", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }
            if (controller.models.isEmpty()) {
                item { Text("正在读取模型目录…", color = AetherOnSurfaceVariant) }
            }
        }
    }
}
