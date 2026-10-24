package com.zhousl.aether.remote

import com.zhousl.aether.runtime.MultiplatformLocalRuntime
import com.zhousl.aether.runtime.RuntimeFileSystem
import com.zhousl.aether.runtime.RuntimeProcess
import com.zhousl.aether.runtime.RuntimeProcessExit
import com.zhousl.aether.runtime.RuntimeProcessSignal
import com.zhousl.aether.runtime.RuntimeProcessSpec
import com.zhousl.aether.runtime.RuntimeSetupProgress
import kotlin.coroutines.cancellation.CancellationException
import kotlin.io.encoding.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * The agent's workspace as seen from the phone when the agent runs remotely.
 *
 * Every operation is proxied to the server, so the app's workspace browser,
 * attachment uploads, skill and extension installs keep working with the same
 * absolute paths the bridge uses on the server. Nothing is mirrored locally:
 * what the app shows is what the agent sees.
 */
class RemoteRuntime(
    val client: RemoteAetherClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) : MultiplatformLocalRuntime {
    override val homeDirectory: String
        get() = client.hello?.homeDirectory.orEmpty().ifBlank { "/root" }

    override val workspaceRoot: String
        get() = client.hello?.workspaceDirectory.orEmpty().ifBlank { "/workspace" }

    /** Tells the Pi bridge that tool execution happens on the server host. */
    override val bridgeRuntimeId: String = "server"

    override val bridgeDirectory: String
        get() = client.hello?.bridgeDirectory.orEmpty()
            .ifBlank { "${homeDirectory}/.aether/pi-bridge" }

    override val fileSystem: RuntimeFileSystem = RemoteRuntimeFileSystem(client)

    override suspend fun isReady(): Boolean = client.isConnected

    override suspend fun initialize(onProgress: (RuntimeSetupProgress) -> Unit) {
        onProgress(RuntimeSetupProgress("connecting", "Connecting to the remote agent server…"))
        client.connect()
        onProgress(
            RuntimeSetupProgress(
                phase = "ready",
                detail = "Connected to ${client.hello?.workspace.orEmpty()}",
                fraction = 1f,
            ),
        )
    }

    override suspend fun reset() {
        client.close()
    }

    override suspend fun startProcess(spec: RuntimeProcessSpec): RuntimeProcess =
        RemoteRuntimeProcess(client, spec, scope)
}

class RemoteRuntimeFileSystem(
    private val client: RemoteAetherClient,
) : RuntimeFileSystem {
    override suspend fun exists(path: String): Boolean =
        client.fileOperation("exists", buildJsonObject { put("path", path) })
            .boolean("exists")

    override suspend fun createDirectories(path: String) {
        client.fileOperation(
            "mkdir",
            buildJsonObject {
                put("path", path)
                put("recursive", true)
            },
        )
    }

    override suspend fun read(path: String): ByteArray =
        client.fileOperation(
            "read",
            buildJsonObject {
                put("path", path)
                put("encoding", "base64")
            },
            timeoutMillis = 120_000,
        ).base64("data_base64")

    override suspend fun read(path: String, maximumBytes: Long): ByteArray =
        client.fileOperation(
            "read",
            buildJsonObject {
                put("path", path)
                put("encoding", "base64")
                put("max_bytes", maximumBytes)
            },
            timeoutMillis = 120_000,
        ).base64("data_base64")

    override suspend fun readPrefix(path: String, maximumBytes: Long): ByteArray =
        client.fileOperation(
            "read",
            buildJsonObject {
                put("path", path)
                put("encoding", "base64")
                put("max_bytes", maximumBytes)
                put("prefix", true)
            },
            timeoutMillis = 120_000,
        ).base64("data_base64")

    override suspend fun write(path: String, content: ByteArray, executable: Boolean) {
        client.fileOperation(
            "write",
            buildJsonObject {
                put("path", path)
                put("data_base64", encodeBase64(content))
                put("executable", executable)
            },
            timeoutMillis = 300_000,
        )
    }

    override suspend fun remove(path: String, recursive: Boolean) {
        client.fileOperation(
            "remove",
            buildJsonObject {
                put("path", path)
                put("recursive", recursive)
            },
        )
    }

    override suspend fun bindHostDirectory(hostPath: String, guestPath: String, readOnly: Boolean) {
        throw UnsupportedOperationException(
            "Mounting host directories is not available when the agent runs on a server.",
        )
    }

    suspend fun list(path: String): List<RemoteFileEntry> {
        val response = client.fileOperation("list", buildJsonObject { put("path", path) })
        return (response["entries"] as? JsonArray).orEmpty().mapNotNull { element ->
            val entry = element as? JsonObject ?: return@mapNotNull null
            RemoteFileEntry(
                name = entry.stringValue("name"),
                path = entry.stringValue("path"),
                isDirectory = entry.boolean("is_directory"),
                isSymbolicLink = entry.boolean("is_symbolic_link"),
                size = entry.long("size"),
                modifiedAtMillis = entry.long("modified_at_millis"),
            )
        }
    }

    suspend fun stat(path: String): RemoteFileEntry {
        val response = client.fileOperation("stat", buildJsonObject { put("path", path) })
        return RemoteFileEntry(
            name = response.stringValue("name"),
            path = response.stringValue("path"),
            isDirectory = response.boolean("is_directory"),
            isSymbolicLink = response.boolean("is_symbolic_link"),
            size = response.long("size"),
            modifiedAtMillis = response.long("modified_at_millis"),
        )
    }
}

