package com.theshued.ss14editor

import com.intellij.lang.Language
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.fileTypes.PlainSyntaxHighlighter
import com.intellij.openapi.fileTypes.SyntaxHighlighter
import com.intellij.openapi.fileTypes.SyntaxHighlighterFactory
import com.intellij.openapi.options.colors.AttributesDescriptor
import com.intellij.openapi.options.colors.ColorDescriptor
import com.intellij.openapi.options.colors.ColorSettingsPage
import com.intellij.platform.lsp.api.customization.LspSemanticTokensSupport
import com.intellij.psi.PsiFile
import javax.swing.Icon

/** The server's semantic token type for a component name (`src/server/server.ts`). */
private const val COMPONENT_TOKEN = "ss14Component"

/** Colour of a component name; by default a class name's, since a component is one. */
val SS14_COMPONENT_NAME: TextAttributesKey =
    TextAttributesKey.createTextAttributesKey("SS14_COMPONENT_NAME", DefaultLanguageHighlighterColors.CLASS_NAME)

/** Maps the server's component-name tokens onto [SS14_COMPONENT_NAME]; everything else as the platform does. */
class Ss14SemanticTokensSupport : LspSemanticTokensSupport() {
    /**
     * The platform asks only for files of a language it has no highlighter of
     * its own for; YAML has one, so prototype files have to be asked for here.
     */
    override fun shouldAskServerForSemanticTokens(psiFile: PsiFile): Boolean =
        psiFile.virtualFile?.let(::isPrototypeFile) == true

    override val tokenTypes: List<String>
        get() = super.tokenTypes + COMPONENT_TOKEN

    override fun getTextAttributesKey(tokenType: String, modifiers: List<String>): TextAttributesKey? =
        if (tokenType == COMPONENT_TOKEN) SS14_COMPONENT_NAME else super.getTextAttributesKey(tokenType, modifiers)
}

/** Settings | Editor | Color Scheme | SS14 Prototypes: the component-name colour, on a sample prototype. */
class Ss14ColorSettingsPage : ColorSettingsPage {
    override fun getDisplayName(): String = "SS14 Prototypes"

    override fun getIcon(): Icon? = null

    override fun getHighlighter(): SyntaxHighlighter =
        Language.findLanguageByID("yaml")
            ?.let { SyntaxHighlighterFactory.getSyntaxHighlighter(it, null, null) }
            ?: PlainSyntaxHighlighter()

    override fun getDemoText(): String = """
        - type: entity
          parent: BaseItem
          id: FireAxe
          components:
          - type: <component>Sprite</component>
            sprite: Objects/Weapons/Melee/fireaxe.rsi
          - type: <component>Item</component>
            size: Large
          - type: <component>MeleeWeapon</component>
            damage:
              types:
                Slash: 10
    """.trimIndent()

    override fun getAdditionalHighlightingTagToDescriptorMap(): Map<String, TextAttributesKey> =
        mapOf("component" to SS14_COMPONENT_NAME)

    override fun getAttributeDescriptors(): Array<AttributesDescriptor> =
        arrayOf(AttributesDescriptor(Ss14Bundle.message("colors.componentName"), SS14_COMPONENT_NAME))

    override fun getColorDescriptors(): Array<ColorDescriptor> = ColorDescriptor.EMPTY_ARRAY
}
