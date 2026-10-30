package com.theshued.ss14editor

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.platform.lsp.api.LspServerManager
import org.eclipse.lsp4j.ExecuteCommandParams

/** Sends one of the server's `workspace/executeCommand` commands to every running SS14 server of the project. */
abstract class Ss14CommandAction(private val command: String) : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        LspServerManager.getInstance(project)
            .getServersForProvider(Ss14LspServerSupportProvider::class.java)
            .forEach { server ->
                server.sendNotification { it.workspaceService.executeCommand(ExecuteCommandParams(command, emptyList())) }
            }
    }
}

class RebuildSchemaAction : Ss14CommandAction("ss14editor.rebuildSchema")

class RebuildPrototypeIndexAction : Ss14CommandAction("ss14editor.rebuildPrototypeIndex")
