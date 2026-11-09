package com.theshued.ss14editor

import com.intellij.codeInsight.folding.CodeFoldingManager
import com.intellij.lang.ASTNode
import com.intellij.lang.folding.FoldingBuilderEx
import com.intellij.lang.folding.FoldingDescriptor
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.readAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.FoldRegion
import com.intellij.openapi.editor.RangeMarker
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.event.EditorFactoryEvent
import com.intellij.openapi.editor.event.EditorFactoryListener
import com.intellij.openapi.editor.ex.util.EditorUtil
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
import com.intellij.openapi.util.TextRange
import com.intellij.platform.lsp.api.Lsp4jClient
import com.intellij.platform.lsp.api.LspServerManager
import com.intellij.platform.lsp.api.LspServerNotificationsHandler
import com.intellij.platform.lsp.api.LspServerState
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.eclipse.lsp4j.jsonrpc.services.JsonNotification

/** Re-ask this long after the last edit; the folds ride along with the text meanwhile. */
private const val EDIT_DEBOUNCE_MS = 150L

/** `ss14/locIdFolds` params: the document as the editor has it now, so no `didChange` race. */
data class LocIdFoldsParams(val uri: String, val text: String)

/** A LocId value to fold: `[start, end)` of the value as written, and the translation it reads as. */
data class LocIdFold(val start: Int, val end: Int, val placeholder: String)

/** A fold kept in step with the text by its marker. */
private class InstalledFold(val marker: RangeMarker, val placeholder: String)

private val FOLDS = Key.create<List<InstalledFold>>("ss14.locIdFolds")
private val PENDING = Key.create<Job>("ss14.locIdFolds.pending")

/** The server's own notification on top of LSP: the folds may have changed (the schema, a `.ftl`). */
class Ss14Lsp4jClient(handler: LspServerNotificationsHandler, private val project: Project) : Lsp4jClient(handler) {
    @JsonNotification("ss14/locIdsChanged")
    fun locIdsChanged() {
        if (!project.isDisposed) Ss14LocIdFolds.getInstance(project).refreshAll()
    }
}

/**
 * Folds every LocId key in a prototype editor into its translation — the Rider
 * side of the VS Code `LocIdFoldingController`. The server says what folds
 * (`ss14/locIdFolds`); the answer is kept on the document for
 * [Ss14LocIdFoldingBuilder], which must not wait on the server. While a caret or
 * selection touches a key, that key shows as written, and folds back once the
 * caret leaves.
 */
@Service(Service.Level.PROJECT)
class Ss14LocIdFolds(private val project: Project, private val scope: CoroutineScope) {
    fun attach(editor: Editor) {
        val disposable: Disposable = Disposer.newDisposable("SS14 LocId folds")
        EditorUtil.disposeWithEditor(editor, disposable)
        editor.document.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) = refresh(event.document, EDIT_DEBOUNCE_MS)
        }, disposable)
        editor.caretModel.addCaretListener(object : CaretListener {
            override fun caretPositionChanged(event: CaretEvent) = applyFoldStateLater(editor)
        }, disposable)
        refresh(editor.document, 0)
    }

    /** Every open prototype document asks again. From any thread. */
    fun refreshAll() {
        ApplicationManager.getApplication().invokeLater({
            EditorFactory.getInstance().allEditors
                .filter { it.project == project }
                .map { it.document }
                .distinct()
                .filter { document -> FileDocumentManager.getInstance().getFile(document)?.let(::isPrototypeFile) == true }
                .forEach { refresh(it, 0) }
        }, project.disposed)
    }

    private fun refresh(document: Document, delayMs: Long) {
        document.getUserData(PENDING)?.cancel()
        if (!Ss14Settings.getInstance().foldLocIds) {
            install(document, emptyList())
            return
        }
        document.putUserData(PENDING, scope.launch {
            delay(delayMs)
            fetch(document)
        })
    }

    private suspend fun fetch(document: Document) {
        val file = FileDocumentManager.getInstance().getFile(document) ?: return
        val server = LspServerManager.getInstance(project)
            .getServersForProvider(Ss14LspServerSupportProvider::class.java)
            .firstOrNull { it.state == LspServerState.Running } ?: return

        val (stamp, text) = readAction { document.modificationStamp to document.text }
        val params = LocIdFoldsParams(server.descriptor.getFileUri(file), text)
        val folds = server.sendRequest { (it as Ss14LanguageServer).locIdFolds(params) } ?: return
        ApplicationManager.getApplication().invokeLater({
            // An edit since then has its own request on the way; these offsets are for the old text.
            if (document.modificationStamp == stamp) install(document, folds)
        }, project.disposed)
    }

    private fun install(document: Document, folds: List<LocIdFold>) {
        val before = document.getUserData(FOLDS).orEmpty()
        val same = before.size == folds.size && before.zip(folds).all { (old, new) ->
            old.marker.isValid && old.marker.startOffset == new.start && old.marker.endOffset == new.end &&
                old.placeholder == new.placeholder
        }
        if (same) {
            EditorFactory.getInstance().getEditors(document, project).forEach(::applyFoldState)
            return
        }
        before.forEach { it.marker.dispose() }
        document.putUserData(FOLDS, folds.map { InstalledFold(document.createRangeMarker(it.start, it.end), it.placeholder) })

        PsiDocumentManager.getInstance(project).performForCommittedDocument(document) {
            for (editor in EditorFactory.getInstance().getEditors(document, project)) {
                if (editor.isDisposed) continue
                CodeFoldingManager.getInstance(project).updateFoldRegions(editor)
                applyFoldState(editor)
            }
        }
    }

    /** Not during the caret event itself: changing folds moves things the event's other listeners are reading. */
    private fun applyFoldStateLater(editor: Editor) {
        ApplicationManager.getApplication().invokeLater(
            { applyFoldState(editor) },
            ModalityState.stateForComponent(editor.component),
        ) { editor.isDisposed || project.isDisposed }
    }

    private fun applyFoldState(editor: Editor) {
        if (editor.isDisposed) return
        val folds = editor.document.getUserData(FOLDS) ?: return
        val ours = folds.filter { it.marker.isValid }.mapTo(HashSet()) { it.marker.textRange }
        val changes = editor.foldingModel.allFoldRegions
            .filter { TextRange(it.startOffset, it.endOffset) in ours }
            .map { it to touchesCaret(editor, it) }
            .filter { (region, expanded) -> region.isExpanded != expanded }
        if (changes.isEmpty()) return
        editor.foldingModel.runBatchFoldingOperation {
            for ((region, expanded) in changes) region.isExpanded = expanded
        }
    }

    /** Inclusive at both ends: a caret just before or after the key unfolds it too. */
    private fun touchesCaret(editor: Editor, region: FoldRegion): Boolean = editor.caretModel.allCarets.any { caret ->
        caret.offset in region.startOffset..region.endOffset ||
            (caret.hasSelection() && caret.selectionStart <= region.endOffset && caret.selectionEnd >= region.startOffset)
    }

    companion object {
        fun getInstance(project: Project): Ss14LocIdFolds = project.service()
    }
}

