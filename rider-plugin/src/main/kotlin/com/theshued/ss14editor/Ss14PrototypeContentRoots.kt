package com.theshued.ss14editor

import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.platform.backend.workspace.workspaceModel
import com.intellij.platform.lsp.api.LspServerManager
import com.intellij.platform.workspace.jps.entities.ContentRootEntity
import com.intellij.platform.workspace.jps.entities.ModuleEntity
import com.intellij.platform.workspace.storage.MutableEntityStorage
import com.intellij.workspaceModel.ide.NonPersistentEntitySource

private val LOG = logger<Ss14PrototypeContentRoots>()

/** The prototype roots the index reads (`PROTOTYPE_ROOTS` in the TS core). */
private val PROTOTYPE_DIRS = listOf("Resources/Prototypes", "RobustToolbox/Resources/EnginePrototypes")

/** Name of the in-memory module holding the prototype folders. */
private const val MODULE_NAME = "SS14 Prototypes"

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
        if (!isSs14Fork(project)) return
        val dirs = PROTOTYPE_DIRS.mapNotNull { root.findFileByRelativePath(it) }
        if (dirs.isEmpty()) return

        val workspaceModel = project.workspaceModel
        val urls = workspaceModel.getVirtualFileUrlManager()
        // `NonPersistentEntitySource` is neither saved to `.idea` nor to the
        // workspace-model cache (a custom source would need generated metadata
        // for the cache). It is shared, so ours is found by name, not by source.
        workspaceModel.update("SS14: prototype folders as content") { storage ->
            removePrototypeModule(storage)
            storage.addEntity(ModuleEntity(MODULE_NAME, emptyList(), NonPersistentEntitySource) {
                contentRoots = dirs.map {
                    ContentRootEntity(urls.getOrCreateFromUrl(it.url), emptyList(), NonPersistentEntitySource)
                }
            })
        }
        LOG.info("SS14: added content roots ${dirs.joinToString { it.path }}")

        // Files restored on startup were opened before they were content.
        LspServerManager.getInstance(project).startServersIfNeeded(Ss14LspServerSupportProvider::class.java)
    }
}

/** Drops our module, if present, from `storage`. */
private fun removePrototypeModule(storage: MutableEntityStorage) {
    storage.entities(ModuleEntity::class.java)
        .filter { it.name == MODULE_NAME && it.entitySource == NonPersistentEntitySource }
        .toList()
        .forEach { storage.removeEntity(it) }
}
