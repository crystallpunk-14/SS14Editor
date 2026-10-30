package com.theshued.ss14editor

import com.intellij.codeInsight.navigation.actions.GotoDeclarationHandler
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.platform.lsp.api.LspServer
import com.intellij.platform.lsp.api.LspServerManager
import com.intellij.platform.lsp.api.LspServerState
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiManager
import org.eclipse.lsp4j.DefinitionParams
import org.eclipse.lsp4j.Location
import org.eclipse.lsp4j.LocationLink
import org.eclipse.lsp4j.Position

/** How long a Ctrl+hover or Ctrl+click waits for the server before giving up on a link. */
private const val DEFINITION_TIMEOUT_MS = 1000

/**
 * Go-to-definition in prototype files through the platform's own handler rather
 * than the LSP client's: the editor asks a `GotoDeclarationHandler` on Ctrl+hover
 * too, so a prototype id, a component name or a `!type:` tag that leads
 * somewhere turns into a link — blue and underlined, as in a `.cs` file — and
 * Ctrl+click / Ctrl+B follow it. The LSP client's own definition support is
 * switched off ([Ss14LspServerDescriptor]) so a jump is not offered twice.
 *
 * The answer is still the server's `textDocument/definition`; this only turns
 * its locations into PSI elements the platform can navigate to.
 */
class Ss14GotoDeclarationHandler : GotoDeclarationHandler {
    override fun getGotoDeclarationTargets(sourceElement: PsiElement?, offset: Int, editor: Editor): Array<PsiElement>? {
        val file = sourceElement?.containingFile?.virtualFile ?: return null
        if (!isPrototypeFile(file)) return null
        val project = sourceElement.project
        val server = LspServerManager.getInstance(project)
            .getServersForProvider(Ss14LspServerSupportProvider::class.java)
            .firstOrNull { it.state == LspServerState.Running } ?: return null

        val document = editor.document
        val line = document.getLineNumber(offset)
        val params = DefinitionParams(
            server.getDocumentIdentifier(file),
            Position(line, offset - document.getLineStartOffset(line)),
        )
        val result = server.sendRequestSync(DEFINITION_TIMEOUT_MS) { it.textDocumentService.definition(params) }
            ?: return null

        val targets = if (result.isLeft) {
            result.left.map { it.targetOf() }
        } else {
            result.right.map { it.targetOf() }
        }
        return targets.mapNotNull { (uri, position) -> elementAt(server, uri, position) }
            .toTypedArray()
            .takeIf { it.isNotEmpty() }
    }

    private fun Location.targetOf(): Pair<String, Position> = uri to range.start

    private fun LocationLink.targetOf(): Pair<String, Position> = targetUri to targetSelectionRange.start

    /** The PSI element at `position` of the file `uri` names — the file itself when it has no finer one. */
    private fun elementAt(server: LspServer, uri: String, position: Position): PsiElement? {
        val file = server.descriptor.findFileByUri(uri) ?: return null
        val psiFile = PsiManager.getInstance(server.project).findFile(file) ?: return null
        val document = FileDocumentManager.getInstance().getDocument(file) ?: return psiFile
        if (position.line >= document.lineCount) return psiFile
        val offset = (document.getLineStartOffset(position.line) + position.character)
            .coerceAtMost(document.getLineEndOffset(position.line))
        return psiFile.findElementAt(offset) ?: psiFile
    }
}
