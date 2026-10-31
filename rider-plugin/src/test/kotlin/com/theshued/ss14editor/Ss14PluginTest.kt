package com.theshued.ss14editor

import com.intellij.codeInsight.editorActions.BackspaceHandlerDelegate
import com.intellij.codeInsight.editorActions.enter.EnterHandlerDelegate
import com.intellij.codeInsight.navigation.actions.GotoDeclarationHandler
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.options.colors.ColorSettingsPage
import com.intellij.platform.lsp.api.LspServerSupportProvider
import com.intellij.testFramework.ApplicationRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.ClassRule
import org.junit.Test

/**
 * Smoke test in a headless IDE application: the plugin loads and every extension
 * it declares is registered under the class that implements it. No project is
 * opened — Rider's test projects need its .NET backend (`SolutionHost`), which a
 * plain platform test cannot start. The server itself is covered by the
 * TypeScript tests (`test/server`), behaviour in Rider by hand.
 */
class Ss14PluginTest {
    companion object {
        @JvmField
        @ClassRule
        val application = ApplicationRule()
    }

    @Test
    fun pluginIsLoaded() {
        assertNotNull(PluginManagerCore.getPlugin(PluginId.getId("com.theshued.ss14editor")))
    }

    @Test
    fun languageServerProviderIsRegistered() {
        assertTrue(LspServerSupportProvider.EP_NAME.extensionList.any { it is Ss14LspServerSupportProvider })
    }

    @Test
    fun editorHandlersAreRegistered() {
        assertTrue(BackspaceHandlerDelegate.EP_NAME.extensionList.any { it is Ss14BackspaceHandler })
        assertTrue(EnterHandlerDelegate.EP_NAME.extensionList.any { it is Ss14EnterHandler })
    }

    @Test
    fun ctrlHoverLinksComeFromOurGotoDeclarationHandler() {
        assertTrue(GotoDeclarationHandler.EP_NAME.extensionList.any { it is Ss14GotoDeclarationHandler })
    }

    @Test
    fun componentNameColourIsConfigurableAndDefaultsToAClassName() {
        val page = ColorSettingsPage.EP_NAME.extensionList.single { it is Ss14ColorSettingsPage }
        assertTrue(page.attributeDescriptors.any { it.key == SS14_COMPONENT_NAME })
        assertEquals(DefaultLanguageHighlighterColors.CLASS_NAME, SS14_COMPONENT_NAME.fallbackAttributeKey)
    }

    @Test
    fun rebuildActionsAreRegistered() {
        val actions = ActionManager.getInstance()
        assertTrue(actions.getAction("Ss14Editor.RebuildSchema") is RebuildSchemaAction)
        assertTrue(actions.getAction("Ss14Editor.RebuildPrototypeIndex") is RebuildPrototypeIndexAction)
    }
}

/** The filter that decides which files reach the language server — no IDE needed. */
class PrototypePathTest {
    @Test
    fun yamlUnderResourcesPrototypesIsAPrototypeFile() {
        assertTrue(isPrototypePath("D:/fork/Resources/Prototypes/Entities/items.yml"))
        assertTrue(isPrototypePath("/home/me/fork/Resources/Prototypes/Recipes/food.yaml"))
    }

    @Test
    fun anythingElseIsNot() {
        assertFalse(isPrototypePath("D:/fork/Resources/Prototypes/readme.txt"))
        assertFalse(isPrototypePath("D:/fork/Resources/Maps/station.yml"))
        assertFalse(isPrototypePath("D:/fork/Content.Server/Prototypes.yml"))
    }
}
