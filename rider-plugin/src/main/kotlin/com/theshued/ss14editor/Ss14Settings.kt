package com.theshued.ss14editor

import com.intellij.DynamicBundle
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.ui.DialogPanel
import com.intellij.platform.lsp.api.LspServerManager
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import com.intellij.ui.dsl.listCellRenderer.textListCellRenderer
import org.jetbrains.annotations.PropertyKey
import java.text.MessageFormat
import java.util.Locale
import java.util.ResourceBundle

/** The plugin's languages; [AUTO] follows the IDE's own (a language pack), English otherwise. */
enum class Ss14Language {
    AUTO,
    EN,
    RU,
}

/** Application-wide settings of the plugin, stored in `ss14editor.xml`. */
@Service(Service.Level.APP)
@State(name = "Ss14EditorSettings", storages = [Storage("ss14editor.xml")])
class Ss14Settings : PersistentStateComponent<Ss14Settings.State> {
    class State {
        var language: Ss14Language = Ss14Language.AUTO
        var displayLocale: String = DEFAULT_DISPLAY_LOCALE
        var foldLocIds: Boolean = true
    }

    private var state = State()

    override fun getState(): State = state

    override fun loadState(loaded: State) {
        state = loaded
    }

    var language: Ss14Language
        get() = state.language
        set(value) {
            state.language = value
        }

    /** The `Resources/Locale/` folder LocId keys fold into and are listed first in. */
    var displayLocale: String
        get() = state.displayLocale.trim().ifEmpty { DEFAULT_DISPLAY_LOCALE }
        set(value) {
            state.displayLocale = value
        }

    /** Whether LocId keys in prototypes show as their translation. */
    var foldLocIds: Boolean
        get() = state.foldLocIds
        set(value) {
            state.foldLocIds = value
        }

    /** The language in effect: the chosen one, or — for [Ss14Language.AUTO] — the IDE's when it is one we have. */
    val effectiveLanguage: Ss14Language
        get() = when (language) {
            Ss14Language.AUTO -> if (DynamicBundle.getLocale().language == "ru") Ss14Language.RU else Ss14Language.EN
            else -> language
        }

    companion object {
        private const val DEFAULT_DISPLAY_LOCALE = "en-US"

        fun getInstance(): Ss14Settings = service()
    }
}

private const val BUNDLE = "messages.Ss14Bundle"

/**
 * The plugin's texts in the language of [Ss14Settings], not the IDE's: a
 * `DynamicBundle` would follow only the IDE language pack, and the point of the
 * setting is to choose independently of it.
 */
object Ss14Bundle {
    /** Base bundle only for English: never the JVM's default locale as a fallback. */
    private val control = ResourceBundle.Control.getNoFallbackControl(ResourceBundle.Control.FORMAT_PROPERTIES)

    fun message(@PropertyKey(resourceBundle = BUNDLE) key: String, vararg params: Any): String {
        val locale = when (Ss14Settings.getInstance().effectiveLanguage) {
            Ss14Language.RU -> Locale.of("ru")
            else -> Locale.ROOT
        }
        val bundle = ResourceBundle.getBundle(BUNDLE, locale, Ss14Bundle::class.java.classLoader, control)
        val pattern = bundle.getString(key)
        return if (params.isEmpty()) pattern else MessageFormat(pattern, locale).format(params)
    }
}

/**
 * Settings | Tools | SS14 Prototype Editor. Changing the language or the display
 * locale restarts the running language servers, which take them at start-up
 * (`initializationOptions`).
 */
class Ss14Configurable : BoundConfigurable("SS14 Prototype Editor") {
    override fun createPanel(): DialogPanel {
        val settings = Ss14Settings.getInstance()
        return panel {
            row(Ss14Bundle.message("settings.language")) {
                comboBox(
                    Ss14Language.entries,
                    textListCellRenderer { language ->
                        when (language) {
                            Ss14Language.AUTO -> Ss14Bundle.message("settings.language.auto")
                            Ss14Language.EN -> "English"
                            Ss14Language.RU -> "Русский"
                            null -> ""
                        }
                    },
                ).bindItem({ settings.language }, { settings.language = it ?: Ss14Language.AUTO })
                    .comment(Ss14Bundle.message("settings.language.comment"))
            }
            row(Ss14Bundle.message("settings.displayLocale")) {
                textField().bindText({ settings.displayLocale }, { settings.displayLocale = it })
                    .comment(Ss14Bundle.message("settings.displayLocale.comment"))
            }
            row {
                checkBox(Ss14Bundle.message("settings.foldLocIds"))
                    .bindSelected({ settings.foldLocIds }, { settings.foldLocIds = it })
                    .comment(Ss14Bundle.message("settings.foldLocIds.comment"))
            }
        }
    }

    override fun apply() {
        val settings = Ss14Settings.getInstance()
        val before = settings.effectiveLanguage to settings.displayLocale
        val foldedBefore = settings.foldLocIds
        super.apply()
        if (settings.foldLocIds != foldedBefore) refreshLocIdFolds()
        if ((settings.effectiveLanguage to settings.displayLocale) == before) return
        for (project in ProjectManager.getInstance().openProjects) {
            if (project.isDisposed) continue
            LspServerManager.getInstance(project).stopAndRestartIfNeeded(Ss14LspServerSupportProvider::class.java)
        }
    }
}