/** Hands the folds [Ss14LocIdFolds] holds for a document to the platform; asks nobody. */
class Ss14LocIdFoldingBuilder : FoldingBuilderEx(), DumbAware {
    override fun buildFoldRegions(root: PsiElement, document: Document, quick: Boolean): Array<FoldingDescriptor> {
        val file = root.containingFile?.virtualFile ?: return FoldingDescriptor.EMPTY_ARRAY
        if (!isPrototypeFile(file)) return FoldingDescriptor.EMPTY_ARRAY
        return document.getUserData(FOLDS).orEmpty().mapNotNull { fold ->
            if (!fold.marker.isValid || fold.marker.startOffset >= fold.marker.endOffset) return@mapNotNull null
            val range = fold.marker.textRange
            if (range.endOffset > root.textLength) return@mapNotNull null
            // The value's own leaf: a composite builder tags the node with whose fold it is.
            val node = root.findElementAt(range.startOffset)?.node ?: return@mapNotNull null
            FoldingDescriptor(node, range, null, fold.placeholder, true, emptySet())
        }.toTypedArray()
    }

    override fun getPlaceholderText(node: ASTNode): String = "…"

    override fun isCollapsedByDefault(node: ASTNode): Boolean = true
}

/** Folds follow every prototype editor from the moment it opens. */
class Ss14LocIdEditorListener : EditorFactoryListener {
    override fun editorCreated(event: EditorFactoryEvent) {
        val editor = event.editor
        val project = editor.project ?: return
        val file = FileDocumentManager.getInstance().getFile(editor.document) ?: return
        if (isPrototypeFile(file)) Ss14LocIdFolds.getInstance(project).attach(editor)
    }
}

/** Re-asks every open project's server after the folding setting changed. */
internal fun refreshLocIdFolds() {
    for (project in ProjectManager.getInstance().openProjects) {
        if (!project.isDisposed) Ss14LocIdFolds.getInstance(project).refreshAll()
    }
}

/** VS Code's `SS14: Toggle LocId folding`. */
class ToggleLocIdFoldingAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project?.let(::isSs14Fork) == true
        e.presentation.text = Ss14Bundle.message("action.toggleLocIdFolding.text")
        e.presentation.description = Ss14Bundle.message("action.toggleLocIdFolding.description")
    }

    override fun actionPerformed(e: AnActionEvent) {
        val settings = Ss14Settings.getInstance()
        settings.foldLocIds = !settings.foldLocIds
        refreshLocIdFolds()
    }
}
