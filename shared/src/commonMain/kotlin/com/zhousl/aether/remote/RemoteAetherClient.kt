package com.zhousl.aether.remote

import com.zhousl.aether.data.RemoteAgentConfig
import com.zhousl.aether.data.RemoteAgentConnectionState
import com.zhousl.aether.data.SharedDiagnosticLogger
import com.zhousl.aether.data.platformCurrentTimeMillis
import com.zhousl.aether.data.platformRandomUuid
import io.ktor.client.HttpClient
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import kotlin.coroutines.cancellation.CancellationException
import kotlin.io.encoding.Base64
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

private const val HandshakeTimeoutMillis = 30_000L
private const val FrameBufferCapacity = 512

class RemoteAgentException(
    message: String,
    val code: String = "remote_agent_error",
) : IllegalStateException(message)

data class RemoteServerHello(
    val ok: Boolean,
    val workspace: String = "",
    val user: String = "",
    val homeDirectory: String = "",
    val workspaceDirectory: String = "",
    val agentDirectory: String = "",
    val bridgeDirectory: String = "",
    val extensionDirectory: String = "",
    val serverVersion: String = "",
    val protocol: Int = 0,
    val errorCode: String = "",
    val errorMessage: String = "",
)

data class RemoteExecResult(
    val exitCode: Int,
    val stdout: String = "",
    val stderr: String = "",
    val timedOut: Boolean = false,
    val workingDirectory: String = "",
)

data class RemoteFileEntry(
    val name: String,
    val path: String,
    val isDirectory: Boolean,
    val isSymbolicLink: Boolean = false,
    val size: Long = 0L,
    val modifiedAtMillis: Long = 0L,
)

/**
 * WebSocket client for an `aether-server` (or DeepSeek Harness) instance.
 *
 * The socket carries the Pi bridge protocol verbatim, so everything above this
 * class — `SharedPiBridgeClient`, host tools, extensions, skills — is unchanged
 * from the on-device path. Server-only operations use the `srv_*` namespace and
 * are answered through [request].
 */
