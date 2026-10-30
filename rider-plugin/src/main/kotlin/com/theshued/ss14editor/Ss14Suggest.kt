package com.theshued.ss14editor

import com.google.gson.JsonObject
import com.intellij.codeInsight.AutoPopupController
import com.intellij.codeInsight.completion.CompletionParameters
import com.intellij.codeInsight.editorActions.BackspaceHandlerDelegate
import com.intellij.codeInsight.editorActions.enter.EnterHandlerDelegate
import com.intellij.codeInsight.lookup.LookupElement
import com.intellij.codeInsight.lookup.LookupElementDecorator
import com.intellij.codeInsight.lookup.LookupManager
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.EDT
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.platform.lsp.api.LspServerManager
import com.intellij.platform.lsp.api.LspServerState
import com.intellij.platform.lsp.api.customization.LspCompletionSupport
import com.intellij.psi.PsiFile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.eclipse.lsp4j.CompletionItem
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import org.eclipse.lsp4j.services.LanguageServer
import java.util.concurrent.CompletableFuture

/**
 * Reopening the completion list where the editor never does on its own — the
 * Rider side of the VS Code host's `triggerSuggestOnEdit` and `ss14editor.suggestIfAny`:
 * after a candidate that continues is inserted (a field key that wrote its colon,
 * a folder that wrote its `/`), after Backspace, and after Enter. The server
 * decides with the same core functions (`ss14/shouldSuggest`); this only asks.
 */
enum class SuggestReason(val wire: String) {
    ACCEPTED("accepted"),
    DELETION("deletion"),
    NEWLINE("newline"),
}

/** `ss14/shouldSuggest` params: the document as the editor has it now, so no `didChange` race. */
data class ShouldSuggestParams(val uri: String, val text: String, val offset: Int, val reason: String)

/** The server's own request on top of LSP. */
interface Ss14LanguageServer : LanguageServer {
    @JsonRequest("ss14/shouldSuggest")
    fun shouldSuggest(params: ShouldSuggestParams): CompletableFuture<Boolean>
}

@Service(Service.Level.PROJECT)
class Ss14SuggestService(private val project: Project, private val scope: CoroutineScope) {
    /**
     * Ask the server once the current command has finished (auto-indent after
     * Enter, the rest of an insert), and open the list only if the editor is
     * still where it was asked about.
     */
    fun suggestLater(editor: Editor, reason: SuggestReason) {
        ApplicationManager.getApplication().invokeLater({ ask(editor, reason) }, project.disposed)
    }

    private fun ask(editor: Editor, reason: SuggestReason) {
        if (editor.isDisposed || editor.caretModel.caretCount != 1) return
        val document = editor.document
        val file = FileDocumentManager.getInstance().getFile(document) ?: return
        if (!isPrototypeFile(file)) return
        val server = LspServerManager.getInstance(project)
            .getServersForProvider(Ss14LspServerSupportProvider::class.java)
            .firstOrNull { it.state == LspServerState.Running } ?: return

        val stamp = document.modificationStamp
        val offset = editor.caretModel.offset
        val params = ShouldSuggestParams(server.descriptor.getFileUri(file), document.text, offset, reason.wire)
        scope.launch {
            val wanted = server.sendRequest { (it as Ss14LanguageServer).shouldSuggest(params) } == true
            if (!wanted) return@launch
            withContext(Dispatchers.EDT) {
                val unchanged = !editor.isDisposed &&
                    document.modificationStamp == stamp &&
                    editor.caretModel.offset == offset &&
                    LookupManager.getActiveLookup(editor) == null
                if (unchanged) AutoPopupController.getInstance(project).scheduleAutoPopup(editor)
            }
        }
    }

    companion object {
        fun getInstance(project: Project): Ss14SuggestService = project.service()
    }
}

/**
 * LSP completion as usual, except that a candidate the server marks
 * `data.continues` asks for the next list once it is inserted.
 */
class Ss14CompletionSupport : LspCompletionSupport() {
    override fun createLookupElement(parameters: CompletionParameters, item: CompletionItem): LookupElement? {
        val element = super.createLookupElement(parameters, item) ?: return null
        if (!continues(item)) return element
        return LookupElementDecorator.withInsertHandler(element) { context, decorated ->
            decorated.delegate.handleInsert(context)
            Ss14SuggestService.getInstance(context.project).suggestLater(context.editor, SuggestReason.ACCEPTED)
        }
    }

    private fun continues(item: CompletionItem): Boolean {
        val continues = (item.data as? JsonObject)?.get("continues") ?: return false
        return continues.isJsonPrimitive && continues.asBoolean
    }
}

/** Backspace into a value: VS Code's `reopensSuggestAfterDeletion`. */
class Ss14BackspaceHandler : BackspaceHandlerDelegate() {
    override fun beforeCharDeleted(c: Char, file: PsiFile, editor: Editor) {}

    override fun charDeleted(c: Char, file: PsiFile, editor: Editor): Boolean {
        if (isPrototypeFile(file.virtualFile ?: return false)) {
            Ss14SuggestService.getInstance(file.project).suggestLater(editor, SuggestReason.DELETION)
        }
        return false
    }
}

/** The fresh line after Enter: VS Code's `opensSuggestOnNewLine`. */
class Ss14EnterHandler : EnterHandlerDelegate {
    override fun postProcessEnter(file: PsiFile, editor: Editor, dataContext: DataContext): EnterHandlerDelegate.Result {
        val virtualFile = file.virtualFile
        if (virtualFile != null && isPrototypeFile(virtualFile)) {
            Ss14SuggestService.getInstance(file.project).suggestLater(editor, SuggestReason.NEWLINE)
        }
        return EnterHandlerDelegate.Result.Continue
    }
}