/** A server-side command exposed through the same [RuntimeProcess] contract. */
class RemoteRuntimeProcess(
    private val client: RemoteAetherClient,
    private val spec: RuntimeProcessSpec,
    private val scope: CoroutineScope,
) : RuntimeProcess {
    private val commandLine: String = buildCommandLine(spec)

    private val stdoutChannel = Channel<ByteArray>(Channel.UNLIMITED)
    private val stderrChannel = Channel<ByteArray>(Channel.UNLIMITED)
    private val exitChannel = Channel<RuntimeProcessExit>(Channel.UNLIMITED)
    private val started = CompletableDeferred<String>()

    private var remotePid = 0

    private var finished = false

    override val pid: Int
        get() = remotePid

    override val stdout: Flow<ByteArray> = stdoutChannel.receiveAsFlow()
    override val stderr: Flow<ByteArray> = stderrChannel.receiveAsFlow()

    init {
        scope.launch {
            try {
                val handle = client.startProcess(
                    command = commandLine,
                    cwd = spec.workingDirectory.takeIf { it.isNotBlank() && it != "/root" },
                    environment = spec.environment,
                )
                remotePid = handle.pid
                started.complete(handle.processId)
                client.processEvents.collect { event ->
                    if (finished) return@collect
                    val payload = event["payload"] as? JsonObject ?: return@collect
                    val eventName = event.stringValue("event")
                    val processId = payload.stringValue("process_id")
                    if (processId.isEmpty() || processId != handle.processId) return@collect
                    when (eventName) {
                        "srv_process_output" -> {
                            val bytes = decodeBase64(payload.stringValue("data_base64"))
                            if (bytes.isEmpty()) return@collect
                            if (payload.stringValue("stream") == "stderr") {
                                stderrChannel.send(bytes)
                            } else {
                                stdoutChannel.send(bytes)
                            }
                        }
                        "srv_process_exit" -> {
                            finished = true
                            exitChannel.send(
                                RuntimeProcessExit(
                                    exitCode = (payload["exit_code"] as? JsonPrimitive)?.intOrNull ?: -1,
                                ),
                            )
                            stdoutChannel.close()
                            stderrChannel.close()
                            exitChannel.close()
                        }
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                started.completeExceptionally(error)
                stderrChannel.send("${error.message.orEmpty()}\n".encodeToByteArray())
                exitChannel.send(RuntimeProcessExit(-1))
                stdoutChannel.close()
                stderrChannel.close()
                exitChannel.close()
            }
        }
    }

    override suspend fun writeStdin(bytes: ByteArray) {
        client.writeProcessStdin(started.await(), bytes)
    }

    override suspend fun closeStdin() {
        runCatching { client.closeProcessStdin(started.await()) }
    }

    override suspend fun awaitExit(): RuntimeProcessExit = exitChannel.receive()

    override suspend fun signal(signal: RuntimeProcessSignal) {
        val processId = runCatching { started.await() }.getOrNull() ?: return
        val name = when (signal) {
            RuntimeProcessSignal.Interrupt -> "SIGINT"
            RuntimeProcessSignal.Terminate -> "SIGTERM"
            RuntimeProcessSignal.Kill -> "SIGKILL"
        }
        runCatching { client.signalProcess(processId, name) }
    }
}

/** POSIX-quotes every argument so `sh -c` receives the intended argv. */
internal fun buildCommandLine(spec: RuntimeProcessSpec): String = buildString {
    append(shellQuote(spec.executable))
    spec.arguments.forEach { append(' ').append(shellQuote(it)) }
}

private fun shellQuote(value: String): String {
    if (value.isEmpty()) return "''"
    if (value.all { it.isLetterOrDigit() || it in "-_./:=@%+," }) return value
    return "'" + value.replace("'", "'\\''") + "'"
}

private fun encodeBase64(bytes: ByteArray): String = Base64.Default.encode(bytes)

private fun decodeBase64(value: String): ByteArray =
    if (value.isEmpty()) ByteArray(0) else Base64.Default.decode(value)

private fun JsonObject.boolean(name: String): Boolean =
    (this[name] as? JsonPrimitive)?.booleanOrNull ?: false

private fun JsonObject.long(name: String): Long =
    (this[name] as? JsonPrimitive)?.longOrNull ?: 0L

private fun JsonObject.base64(name: String): ByteArray {
    val value = (this[name] as? JsonPrimitive)?.contentOrNull.orEmpty()
    return if (value.isEmpty()) ByteArray(0) else kotlin.io.encoding.Base64.Default.decode(value)
}
