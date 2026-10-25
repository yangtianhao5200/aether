package com.zhousl.aether.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import com.zhousl.aether.data.RemoteAgentConfig
import com.zhousl.aether.shared.resources.Res
import com.zhousl.aether.shared.resources.close_label
import com.zhousl.aether.shared.resources.common_hide_password
import com.zhousl.aether.shared.resources.common_show_password
import com.zhousl.aether.shared.resources.onboarding_remote_continue
import com.zhousl.aether.shared.resources.onboarding_remote_hint
import com.zhousl.aether.shared.resources.onboarding_remote_invalid
import com.zhousl.aether.shared.resources.onboarding_remote_paste
import com.zhousl.aether.shared.resources.onboarding_remote_subtitle
import com.zhousl.aether.shared.resources.onboarding_remote_test
import com.zhousl.aether.shared.resources.onboarding_remote_test_failed
import com.zhousl.aether.shared.resources.onboarding_remote_test_ok
import com.zhousl.aether.shared.resources.onboarding_remote_testing
import com.zhousl.aether.shared.resources.onboarding_remote_title
import com.zhousl.aether.shared.resources.onboarding_remote_token_label
import com.zhousl.aether.shared.resources.onboarding_remote_token_placeholder
import com.zhousl.aether.shared.resources.onboarding_remote_url_label
import com.zhousl.aether.shared.resources.onboarding_remote_url_placeholder
import com.zhousl.aether.shared.resources.onboarding_remote_workspace_label
import com.zhousl.aether.shared.resources.onboarding_remote_workspace_placeholder
import com.zhousl.aether.shared.resources.skip_label
import com.zhousl.aether.ui.theme.AetherBackground
import com.zhousl.aether.ui.theme.AetherOnSurface
import com.zhousl.aether.ui.theme.AetherOnSurfaceVariant
import com.zhousl.aether.ui.theme.AetherPrimary
import com.zhousl.aether.ui.theme.AetherOutlineSoft
import org.jetbrains.compose.resources.stringResource

private val RemoteStepEasing = CubicBezierEasing(0.22f, 0.84f, 0.18f, 1f)
private const val RemoteStepEnterDuration = 520

/**
 * First-run step that connects the app to its remote agent host.
 *
 * Aether is remote-first: the agent (DeepSeek Harness or Pi on a server) owns
 * the workspace, the tools and the model catalog, and this app only renders and
 * steers it. There is deliberately no local Alpine step before this one.
 */
