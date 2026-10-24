package com.zhousl.aether.runtime.remote

import com.zhousl.aether.data.RemoteAgentConfig
import com.zhousl.aether.remote.RemoteAetherClient
import java.io.InputStream
import java.io.OutputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** UI-facing connection snapshot for the remote agent settings screen. */
data class RemoteAgentUiStatus(
    val state: String = "",
    val lastError: String = "",
    val isTesting: Boolean = false,
    val testOk: Boolean? = null,
    val testMessage: String = "",
    val homeDirectory: String = "",
    val workspaceDirectory: String = "",
)

/**
 * Owns the connection to a remote `aether-server` for the Android app.
 *
 * When [isActive] the Pi bridge runs on the server; the app keeps using the same
 * `PiKernelBridge` code because [createBridgeProcess] hands it a [java.lang.Process]
 * whose streams are backed by the WebSocket.
 */
class RemoteAgentHost(
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    @Volatile
    private var config: RemoteAgentConfig = RemoteAgentConfig()

    @Volatile
    private var client: RemoteAetherClient? = null

    private val connectLock = Any()

    val isActive: Boolean
        get() = config.isConfigured

    val currentConfig: RemoteAgentConfig
        get() = config

    /** Workspace path on the server, or null when remote mode is off/not connected. */
    val workspaceRootOrNull: String?
        get() = client?.hello?.workspaceDirectory?.takeIf { it.isNotBlank() }

    val homeDirectoryOrNull: String?
        get() = client?.hello?.homeDirectory?.takeIf { it.isNotBlank() }

    val bridgeDirectoryOrNull: String?
        get() = client?.hello?.bridgeDirectory?.takeIf { it.isNotBlank() }

    val extensionDirectoryOrNull: String?
        get() = client?.hello?.extensionDirectory?.takeIf { it.isNotBlank() }

    fun applyConfig(config: RemoteAgentConfig) {
        val previous = this.config
        this.config = config
        if (!config.isConfigured) {
            disconnect()
        } else if (previous != config) {
            // Connection parameters changed: drop the old socket so the next
            // request reconnects with the new host/token.
            disconnect()
        }
    }

    suspend fun connect(): RemoteAetherClient {
        client?.takeIf { it.isConnected }?.let { return it }
        val target = synchronized(connectLock) {
            client?.takeIf { it.isConnected } ?: RemoteAetherClient(config, scope = scope).also { created ->
                created.updateConfig(config)
                client = created
            }
        }
        if (!target.isConnected) target.connect()
        return target
    }

    fun disconnect() {
        val active = client ?: return
        client = null
        scope.launch { runCatching { active.close() } }
    }

    /**
     * A bridge "process" whose stdin/stdout are the server connection.
     * The returned object is a real [Process], so `PiKernelBridge` needs no
     * changes to its reader/writer logic.
     */
    fun createBridgeProcess(): Process {
        val active = client ?: throw IllegalStateException(
            "Remote agent is not connected. Open Settings → Remote Agent and test the connection.",
        )
        return RemoteBridgeProcess(active, scope)
    }

    /** True when the server answered and paths are known. */
    val isConnected: Boolean
        get() = client?.isConnected == true
}

/**
 * [Process] façade over the WebSocket bridge connection.
 *
 * `PiKernelBridge` writes JSON lines to [getOutputStream] and reads JSON lines
 * from [getInputStream], exactly as it does for the local Alpine bridge.
 */
class RemoteBridgeProcess(
    private val client: RemoteAetherClient,
    private val scope: CoroutineScope,
) : Process() {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private val stdoutPipe = PipedInputStream(StdoutBufferBytes)
    private val stdoutSink = PipedOutputStream(stdoutPipe)
    private val stderrPipe = PipedInputStream(StderrBufferBytes)
    private val stderrSink = PipedOutputStream(stderrPipe)
    private val stdinPipe = PipedInputStream(StdinBufferBytes)
    private val stdinSource = PipedOutputStream(stdinPipe)

    @Volatile
    private var finished = false

    @Volatile
    private var exitCode: Int = -1

    private var readerJob: Job? = null
    private var writerJob: Job? = null
    private var stderrJob: Job? = null

    init {
        readerJob = scope.launch {
            try {
                client.frames.collect { frame ->
                    if (!frame.isBridgeFrame()) return@collect
                    val line = json.encodeToString(JsonObject.serializer(), frame) + "\n"
                    stdoutSink.write(line.encodeToByteArray())
                    stdoutSink.flush()
                }
            } catch (_: Throwable) {
                // connection closed
            } finally {
                finish(if (client.isConnected) 0 else 1)
            }
        }
        writerJob = scope.launch {
            val buffer = ByteArray(8192)
            try {
                while (true) {
                    val read = stdinPipe.read(buffer)
                    if (read < 0) break
                    if (read == 0) continue
                    client.sendBridgeLine(buffer.decodeToString(0, read))
                }
            } catch (_: Throwable) {
                // pipe closed
            }
        }
        stderrJob = scope.launch {
            try {
                client.lastError.collect { message ->
                    if (message.isBlank()) return@collect
                    stderrSink.write("$message\n".encodeToByteArray())
                    stderrSink.flush()
                }
            } catch (_: Throwable) {
                // ignore
            }
        }
    }

    private fun finish(code: Int) {
        if (finished) return
        finished = true
        exitCode = code
        runCatching { stdoutSink.close() }
        runCatching { stderrSink.close() }
        runCatching { stdinSource.close() }
        runCatching { stdinPipe.close() }
    }

    override fun getOutputStream(): OutputStream = stdinSource

    override fun getInputStream(): InputStream = stdoutPipe

    override fun getErrorStream(): InputStream = stderrPipe

    override fun waitFor(): Int {
        while (!finished) {
            Thread.sleep(20)
        }
        return exitCode
    }

    override fun waitFor(timeout: Long, unit: TimeUnit): Boolean {
        val deadline = System.currentTimeMillis() + unit.toMillis(timeout)
        while (!finished) {
            if (System.currentTimeMillis() > deadline) return false
            Thread.sleep(20)
        }
        return true
    }

    override fun exitValue(): Int {
        if (!finished) throw IllegalThreadStateException("Remote bridge is still running.")
        return exitCode
    }

    override fun isAlive(): Boolean = !finished

    override fun destroy() {
        readerJob?.cancel()
        writerJob?.cancel()
        stderrJob?.cancel()
        // The socket belongs to the app, not to this "process": the next bridge
        // process reuses it. Closing it here would race with a reconnect.
        finish(1)
    }

    override fun destroyForcibly(): Process {
        destroy()
        return this
    }

    private companion object {
        const val StdoutBufferBytes = 1 shl 20
        const val StderrBufferBytes = 64 * 1024
        const val StdinBufferBytes = 1 shl 16
    }
}

private fun JsonObject.isBridgeFrame(): Boolean = when (frameType()) {
    "response", "error", "event" -> true
    else -> false
}

private fun JsonObject.frameType(): String? = (this["type"] as? JsonPrimitive)?.contentOrNull
