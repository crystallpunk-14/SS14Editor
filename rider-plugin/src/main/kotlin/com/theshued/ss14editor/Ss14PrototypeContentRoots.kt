package com.theshued.ss14editor

import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.platform.backend.workspace.workspaceModel
import com.intellij.platform.lsp.api.LspServerManager
import com.intellij.platform.workspace.jps.entities.ContentRootEntity
import com.intellij.platform.workspace.jps.entities.ModuleEntity
import com.intellij.platform.workspace.storage.EntitySource
import com.intellij.platform.workspace.storage.MutableEntityStorage

private val LOG = logger<Ss14PrototypeContentRoots>()

/** The prototype roots the index reads (`PROTOTYPE_ROOTS` in the TS core). */
private val PROTOTYPE_DIRS = listOf("Resources/Prototypes", "RobustToolbox/Resources/EnginePrototypes")

/**
 * Marks our entities. Not a JPS source, so nothing serializes them: they live
 * only in memory and the fork's `.idea` is never written.
 */
private object Ss14EntitySource : EntitySource

/**
 * In Rider, project content is what the `.csproj` files include, and `Resources/`
 * is in none of them — so a prototype file is not content, and the platform LSP
 * manager never offers it to {@link Ss14LspServerSupportProvider} (ADR-0002).
 * On opening a fork, add the prototype folders as content roots of an in-memory
 * module; then the LSP manager sees them like any project file.
 */
class Ss14PrototypeContentRoots : ProjectActivity {
    override suspend fun execute(project: Project) {
        val root = project.guessProjectDir() ?: return
        if (root.findChild("RobustToolbox") == null) return
        val dirs = PROTOTYPE_DIRS.mapNotNull { root.findFileByRelativePath(it) }
        if (dirs.isEmpty()) return

        val workspaceModel = project.workspaceModel
        val urls = workspaceModel.getVirtualFileUrlManager()
        val replacement = MutableEntityStorage.create().apply {
            addEntity(ModuleEntity("SS14 Prototypes", emptyList(), Ss14EntitySource) {
                contentRoots = dirs.map { ContentRootEntity(urls.getOrCreateFromUrl(it.url), emptyList(), Ss14EntitySource) }
            })
        }
        workspaceModel.update("SS14: prototype folders as content") { storage ->
            storage.replaceBySource({ it == Ss14EntitySource }, replacement)
        }
        LOG.info("SS14: added content roots ${dirs.joinToString { it.path }}")

        // Files restored on startup were opened before they were content.
        LspServerManager.getInstance(project).startServersIfNeeded(Ss14LspServerSupportProvider::class.java)
    }
}
