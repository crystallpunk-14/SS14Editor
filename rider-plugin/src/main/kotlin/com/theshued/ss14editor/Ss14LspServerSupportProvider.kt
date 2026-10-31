package com.theshued.ss14editor

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.LspServerSupportProvider
import com.intellij.platform.lsp.api.LspServerDescriptor
import com.intellij.platform.lsp.api.customization.LspCompletionCustomizer
import com.intellij.platform.lsp.api.customization.LspCustomization
import com.intellij.platform.lsp.api.customization.LspGoToDefinitionCustomizer
import com.intellij.platform.lsp.api.customization.LspGoToDefinitionDisabled
import com.intellij.platform.lsp.api.customization.LspSemanticTokensCustomizer
import org.eclipse.lsp4j.services.LanguageServer
import java.nio.file.Path

private val LOG = logger<Ss14LspServerSupportProvider>()

/** A YAML file under `Resources/Prototypes/` — what the VS Code selector matches. */
internal fun isPrototypeFile(file: VirtualFile): Boolean = isPrototypePath(file.path)

/** [isPrototypeFile] on a `/`-separated path, as `VirtualFile.path` spells it. */
internal fun isPrototypePath(path: String): Boolean =
    (path.endsWith(".yml") || path.endsWith(".yaml")) && path.contains("/Resources/Prototypes/")

/**
 * Starts the language server the first time a prototype file is opened. The
 * server itself decides whether the project root is an SS14 fork and logs why
 * not; this only keeps it from starting in unrelated projects.
 */
class Ss14LspServerSupportProvider : LspServerSupportProvider {
    override fun fileOpened(
        project: Project,
        file: VirtualFile,
        serverStarter: LspServerSupportProvider.LspServerStarter,
    ) {
        if (!isPrototypeFile(file)) return
        val root = project.guessProjectDir() ?: return
        val node = findNode(project)
        LOG.info("SS14: prototype file opened (${file.path}), fork root ${root.path}, node $node")
        if (node == null) {
            Ss14NodeService.getInstance(project).reportMissing()
            return
        }
        serverStarter.ensureServerStarted(Ss14LspServerDescriptor(project, root, node))
    }
}

/**
 * Rooted at the fork — the solution folder — rather than `ProjectWideLspServerDescriptor`'s
 * `BaseProjectDirectories`, which in Rider are the `.csproj` folders: `Resources/`
 * belongs to none of them, so prototype files would never reach the server.
 */
class Ss14LspServerDescriptor(project: Project, root: VirtualFile, private val node: String) :
    LspServerDescriptor(project, "SS14 Prototype Editor", root) {
    private val serverDir: Path =
        // `<plugin>/lib/<this>.jar` -> `<plugin>/server`: the plugin managers' lookups are internal API.
        Path.of(PathManager.getJarPathForClass(Ss14LspServerDescriptor::class.java)!!).parent.parent.resolve("server")

    override fun isSupportedFile(file: VirtualFile): Boolean = isPrototypeFile(file)

    /** `ss14/shouldSuggest` on top of LSP (stage 3). */
    override val lsp4jServerClass: Class<out LanguageServer> = Ss14LanguageServer::class.java

    override val lspCustomization: LspCustomization = object : LspCustomization() {
        /** Completion that reopens the list after a candidate that continues. */
        override val completionCustomizer: LspCompletionCustomizer = Ss14CompletionSupport()

        /** Component names in their own, configurable colour. */
        override val semanticTokensCustomizer: LspSemanticTokensCustomizer = Ss14SemanticTokensSupport()

        /** [Ss14GotoDeclarationHandler] serves go-to-definition, so Ctrl+hover shows links; not twice. */
        override val goToDefinitionCustomizer: LspGoToDefinitionCustomizer = LspGoToDefinitionDisabled
    }

    override fun createCommandLine(): GeneralCommandLine {
        LOG.info("SS14: starting the language server with $node, roots ${roots.joinToString { it.path }}")
        return GeneralCommandLine(node, serverDir.resolve("dist/server.js").toString(), "--stdio")
            .withWorkDirectory(serverDir.toFile())
    }

    override fun createInitializationOptions(): Any = mapOf(
        "storagePath" to PathManager.getSystemDir().resolve("ss14editor").toString(),
        "schemaCliPath" to serverDir.resolve("assets/schema-cli/SS14Editor.SchemaCli.dll").toString(),
        // Problems, diagnostics and progress in the plugin's language; a change restarts the server.
        "locale" to if (Ss14Settings.getInstance().effectiveLanguage == Ss14Language.RU) "ru" else "en",
    )
}