@Composable
fun OnboardingRemoteAgentStep(
    stepIndex: Int,
    stepCount: Int,
    replayMode: Boolean,
    config: RemoteAgentConfig,
    isTesting: Boolean,
    testOk: Boolean?,
    testMessage: String,
    onConfigChange: (RemoteAgentConfig) -> Unit,
    onTest: () -> Unit,
    onComplete: () -> Unit,
    onPasteConnection: () -> Unit = {},
    onBack: (() -> Unit)? = null,
    timelineSpec: OnboardingTimelineSpec? = null,
) {
    var visible by remember(stepIndex, replayMode) { mutableStateOf(false) }
    LaunchedEffect(stepIndex, replayMode) {
        delay(140)
        visible = true
    }

    OnboardingConversationStepPage(
        stepIndex = stepIndex,
        stepCount = stepCount,
        message = stringResource(Res.string.onboarding_remote_title),
        onBack = onBack,
        topRightLabel = stringResource(if (replayMode) Res.string.close_label else Res.string.skip_label),
        onTopRight = onBack ?: {},
        timelineSpec = timelineSpec,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            AnimatedVisibility(
                visible = visible,
                enter = fadeIn(tween(durationMillis = RemoteStepEnterDuration, easing = RemoteStepEasing)) +
                    slideInVertically(tween(durationMillis = RemoteStepEnterDuration, easing = RemoteStepEasing)),
                label = "remote_step_content",
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    Text(
                        text = stringResource(Res.string.onboarding_remote_subtitle),
                        style = MaterialTheme.typography.bodyMedium,
                        color = AetherOnSurfaceVariant,
                    )
                    TextButton(
                        onClick = onPasteConnection,
                        colors = ButtonDefaults.textButtonColors(contentColor = AetherPrimary),
                        contentPadding = PaddingValues(horizontal = 0.dp, vertical = 4.dp),
                    ) {
                        Text(
                            text = stringResource(Res.string.onboarding_remote_paste),
                            style = MaterialTheme.typography.labelLarge,
                        )
                    }
                    RemoteAgentInputField(
                        label = stringResource(Res.string.onboarding_remote_url_label),
                        placeholder = stringResource(Res.string.onboarding_remote_url_placeholder),
                        value = config.serverUrl,
                        keyboardType = KeyboardType.Uri,
                        onValueChange = { value -> onConfigChange(config.copy(serverUrl = value)) },
                    )
                    RemoteAgentInputField(
                        label = stringResource(Res.string.onboarding_remote_token_label),
                        placeholder = stringResource(Res.string.onboarding_remote_token_placeholder),
                        value = config.token,
                        keyboardType = KeyboardType.Password,
                        onValueChange = { value -> onConfigChange(config.copy(token = value)) },
                    )
                    RemoteAgentInputField(
                        label = stringResource(Res.string.onboarding_remote_workspace_label),
                        placeholder = stringResource(Res.string.onboarding_remote_workspace_placeholder),
                        value = config.workspace,
                        keyboardType = KeyboardType.Text,
                        onValueChange = { value -> onConfigChange(config.copy(workspace = value)) },
                    )
                    Text(
                        text = stringResource(Res.string.onboarding_remote_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = AetherOnSurfaceVariant,
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        OutlinedButton(
                            onClick = onTest,
                            enabled = !isTesting && config.serverUrl.isNotBlank() && config.token.isNotBlank(),
                            shape = RoundedCornerShape(22.dp),
                        ) {
                            if (isTesting) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp,
                                    color = AetherPrimary,
                                )
                                Spacer(modifier = Modifier.width(10.dp))
                            }
                            Text(
                                stringResource(
                                    if (isTesting) {
                                        Res.string.onboarding_remote_testing
                                    } else {
                                        Res.string.onboarding_remote_test
                                    },
                                ),
                            )
                        }
                        if (testOk != null) {
                            Text(
                                text = stringResource(
                                    if (testOk) {
                                        Res.string.onboarding_remote_test_ok
                                    } else {
                                        Res.string.onboarding_remote_test_failed
                                    },
                                ),
                                style = MaterialTheme.typography.bodySmall,
                                color = if (testOk) AetherPrimary else AetherOnSurfaceVariant,
                            )
                        }
                    }
                    if (testMessage.isNotBlank() && testOk == false) {
                        Text(
                            text = testMessage,
                            style = MaterialTheme.typography.bodySmall,
                            color = AetherOnSurfaceVariant,
                            textAlign = TextAlign.Start,
                        )
                    }
                }
            }
            Spacer(modifier = Modifier.height(2.dp))
            AnimatedVisibility(
                visible = visible,
                enter = fadeIn(
                    animationSpec = tween(
                        durationMillis = RemoteStepEnterDuration,
                        delayMillis = 160,
                        easing = RemoteStepEasing,
                    ),
                ),
                label = "remote_step_actions",
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button(
                        onClick = onComplete,
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(24.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = Color.Black,
                            contentColor = Color.White,
                        ),
                    ) {
                        Text(stringResource(Res.string.onboarding_remote_continue))
                    }
                    if (!config.isConfigured) {
                        Text(
                            text = stringResource(Res.string.onboarding_remote_invalid),
                            style = MaterialTheme.typography.bodySmall,
                            color = AetherOnSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun RemoteAgentInputField(
    label: String,
    placeholder: String,
    value: String,
    keyboardType: KeyboardType,
    onValueChange: (String) -> Unit,
) {
    var revealed by remember { mutableStateOf(false) }
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelLarge,
                color = AetherOnSurfaceVariant,
            )
            if (keyboardType == KeyboardType.Password && value.isNotEmpty()) {
                Text(
                    text = stringResource(
                        if (revealed) Res.string.common_hide_password else Res.string.common_show_password,
                    ),
                    style = MaterialTheme.typography.labelSmall,
                    color = AetherPrimary,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { revealed = !revealed },
                )
            }
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(AetherBackground)
                .padding(horizontal = 14.dp, vertical = 14.dp),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier.fillMaxWidth(),
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = AetherOnSurface),
                cursorBrush = SolidColor(AetherPrimary),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
                visualTransformation = if (keyboardType == KeyboardType.Password && !revealed) {
                    PasswordVisualTransformation()
                } else {
                    VisualTransformation.None
                },
                decorationBox = { innerTextField ->
                    Box(modifier = Modifier.fillMaxWidth()) {
                        if (value.isEmpty()) {
                            Text(
                                text = placeholder,
                                style = MaterialTheme.typography.bodyLarge,
                                color = AetherOutlineSoft,
                            )
                        }
                        innerTextField()
                    }
                },
            )
        }
    }
}