class RemoteAetherClient(
    config: RemoteAgentConfig,
    injectedClient: HttpClient? = null,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    var config: RemoteAgentConfig = config
        private set

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }
    private val httpClient: HttpClient = injectedClient ?: createRemoteAgentHttpClient()

    private val connectionMutex = Mutex()
    private val writeMutex = Mutex()
    /** Guards [pending] and [execChannels]; `synchronized` is JVM-only. */
    private val stateMutex = Mutex()
    private val pending = mutableMapOf<String, CompletableDeferred<JsonObject>>()
    private val execChannels = mutableMapOf<String, Channel<RemoteExecChunk>>()

    private var session: DefaultClientWebSocketSession? = null
    private var readerJob: Job? = null
    private var helloDeferred: CompletableDeferred<RemoteServerHello>? = null

    private val _frames = MutableSharedFlow<JsonObject>(
        replay = 0,
        extraBufferCapacity = FrameBufferCapacity,
    )

    /** Bridge frames (`response`, `error`, `event`) exactly as the server relayed them. */
    val frames: SharedFlow<JsonObject> = _frames.asSharedFlow()

    // Replay covers the race between a short-lived process exiting and the
    // client subscribing after `srv_process_start` returns.
    private val _processEvents = MutableSharedFlow<JsonObject>(
        replay = 32,
        extraBufferCapacity = FrameBufferCapacity,
    )

    /** `srv_process_output` / `srv_process_exit` events for server-side processes. */
    val processEvents: SharedFlow<JsonObject> = _processEvents.asSharedFlow()

    /**
     * Bridge frames encoded exactly as the local bridge prints them: one
     * compact JSON document per line, terminated with `\n`.
     *
     * Android consumes this instead of [frames] so the app module does not need
     * kotlinx-serialization on its classpath.
     */
    fun bridgeFrameLines(): Flow<String> =
        frames.filter { it.isBridgeFrame() }.map { it.toString() + "\n" }

    private val _state = MutableStateFlow(RemoteAgentConnectionState.Idle)
    val state: StateFlow<RemoteAgentConnectionState> = _state.asStateFlow()

    private val _lastError = MutableStateFlow("")
    val lastError: StateFlow<String> = _lastError.asStateFlow()

    private val _closed = MutableStateFlow(false)

    /** Increments every time an established socket goes away. */
    private val _disconnectCount = MutableStateFlow(0)
    val disconnectCount: StateFlow<Int> = _disconnectCount.asStateFlow()

    suspend fun awaitDisconnectAfter(count: Int) {
        _disconnectCount.first { it > count }
    }

    private val _hello = MutableStateFlow<RemoteServerHello?>(null)

    /** Handshake result of the current connection, if any. */
    val hello: RemoteServerHello?
        get() = _hello.value

    val isConnected: Boolean
        get() = _state.value == RemoteAgentConnectionState.Connected

    fun updateConfig(config: RemoteAgentConfig) {
        this.config = config
    }

    /** Opens the socket and completes the protocol handshake. Idempotent. */
    suspend fun connect(): RemoteServerHello = connectionMutex.withLock {
        hello?.takeIf { isConnected }?.let { return@withLock it }
        val current = config
        if (!current.isConfigured) {
            _state.value = RemoteAgentConnectionState.Disabled
            throw RemoteAgentException("Remote agent host is not configured.", "not_configured")
        }
        val url = current.webSocketUrl()
        if (url.isBlank()) {
            _state.value = RemoteAgentConnectionState.Failed
            throw RemoteAgentException("Remote server URL is invalid.", "invalid_url")
        }
        _state.value = RemoteAgentConnectionState.Connecting
        _lastError.value = ""
        closeSession()
        _closed.value = false

        val startedAt = platformCurrentTimeMillis()
        try {
            val opened = httpClient.webSocketSession(url) {
                header(HttpHeaders.Authorization, "Bearer ${current.token.trim()}")
            }
            session = opened
            val handshake = CompletableDeferred<RemoteServerHello>()
            helloDeferred = handshake
            readerJob = scope.launch { readLoop(opened) }
            sendFrame(
                buildJsonObject {
                    put("type", "hello")
                    put("protocol", 1)
                    put("token", current.token.trim())
                    put("workspace", current.normalizedWorkspace())
                    put(
                        "client",
                        buildJsonObject {
                            put("name", "aether-app")
                            put("platform", platformName())
                        },
                    )
                },
            )
            val resolved = withTimeout(HandshakeTimeoutMillis) { handshake.await() }
            if (!resolved.ok) {
                closeSession()
                _state.value = RemoteAgentConnectionState.Failed
                _lastError.value = resolved.errorMessage.ifBlank { "Remote server rejected the handshake." }
                throw RemoteAgentException(_lastError.value, resolved.errorCode.ifBlank { "handshake_failed" })
            }
            _hello.value = resolved
            _state.value = RemoteAgentConnectionState.Connected
            SharedDiagnosticLogger.event(
                category = "remote_agent",
                event = "connected",
                details = mapOf(
                    "url" to url,
                    "workspace" to resolved.workspace,
                    "durationMillis" to (platformCurrentTimeMillis() - startedAt).toString(),
                ),
            )
            return@withLock resolved
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            closeSession()
            _state.value = RemoteAgentConnectionState.Failed
            _lastError.value = error.message ?: "Unable to reach the remote agent server."
            SharedDiagnosticLogger.event(
                category = "remote_agent",
                event = "connect_failed",
                level = "error",
                details = mapOf("url" to url, "error" to _lastError.value),
            )
            throw if (error is RemoteAgentException) error
            else RemoteAgentException(_lastError.value, "connect_failed")
        }
    }

    /** Reconnects when the socket is gone; used before forwarding a request. */
    suspend fun ensureConnected(): RemoteServerHello {
        hello?.takeIf { isConnected }?.let { return it }
        return connect()
    }

    suspend fun close() {
        _closed.value = true
        closeSession()
        _state.value = if (config.enabled) RemoteAgentConnectionState.Idle
        else RemoteAgentConnectionState.Disabled
        failPending("Remote agent connection closed.")
    }

    fun dispose() {
        scope.cancel()
    }

    suspend fun ping(): JsonObject = request("srv_ping", buildJsonObject { })

    /**
     * Sends a bridge frame (`run_turn`, `ping`, `abort`, …) to the server.
     * [line] is the exact newline-delimited JSON the local bridge would read.
     */
    suspend fun sendBridgeLine(line: String) {
        val trimmed = line.trim()
        if (trimmed.isEmpty()) return
        ensureConnected()
        sendText(trimmed)
    }

    suspend fun request(
        type: String,
        payload: JsonObject = JsonObject(emptyMap()),
        timeoutMillis: Long = 60_000L,
    ): JsonObject {
        ensureConnected()
        val id = "srv-${platformRandomUuid()}"
        val deferred = CompletableDeferred<JsonObject>()
        stateMutex.withLock { pending[id] = deferred }
        try {
            sendText(
                json.encodeToString(
                    JsonObject.serializer(),
                    buildJsonObject {
                        put("id", id)
                        put("type", type)
                        put("payload", payload)
                    },
                ),
            )
            return withTimeout(timeoutMillis) { deferred.await() }
        } finally {
            runCatching { stateMutex.withLock { pending.remove(id) } }
        }
    }

    /** Remote command execution with streamed output. */
    suspend fun exec(
        command: String,
        cwd: String? = null,
        environment: Map<String, String> = emptyMap(),
        timeoutMillis: Long = 120_000L,
        onOutput: suspend (stream: String, bytes: ByteArray) -> Unit = { _, _ -> },
    ): RemoteExecResult {
        val id = "srv-${platformRandomUuid()}"
        val channel = Channel<RemoteExecChunk>(Channel.UNLIMITED)
        val deferred = CompletableDeferred<JsonObject>()
        stateMutex.withLock {
            execChannels[id] = channel
            pending[id] = deferred
        }
        try {
            ensureConnected()
            val payload = buildJsonObject {
                put("command", command)
                if (!cwd.isNullOrBlank()) put("cwd", cwd)
                put("timeout_ms", timeoutMillis)
                if (environment.isNotEmpty()) {
                    put(
                        "env",
                        buildJsonObject { environment.forEach { (key, value) -> put(key, value) } },
                    )
                }
            }
            sendText(
                json.encodeToString(
                    JsonObject.serializer(),
                    buildJsonObject {
                        put("id", id)
                        put("type", "srv_exec")
                        put("payload", payload)
                    },
                ),
            )
            val collector = scope.launch {
                for (chunk in channel) onOutput(chunk.stream, chunk.bytes)
            }
            try {
                val response = withTimeout(timeoutMillis + 30_000L) { deferred.await() }
                return RemoteExecResult(
                    exitCode = response["exit_code"]?.jsonPrimitive?.intOrNull ?: -1,
                    stdout = response.string("stdout"),
                    stderr = response.string("stderr"),
                    timedOut = response["timed_out"]?.jsonPrimitive?.contentOrNull == "true",
                    workingDirectory = response.string("cwd"),
                )
            } finally {
                channel.close()
                collector.join()
            }
        } finally {
            runCatching {
                stateMutex.withLock {
                    pending.remove(id)
                    execChannels.remove(id)
                }
            }
        }
    }

    // ----------------------------------------------------- server processes

    data class RemoteProcessHandle(val processId: String, val pid: Int)

    suspend fun startProcess(
        command: String,
        cwd: String? = null,
        environment: Map<String, String> = emptyMap(),
    ): RemoteProcessHandle {
        val response = request(
            "srv_process_start",
            buildJsonObject {
                put("command", command)
                if (!cwd.isNullOrBlank()) put("cwd", cwd)
                if (environment.isNotEmpty()) {
                    put(
                        "env",
                        buildJsonObject { environment.forEach { (key, value) -> put(key, value) } },
                    )
                }
            },
            timeoutMillis = 30_000,
        )
        return RemoteProcessHandle(
            processId = response.string("process_id"),
            pid = response["pid"]?.jsonPrimitive?.intOrNull ?: 0,
        )
    }

    suspend fun writeProcessStdin(processId: String, bytes: ByteArray) {
        request(
            "srv_process_stdin",
            buildJsonObject {
                put("process_id", processId)
                put("data_base64", Base64.Default.encode(bytes))
            },
            timeoutMillis = 30_000,
        )
    }

    suspend fun closeProcessStdin(processId: String) {
        request(
            "srv_process_close_stdin",
            buildJsonObject { put("process_id", processId) },
            timeoutMillis = 15_000,
        )
    }

    suspend fun signalProcess(processId: String, signal: String = "SIGTERM") {
        request(
            "srv_process_signal",
            buildJsonObject {
                put("process_id", processId)
                put("signal", signal)
            },
            timeoutMillis = 15_000,
        )
    }

    /** File-system RPC used by [RemoteRuntime] and the workspace browser. */
    suspend fun fileOperation(
        operation: String,
        payload: JsonObject = JsonObject(emptyMap()),
        timeoutMillis: Long = 60_000L,
    ): JsonObject = request(
        "srv_fs",
        buildJsonObject {
            put("op", operation)
            payload.forEach { (key, value) -> put(key, value) }
        },
        timeoutMillis,
    )

    // ------------------------------------------------------------- internals

    private suspend fun sendFrame(frame: JsonObject) {
        sendText(json.encodeToString(JsonObject.serializer(), frame))
    }

    private suspend fun sendText(text: String) {
        writeMutex.withLock {
            val active = session ?: throw RemoteAgentException("Remote agent is not connected.", "not_connected")
            active.send(Frame.Text(text))
        }
    }

    private suspend fun readLoop(active: DefaultClientWebSocketSession) {
        try {
            for (frame in active.incoming) {
                if (frame !is Frame.Text) continue
                val parsed = runCatching {
                    json.parseToJsonElement(frame.readText()).jsonObject
                }.getOrNull() ?: continue
                dispatch(parsed)
            }
        } catch (error: Throwable) {
            if (error !is CancellationException) {
                _lastError.value = error.message ?: "Remote connection dropped."
                SharedDiagnosticLogger.event(
                    category = "remote_agent",
                    event = "connection_lost",
                    level = "warn",
                    details = mapOf("error" to _lastError.value),
                )
            }
        } finally {
            if (session === active) {
                session = null
                _state.value = if (config.enabled && !_closed.value) {
                    RemoteAgentConnectionState.Reconnecting
                } else {
                    RemoteAgentConnectionState.Idle
                }
                failPending("Remote agent connection closed.")
                _hello.value = null
                _disconnectCount.value = _disconnectCount.value + 1
                _frames.tryEmit(buildJsonObject { put("type", "connection_closed") })
            }
        }
    }

    private suspend fun dispatch(frame: JsonObject) {
        when (frame.string("type")) {
            "hello" -> {
                val helloFrame = RemoteServerHello(
                    ok = frame["ok"]?.jsonPrimitive?.contentOrNull != "false",
                    workspace = frame.string("workspace"),
                    user = frame.string("user"),
                    homeDirectory = frame["paths"]?.let { paths ->
                        (paths as? JsonObject)?.string("home").orEmpty()
                    }.orEmpty(),
                    workspaceDirectory = frame["paths"]?.let { paths ->
                        (paths as? JsonObject)?.string("workspace").orEmpty()
                    }.orEmpty(),
                    agentDirectory = frame["paths"]?.let { paths ->
                        (paths as? JsonObject)?.string("agent").orEmpty()
                    }.orEmpty(),
                    bridgeDirectory = frame["paths"]?.let { paths ->
                        (paths as? JsonObject)?.string("bridge").orEmpty()
                    }.orEmpty(),
                    extensionDirectory = frame["paths"]?.let { paths ->
                        (paths as? JsonObject)?.string("extensions").orEmpty()
                    }.orEmpty(),
                    serverVersion = frame.string("server_version"),
                    protocol = frame["protocol"]?.jsonPrimitive?.intOrNull ?: 0,
                    errorCode = frame["error"]?.let { (it as? JsonObject)?.string("code").orEmpty() }.orEmpty(),
                    errorMessage = frame["error"]?.let { (it as? JsonObject)?.string("message").orEmpty() }.orEmpty(),
                )
                helloDeferred?.complete(helloFrame)
                return
            }
            "event" -> {
                val event = frame.string("event")
                val id = frame.string("id")
                if ((event == "srv_process_output" || event == "srv_process_exit") && id.isEmpty()) {
                    _processEvents.emit(frame)
                    return
                }
                if (event == "srv_exec_output" && id.isNotEmpty()) {
                    val channel = stateMutex.withLock { execChannels[id] }
                    if (channel != null) {
                        val payload = frame["payload"] as? JsonObject ?: JsonObject(emptyMap())
                        val bytes = decodeBase64(payload.string("data_base64"))
                        if (bytes.isNotEmpty()) {
                            channel.trySend(RemoteExecChunk(payload.string("stream"), bytes))
                        }
                        return
                    }
                }
                _frames.emit(frame)
                return
            }
            "response", "error" -> {
                val id = frame.string("id")
                val deferred = if (id.isEmpty()) null else stateMutex.withLock { pending[id] }
                if (deferred != null) {
                    if (frame.string("type") == "error") {
                        deferred.completeExceptionally(
                            RemoteAgentException(
                                message = frame["error"]?.let { (it as? JsonObject)?.string("message") }
                                    .orEmpty().ifBlank { "Remote request failed." },
                                code = frame["error"]?.let { (it as? JsonObject)?.string("code") }
                                    .orEmpty().ifBlank { "remote_error" },
                            ),
                        )
                    } else {
                        deferred.complete(frame["payload"] as? JsonObject ?: JsonObject(emptyMap()))
                    }
                    return
                }
                _frames.emit(frame)
                return
            }
            else -> _frames.emit(frame)
        }
    }

    private suspend fun closeSession() {
        readerJob?.cancel()
        readerJob = null
        val active = session
        session = null
        helloDeferred = null
        if (active != null) {
            runCatching { active.close(CloseReason(CloseReason.Codes.NORMAL, "client closed")) }
        }
    }

    private suspend fun failPending(reason: String) {
        val snapshot = stateMutex.withLock {
            val copy = pending.toMap()
            pending.clear()
            copy
        }
        snapshot.forEach { (_, deferred) ->
            if (!deferred.isCompleted) {
                deferred.completeExceptionally(RemoteAgentException(reason, "connection_closed"))
            }
        }
        val channels = stateMutex.withLock {
            val copy = execChannels.toMap()
            execChannels.clear()
            copy
        }
        channels.values.forEach { it.close() }
    }

    private fun platformName(): String = platformRemotePlatformName()

    private fun JsonObject.string(name: String): String =
        get(name)?.jsonPrimitive?.contentOrNull.orEmpty()

    private fun decodeBase64(value: String): ByteArray =
        if (value.isBlank()) ByteArray(0) else Base64.Default.decode(value)
}

data class RemoteExecChunk(val stream: String, val bytes: ByteArray)

expect fun createRemoteAgentHttpClient(): HttpClient

expect fun platformRemotePlatformName(): String
