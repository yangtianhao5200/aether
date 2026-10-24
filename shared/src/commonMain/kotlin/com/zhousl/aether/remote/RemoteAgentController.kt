package com.zhousl.aether.remote

import com.zhousl.aether.data.RemoteAgentConfig
import com.zhousl.aether.data.RemoteAgentConnectionState
import com.zhousl.aether.runtime.MultiplatformLocalRuntime
import com.zhousl.aether.runtime.PiBridgeTransport
import com.zhousl.aether.runtime.RuntimeFileSystem
import com.zhousl.aether.runtime.RuntimeProcess
import com.zhousl.aether.runtime.RuntimeProcessSpec
import com.zhousl.aether.runtime.RuntimeSetupProgress
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withTimeout

data class RemoteConnectionTestResult(
    val ok: Boolean,
    val message: String,
    val serverVersion: String = "",
    val workspace: String = "",
    val homeDirectory: String = "",
    val workspaceDirectory: String = "",
    val agentDirectory: String = "",
)

/**
 * Single owner of the remote agent connection for one app instance.
 *
 * The UI switches [useRemote] when the user enables the remote host; the
 * switchable runtime and transport below then route every bridge call and every
 * file-system operation to the server without the rest of the app noticing.
 */
class RemoteAgentController(
    initialConfig: RemoteAgentConfig,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    private val _config = MutableStateFlow(initialConfig)
    val config: StateFlow<RemoteAgentConfig> = _config.asStateFlow()

    private val _connectionState =
        MutableStateFlow(if (initialConfig.enabled) RemoteAgentConnectionState.Idle else RemoteAgentConnectionState.Disabled)
    val connectionState: StateFlow<RemoteAgentConnectionState> = _connectionState.asStateFlow()

    /** Last connection error reported by the client (empty when healthy). */
    val lastError: StateFlow<String>
        get() = client.lastError

    fun updateConfig(config: RemoteAgentConfig) {
        _config.value = config
        client.updateConfig(config)
        _connectionState.value = when {
            !config.enabled -> RemoteAgentConnectionState.Disabled
            client.isConnected -> RemoteAgentConnectionState.Connected
            else -> RemoteAgentConnectionState.Idle
        }
    }

    val client = RemoteAetherClient(initialConfig, scope = scope)
    val runtime = RemoteRuntime(client, scope)
    val transport = RemotePiBridgeTransport(client)

    /** True when agent work should run on the server. */
    val useRemote: Boolean
        get() = _config.value.isConfigured

    val workspaceRoot: String
        get() = if (useRemote) runtime.workspaceRoot else ""
}

/**
 * Routes bridge traffic to the server or to the on-device runtime, depending on
 * the current configuration. Re-reading the flag happens on every `start()`, so
 * flipping the setting only requires [com.zhousl.aether.runtime.SharedPiBridgeClient.reset].
 */
class SwitchablePiBridgeTransport(
    private val local: PiBridgeTransport,
    private val remote: RemotePiBridgeTransport,
    private val remoteEnabled: () -> Boolean,
) : PiBridgeTransport {
    private var active: PiBridgeTransport? = null

    override suspend fun start(): RuntimeProcess {
        val chosen = if (remoteEnabled()) remote else local
        active = chosen
        return chosen.start()
    }

    override suspend fun stop() {
        val current = active
        active = null
        current?.stop()
        // Stop the other side too, so a mode switch never leaves two bridges.
        if (remoteEnabled()) local.stop() else remote.stop()
    }
}

/**
 * The workspace the app should use right now: the local Alpine VM or the
 * server. Only the remote branch touches the network.
 */
class SwitchableRuntime(
    private val local: MultiplatformLocalRuntime,
    private val remote: RemoteRuntime,
    private val remoteEnabled: () -> Boolean,
) : MultiplatformLocalRuntime {
    private val localActive: Boolean
        get() = !remoteEnabled()

    override val homeDirectory: String
        get() = if (localActive) local.homeDirectory else remote.homeDirectory

    override val workspaceRoot: String
        get() = if (localActive) local.workspaceRoot else remote.workspaceRoot

    override val fileSystem: RuntimeFileSystem
        get() = if (localActive) local.fileSystem else remote.fileSystem

    override val bridgeRuntimeId: String
        get() = if (localActive) local.bridgeRuntimeId else remote.bridgeRuntimeId

    override val bridgeDirectory: String
        get() = if (localActive) local.bridgeDirectory else remote.bridgeDirectory

    override suspend fun isReady(): Boolean =
        if (localActive) {
            local.isReady()
        } else {
            // A remote runtime is "ready" once the handshake succeeded; the
            // callers check readiness before initializing, so connect here.
            runCatching {
                remote.client.connect()
                true
            }.getOrDefault(false)
        }

    override suspend fun initialize(onProgress: (RuntimeSetupProgress) -> Unit) {
        if (localActive) {
            local.initialize(onProgress)
        } else {
            remote.initialize(onProgress)
        }
    }

    override suspend fun reset() {
        if (localActive) local.reset() else remote.reset()
    }

    override suspend fun startProcess(spec: RuntimeProcessSpec): RuntimeProcess =
        if (localActive) local.startProcess(spec) else remote.startProcess(spec)
}

/** One-shot connectivity check used by the settings screen. */
suspend fun testRemoteAgentConnection(
    config: RemoteAgentConfig,
    timeoutMillis: Long = 15_000,
): RemoteConnectionTestResult {
    if (config.serverUrl.isBlank()) {
        return RemoteConnectionTestResult(false, "Server URL is empty.")
    }
    if (config.token.isBlank()) {
        return RemoteConnectionTestResult(false, "Access token is empty.")
    }
    // "Test" must work before the user flips the enable switch.
    val client = RemoteAetherClient(config.copy(enabled = true))
    return try {
        val hello = withTimeout(timeoutMillis) { client.connect() }
        val ping = runCatching { withTimeout(timeoutMillis) { client.ping() } }.getOrNull()
        val bridgeVersion = ping?.get("bridge_version")?.toString()?.trim('"').orEmpty()
        RemoteConnectionTestResult(
            ok = true,
            message = if (bridgeVersion.isBlank()) {
                "Connected to the remote agent server."
            } else {
                "Connected. Bridge $bridgeVersion ready."
            },
            serverVersion = hello.serverVersion,
            workspace = hello.workspace,
            homeDirectory = hello.homeDirectory,
            workspaceDirectory = hello.workspaceDirectory,
            agentDirectory = hello.agentDirectory,
        )
    } catch (error: kotlinx.coroutines.TimeoutCancellationException) {
        RemoteConnectionTestResult(false, "Timed out while connecting to ${config.normalizedServerUrl()}.")
    } catch (error: Throwable) {
        RemoteConnectionTestResult(false, error.message ?: "Unable to connect.")
    } finally {
        runCatching { client.close() }
        client.dispose()
    }
}
