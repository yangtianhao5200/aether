package com.zhousl.aether.remote

import com.zhousl.aether.data.RemoteAgentConnectionState
import com.zhousl.aether.data.platformRandomUuid
import com.zhousl.aether.runtime.PiBridgeTransport
import com.zhousl.aether.runtime.RuntimeProcess
import com.zhousl.aether.runtime.RuntimeProcessExit
import com.zhousl.aether.runtime.RuntimeProcessSignal
import com.zhousl.aether.runtime.RuntimeProcessStdinException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Runs the Pi bridge on a remote server instead of inside the local Alpine VM.
 *
 * The contract is identical to [com.zhousl.aether.runtime.RuntimePiBridgeTransport]:
 * the rest of the app keeps talking newline-delimited JSON to a "process". Here
 * that process is the server-side bridge reached over a WebSocket, which is why
 * the agent loop, tools, extensions, skills and host tools behave exactly as
 * they do on device.
 */
class RemotePiBridgeTransport(
    private val client: RemoteAetherClient,
) : PiBridgeTransport {
    override suspend fun start(): RuntimeProcess {
        client.connect()
        return RemoteBridgeProcess(client)
    }

    override suspend fun stop() {
        client.close()
    }
}

private val bridgeJson = Json { encodeDefaults = false }

class RemoteBridgeProcess(
    private val client: RemoteAetherClient,
) : RuntimeProcess {
    override val pid: Int = 70_000 + (platformRandomUuid().hashCode() and 0x3fff)

    /**
     * Emits bridge frames as the exact JSON lines the local bridge would print,
     * and completes when the socket drops so the client treats it as a process
     * exit and fails pending requests instead of hanging.
     */
    override val stdout: Flow<ByteArray> = channelFlow {
        try {
            client.frames.collect { frame ->
                when {
                    frame.frameType() == "connection_closed" -> throw ConnectionClosed()
                    frame.isBridgeFrame() -> send(
                        (bridgeJson.encodeToString(JsonObject.serializer(), frame) + "\n")
                            .encodeToByteArray(),
                    )
                }
            }
        } catch (_: ConnectionClosed) {
            // Normal end of the remote "process".
        }
    }

    override val stderr: Flow<ByteArray> = flow {
        client.lastError.collect { message ->
            if (message.isNotBlank()) emit("$message\n".encodeToByteArray())
        }
    }

    override suspend fun writeStdin(bytes: ByteArray) {
        try {
            client.sendBridgeLine(bytes.decodeToString())
        } catch (error: RemoteAgentException) {
            throw RuntimeProcessStdinException(
                pid,
                error.message ?: "The remote Pi bridge rejected this request.",
            )
        }
    }

    override suspend fun closeStdin() {
        client.close()
    }

    override suspend fun awaitExit(): RuntimeProcessExit {
        val before = client.disconnectCount.value
        client.awaitDisconnectAfter(before)
        return RuntimeProcessExit(
            exitCode = if (client.state.value == RemoteAgentConnectionState.Connected) 0 else 1,
        )
    }

    override suspend fun signal(signal: RuntimeProcessSignal) {
        when (signal) {
            RuntimeProcessSignal.Interrupt,
            RuntimeProcessSignal.Terminate,
            RuntimeProcessSignal.Kill,
            -> client.close()
        }
    }
}

internal fun JsonObject.isBridgeFrame(): Boolean = when (frameType()) {
    "response", "error", "event" -> true
    else -> false
}

internal fun JsonObject.frameType(): String? = (this["type"] as? JsonPrimitive)?.contentOrNull

internal fun JsonObject.stringValue(name: String): String =
    (this[name] as? JsonPrimitive)?.contentOrNull.orEmpty()

private class ConnectionClosed : RuntimeException(null, null, false, false)
