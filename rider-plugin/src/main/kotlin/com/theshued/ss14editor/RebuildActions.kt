package com.theshued.ss14editor

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.platform.lsp.api.LspServerManager
import com.intellij.platform.lsp.api.LspServerState
import org.eclipse.lsp4j.ExecuteCommandParams

/** An SS14 fork by the same cheap test the content-root activity uses: `RobustToolbox/` at the root. */
internal fun isSs14Fork(project: Project): Boolean = project.guessProjectDir()?.findChild("RobustToolbox") != null

/**
 * Sends one of the server's `workspace/executeCommand` commands to the project's
 * running SS14 server. Shown only in SS14 forks, and always enabled there: a
 * menu whose items are all disabled is hidden, which reads as "missing". With
 * no server running yet (it starts with the first prototype file opened), it
 * says so instead.
 */
abstract class Ss14CommandAction(private val command: String, private val textKey: String) : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project?.let(::isSs14Fork) == true
        // In the plugin's language rather than plugin.xml's fixed English.
        e.presentation.text = Ss14Bundle.message("$textKey.text")
        e.presentation.description = Ss14Bundle.message("$textKey.description")
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val running = LspServerManager.getInstance(project)
            .getServersForProvider(Ss14LspServerSupportProvider::class.java)
            .filter { it.state == LspServerState.Running }
        if (running.isEmpty()) {
            NotificationGroupManager.getInstance().getNotificationGroup("SS14 Editor")
                .createNotification(
                    Ss14Bundle.message("notification.notRunning.title"),
                    Ss14Bundle.message("notification.notRunning.content"),
                    NotificationType.INFORMATION,
                )
                .notify(project)
            return
        }
        for (server in running) {
            server.sendNotification { it.workspaceService.executeCommand(ExecuteCommandParams(command, emptyList())) }
        }
    }
}

class RebuildSchemaAction : Ss14CommandAction("ss14editor.rebuildSchema", "action.rebuildSchema")

class RebuildPrototypeIndexAction : Ss14CommandAction("ss14editor.rebuildPrototypeIndex", "action.rebuildPrototypeIndex")
