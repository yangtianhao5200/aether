package com.zhousl.aether.runtime.remote

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** One line of the harness transcript, oldest first. */
data class DshTurn(
    val role: String,
    val text: String,
    val streaming: Boolean = false,
)

data class DshSessionSummary(
    val id: String,
    val title: String,
    val running: Boolean,
    val updatedAt: Long,
)

data class DshLiteModel(
    val provider: String,
    val providerName: String,
    val id: String,
    val name: String,
) {
    val key: String get() = "$provider/$id"
    val label: String get() = "$providerName/$name"
}

/**
 * A thin client of the DeepSeek Harness conversation.
 *
 * The turn runs *inside the harness*: this controller only submits the prompt
 * (`session/prompt`) and subscribes to the session (`session/follow`). The
 * phone can therefore disconnect - the harness keeps working, and re-entering
 * a session re-attaches to the same stream and shows what happened while the
 * app was away.
 */
class DshChatController(
    private val host: RemoteAgentHost,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    var connecting by mutableStateOf(false)
    var connected by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var sessionId by mutableStateOf<String?>(null)
    var sessionTitle by mutableStateOf("")
    var running by mutableStateOf(false)
    var sending by mutableStateOf(false)
    var historyLoading by mutableStateOf(false)
    val turns = mutableStateListOf<DshTurn>()
    var sessions by mutableStateOf<List<DshSessionSummary>>(emptyList())
    var models by mutableStateOf<List<DshLiteModel>>(emptyList())
    var selectedModelKey by mutableStateOf<String?>(null)

    private var followJob: Job? = null
    private var draftAttempt: String? = null
    private var appliedSeq = 0L
    private var applyingSnapshot = false

    /** Attach to a running session (or the newest one); fall back to a draft. */
    fun start() {
        if (connected || connecting) return
        connecting = true
        error = null
        scope.launch {
            try {
                val listed = loadSessions()
                if (listed != null) {
                    connected = true
                    val target = listed.firstOrNull { it.running } ?: listed.firstOrNull()
                    if (target != null) open(target.id) else startDraft()
                } else {
                    error = "无法连接远程 Harness（检查服务器地址与 DSH 访问令牌）"
                }
            } finally {
                connecting = false
            }
        }
    }

    fun dispose() {
        followJob?.cancel()
        scope.cancel()
    }

    /** Draft state: no harness session exists until the first message is sent. */
    fun startDraft() {
        followJob?.cancel()
        followJob = null
        sessionId = null
        sessionTitle = ""
        turns.clear()
        appliedSeq = 0
        draftAttempt = null
        running = false
        error = null
        connected = true
    }

    fun open(id: String) {
        if (sessionId == id && followJob?.isActive == true) return
        followJob?.cancel()
        sessionId = id
        sessionTitle = sessions.firstOrNull { it.id == id }?.title.orEmpty()
        turns.clear()
        appliedSeq = 0
        draftAttempt = null
        running = false
        error = null
        connected = true
        historyLoading = true
        followJob = scope.launch { followLoop(id) }
    }

    fun refreshSessions() {
        scope.launch { loadSessions() }
    }

    private suspend fun loadSessions(): List<DshSessionSummary>? {
        val json = host.dshRpc("session", "list", """{"_request":{}}""") ?: return null
        val root = runCatching { JSONObject(json) }.getOrNull() ?: return null
        val value = root.optJSONObject("value") ?: return null
        val items = value.optJSONArray("items") ?: JSONArray()
        val list = (0 until items.length()).mapNotNull { index ->
            val row = items.optJSONObject(index) ?: return@mapNotNull null
            val id = row.optString("sessionId").ifBlank { return@mapNotNull null }
            val projections = row.optJSONObject("projections")?.optJSONObject("values")
            DshSessionSummary(
                id = id,
                title = projections?.optString("title")
                    ?.takeIf { it.isNotBlank() }
                    ?: row.optString("title").ifBlank { "会话" },
                running = row.optBoolean("running", false),
                updatedAt = row.optLong("updatedAt", 0),
            )
        }.sortedByDescending { it.updatedAt }
        sessions = list
        return list
    }

    fun loadModels() {
        scope.launch {
            val json = host.dshRpc("session", "modelCatalog", "{}") ?: return@launch
            val root = runCatching { JSONObject(json) }.getOrNull() ?: return@launch
            val value = root.optJSONObject("value") ?: root
            val groups = value.optJSONArray("groups") ?: return@launch
            val out = mutableListOf<DshLiteModel>()
            for (i in 0 until groups.length()) {
                val group = groups.optJSONObject(i) ?: continue
                val provider = group.optString("id")
                val providerName = group.optString("name").ifBlank { provider }
                val modelList = group.optJSONArray("models") ?: continue
                for (j in 0 until modelList.length()) {
                    val model = modelList.optJSONObject(j) ?: continue
                    val id = model.optString("id")
                    if (id.isBlank()) continue
                    out.add(
                        DshLiteModel(
                            provider = provider,
                            providerName = providerName,
                            id = id,
                            name = model.optString("name").ifBlank { id },
                        ),
                    )
                }
            }
            models = out
        }
    }

    /** Switch the harness session's model (`session/selectModel`). */
    fun selectModel(model: DshLiteModel) {
        selectedModelKey = model.key
        val id = sessionId ?: return
        scope.launch {
            val request = JSONObject().put(
                "request",
                JSONObject().apply {
                    put("sessionId", id)
                    put("provider", model.provider)
                    put("model", model.id)
                },
            )
            runCatching { host.dshRpc("session", "selectModel", request.toString()) }
        }
    }

    /** Send one message; creates the harness session on the first send. */
    fun send(text: String) {
        val body = text.trim()
        if (body.isEmpty() || sending) return
        sending = true
        error = null
        scope.launch {
            try {
                val id = sessionId ?: createSession()
                if (id == null) {
                    error = "创建会话失败"
                    return@launch
                }
                if (sessionId != id) {
                    followJob?.cancel()
                    sessionId = id
                    followJob = scope.launch { followLoop(id) }
                }
                val args = JSONObject().put(
                    "request",
                    JSONObject().apply {
                        put("requestId", "aether-" + System.currentTimeMillis())
                        put("sessionId", id)
                        put("mode", "queue")
                        put(
                            "content",
                            JSONArray().put(JSONObject().apply {
                                put("type", "text")
                                put("text", body)
                            }),
                        )
                    },
                )
                val json = host.dshRpc("session", "prompt", args.toString())
                val root = json?.let { runCatching { JSONObject(it) }.getOrNull() }
                if (root != null && root.optBoolean("ok", true) == false) {
                    error = root.optJSONObject("error")?.optString("message").orEmpty()
                        .ifBlank { "发送失败" }
                } else {
                    turns.add(DshTurn(role = "user", text = body))
                    running = true
                }
            } finally {
                sending = false
            }
        }
    }

    private suspend fun createSession(): String? {
        val json = host.dshRpc("session", "create", """{"request":{}}""") ?: return null
        val root = runCatching { JSONObject(json) }.getOrNull() ?: return null
        return root.optJSONObject("value")?.optString("sessionId")?.ifBlank { null }
    }

    /** Interrupt the running turn on the harness. */
    fun stop() {
        val id = sessionId ?: return
        scope.launch {
            runCatching {
                host.dshRpc("session", "cancel", JSONObject().put(
                    "request",
                    JSONObject().put("sessionId", id),
                ).toString())
            }
        }
    }

    fun rename(id: String, title: String) {
        val name = title.trim()
        if (name.isEmpty()) return
        scope.launch {
            runCatching {
                host.dshRpc(
                    "session",
                    "rename",
                    JSONObject().put(
                        "request",
                        JSONObject().apply {
                            put("sessionId", id)
                            put("title", name)
                        },
                    ).toString(),
                )
            }
            loadSessions()
        }
    }

    /**
     * Subscribe until the session is left. The follow stream re-opens on every
     * drop and always starts with a snapshot, so a phone that was offline
     * simply receives what the harness did meanwhile.
     */
    private suspend fun followLoop(id: String) {
        var failures = 0
        while (scope.isActive && sessionId == id) {
            val result = runCatching {
                host.dshStreamJson(
                    "session/follow",
                    JSONObject().put(
                        "request",
                        JSONObject().apply {
                            put(
                                "address",
                                JSONObject().apply {
                                    put("kind", "session")
                                    put("sessionId", id)
                                },
                            )
                            put("assistantStream", true)
                            put("maxMessages", 60)
                        },
                    ).toString(),
                ).collect { frameJson ->
                    handleFrame(JSONObject(frameJson))
                }
            }
            if (!scope.isActive || sessionId != id) break
            if (result.isSuccess) {
                failures = 0
            } else {
                failures++
                error = result.exceptionOrNull()?.message ?: error
            }
            delay(minOf(6000L, 800L * (failures + 1)))
        }
    }

    private fun handleFrame(frame: JSONObject) {
        when (frame.optString("type")) {
            "snapshot" -> applySnapshot(frame)
            "event" -> frame.optJSONObject("event")?.let { applyEvent(it) }
            "assistant-stream" -> frame.optJSONObject("frame")?.let { applyStreamFrame(it) }
        }
    }

    private fun applySnapshot(frame: JSONObject) {
        applyingSnapshot = true
        turns.clear()
        appliedSeq = 0
        draftAttempt = null
        frame.optJSONObject("header")?.optString("title")
            ?.takeIf { it.isNotBlank() }?.let { sessionTitle = it }
        val projections = frame.optJSONObject("projections")?.optJSONObject("values")
        projections?.optString("title")?.takeIf { it.isNotBlank() }?.let { sessionTitle = it }
        projections?.optJSONObject("modelSelection")?.let { selection ->
            val last = selection.optJSONObject("lastUsed") ?: selection.optJSONObject("next")
            if (last != null) {
                val provider = last.optString("provider")
                val model = last.optString("model")
                if (provider.isNotBlank() && model.isNotBlank()) selectedModelKey = "$provider/$model"
            }
        }
        frame.optJSONArray("records")?.let { records ->
            for (i in 0 until records.length()) {
                records.optJSONObject(i)?.optJSONObject("event")?.let { applyEvent(it) }
            }
        }
        appliedSeq = maxOf(appliedSeq, frame.optLong("cursor", 0L))
        // An open assistant attempt in the snapshot is the authoritative
        // "still running" signal after a reconnect.
        val activeAttempt = frame.optJSONObject("assistantStream")?.optJSONObject("activeAttempt")
        running = activeAttempt != null
        activeAttempt?.optJSONArray("stream")?.let { stream ->
            for (i in 0 until stream.length()) {
                val item = stream.optJSONObject(i) ?: continue
                applyChunk(item.optJSONObject("chunk") ?: item)
            }
        }
        applyingSnapshot = false
        historyLoading = false
    }

    private fun applyEvent(event: JSONObject) {
        val seq = event.optLong("seq", 0L)
        if (!applyingSnapshot && seq > 0) {
            if (seq <= appliedSeq) return
            appliedSeq = seq
        }
        when (event.optString("type")) {
            "turn/start" -> if (!applyingSnapshot) {
                running = true
                endStreamingTurn()
            }

            "turn/end" -> if (!applyingSnapshot) {
                running = false
                endStreamingTurn()
            }

            "user/message" -> {
                val data = event.optJSONObject("data") ?: return
                if (data.optJSONObject("source")?.optString("kind") != "user") return
                val text = contentText(data.optJSONArray("content"))
                if (text.isNotBlank()) appendTurn("user", text)
            }

            "assistant/message" -> {
                val message = event.optJSONObject("data")?.optJSONObject("message") ?: return
                val text = contentText(message.optJSONArray("content"))
                if (text.isNotBlank()) appendAssistant(text)
                endStreamingTurn()
            }

            "tool/call" -> {
                val data = event.optJSONObject("data") ?: return
                val name = data.optString("name")
                if (name.isNotBlank()) appendAssistant("调用工具：" + name)
            }

            "session/title" -> {
                val title = event.optJSONObject("data")?.opt("title") as? String
                if (!title.isNullOrBlank()) sessionTitle = title
            }
        }
    }

    /**
     * One `assistant-stream` frame: `start` opens an attempt, `chunk` carries a
     * block delta, `end` closes it. Only visible text blocks are appended;
     * reasoning and tool-call deltas stay out of the transcript.
     */
    private fun applyStreamFrame(streamFrame: JSONObject) {
        when (streamFrame.optString("type")) {
            "start" -> {
                draftAttempt = streamFrame.optString("attemptId").ifBlank { null }
                if (!applyingSnapshot) running = true
            }

            "chunk" -> {
                val attempt = streamFrame.optString("attemptId")
                if (draftAttempt != null && attempt.isNotBlank() && attempt != draftAttempt) return
                streamFrame.optJSONObject("chunk")?.let { applyChunk(it) }
            }

            "end" -> {
                val outcome = streamFrame.optJSONObject("outcome")
                if (outcome?.optString("kind") == "abandoned") {
                    draftAttempt = null
                    endStreamingTurn()
                }
            }
        }
    }

    private fun applyChunk(chunk: JSONObject) {
        when (chunk.optString("type")) {
            "text-delta" -> {
                val text = chunk.optString("text")
                if (text.isEmpty()) return
                val last = turns.lastOrNull()
                if (last != null && last.role == "agent" && last.streaming) {
                    turns[turns.size - 1] = last.copy(text = last.text + text)
                } else {
                    endStreamingTurn()
                    turns.add(DshTurn(role = "agent", text = text, streaming = true))
                }
                if (!applyingSnapshot) running = true
            }

            "block-start" -> {
                // A new text block continues the same streamed answer.
                if (chunk.optString("blockType") == "text") {
                    val last = turns.lastOrNull()
                    if (last != null && last.role == "agent" && last.streaming &&
                        last.text.isNotEmpty() && !last.text.endsWith("\n")
                    ) {
                        turns[turns.size - 1] = last.copy(text = last.text + "\n")
                    }
                }
            }

            "finish" -> {
                val reason = chunk.optJSONObject("reason")
                val failure = reason?.optJSONObject("failure")
                if (reason?.optString("kind") == "error") {
                    error = failure?.optString("message").orEmpty()
                        .ifBlank { "模型调用失败" }
                }
                draftAttempt = null
                endStreamingTurn()
                if (!applyingSnapshot && reason?.optString("kind") != "error") running = false
            }

            else -> Unit
        }
    }

    private fun appendTurn(role: String, text: String) {
        // The echo of our own prompt can arrive after the optimistic line.
        if (role == "user" && turns.lastOrNull()?.let { it.role == "user" && it.text == text } == true) {
            return
        }
        endStreamingTurn()
        turns.add(DshTurn(role = role, text = text))
    }

    private fun appendAssistant(text: String) {
        val last = turns.lastOrNull()
        if (last != null && last.role == "agent" && last.streaming) {
            turns[turns.size - 1] = last.copy(text = last.text.trim() + "\n" + text)
        } else if (last?.role == "agent" && last.text.contains(text.trim())) {
            return
        } else {
            endStreamingTurn()
            turns.add(DshTurn(role = "agent", text = text))
        }
    }

    private fun endStreamingTurn() {
        val last = turns.lastOrNull() ?: return
        if (last.streaming) turns[turns.size - 1] = last.copy(streaming = false)
    }

    private fun contentText(content: JSONArray?): String {
        if (content == null) return ""
        return (0 until content.length()).joinToString("") { index ->
            when (val part = content.opt(index)) {
                is String -> part
                is JSONObject -> when (part.optString("type")) {
                    "text" -> part.optString("text")
                    "tool-call" -> "调用工具：" + part.optString("name")
                    else -> ""
                }
                else -> ""
            }
        }
    }
}
