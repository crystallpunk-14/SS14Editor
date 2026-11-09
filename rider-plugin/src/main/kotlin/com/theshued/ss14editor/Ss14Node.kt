package com.theshued.ss14editor

import com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterManager
import com.intellij.javascript.nodejs.interpreter.local.NodeJsLocalInterpreter
import com.intellij.javascript.nodejs.interpreter.local.NodeJsLocalInterpreterManager
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUiKind
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ex.ActionUtil
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.intellij.platform.lsp.api.LspServerManager
import java.util.concurrent.atomic.AtomicBoolean

/** The oldest Node the server bundle and `vscode-languageserver` are run on. */
private const val MIN_NODE_MAJOR = 18

/** Rider's own "Download Node.js" (JavaScript plugin), the same as in Settings | Node.js. */
private const val DOWNLOAD_NODE_ACTION = "JavaScript.DownloadNode"

/**
 * Node for the language server, through Rider's JavaScript plugin (ADR-0002):
 * the project's Node interpreter (Settings | Languages & Frameworks | Node.js),
 * else the most relevant one Rider detects on the machine. `null` when there is
 * none, or it is older than [MIN_NODE_MAJOR] — then [Ss14NodeService.reportMissing]
 * offers Rider's own download.
 */
internal fun findNode(project: Project): String? {
    val configured = NodeJsInterpreterManager.getInstance(project).interpreter as? NodeJsLocalInterpreter
    val node = configured?.takeIf { it.isValid } ?: NodeJsLocalInterpreterManager.getInstance().detectMostRelevant()
    if (node == null || !node.isValid) return null
    val major = node.cachedVersion?.get()?.major
    return if (major != null && major < MIN_NODE_MAJOR) null else node.interpreterSystemDependentPath
}

/**
 * Per-project: says once that Node is missing, and starts the server as soon as
 * a Node interpreter is set — which is what Rider's download does when it finishes.
 */
@Service(Service.Level.PROJECT)
class Ss14NodeService(private val project: Project) : Disposable {
    private val reported = AtomicBoolean(false)

    init {
        NodeJsInterpreterManager.getInstance(project).addChangeListener({
            reported.set(false)
            LspServerManager.getInstance(project).startServersIfNeeded(Ss14LspServerSupportProvider::class.java)
        }, this)
    }

    fun reportMissing() {
        if (!reported.compareAndSet(false, true)) return
        NotificationGroupManager.getInstance().getNotificationGroup("SS14 Editor")
            .createNotification(
                Ss14Bundle.message("notification.nodeMissing.title"),
                Ss14Bundle.message("notification.nodeMissing.content", MIN_NODE_MAJOR),
                NotificationType.WARNING,
            )
            .addAction(
                NotificationAction.createSimpleExpiring(Ss14Bundle.message("notification.nodeMissing.download")) {
                    downloadNode()
                },
            )
            .addAction(NotificationAction.createSimple(Ss14Bundle.message("notification.nodeMissing.settings")) {
                ShowSettingsUtil.getInstance().showSettingsDialog(project, "Node.js")
            })
            .notify(project)
    }

    private fun downloadNode() {
        val action = ActionManager.getInstance().getAction(DOWNLOAD_NODE_ACTION)
        if (action == null) {
            ShowSettingsUtil.getInstance().showSettingsDialog(project, "Node.js")
            return
        }
        val event = AnActionEvent.createEvent(
            action,
            SimpleDataContext.getProjectContext(project),
            null,
            "SS14Notification",
            ActionUiKind.NONE,
            null,
        )
        ActionUtil.performAction(action, event)
    }

    override fun dispose() {}

    companion object {
        fun getInstance(project: Project): Ss14NodeService = project.service()
    }
}
