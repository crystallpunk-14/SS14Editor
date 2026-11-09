package com.theshued.ss14editor

import com.intellij.openapi.options.Configurable
import com.intellij.testFramework.ApplicationRule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.ClassRule
import org.junit.Test
import java.util.Properties

/** The two bundles carry the same keys: a key missing from one shows up as an exception in the IDE. */
class Ss14BundleKeysTest {
    private fun keysOf(resource: String): Set<String> {
        val properties = Properties()
        Ss14BundleKeysTest::class.java.classLoader.getResourceAsStream(resource)!!.reader(Charsets.UTF_8).use(properties::load)
        return properties.stringPropertyNames()
    }

    @Test
    fun russianHasExactlyTheEnglishKeys() {
        assertEquals(keysOf("messages/Ss14Bundle.properties"), keysOf("messages/Ss14Bundle_ru.properties"))
    }
}

/** The language setting drives the plugin's own texts. */
class Ss14LocalizationTest {
    companion object {
        @JvmField
        @ClassRule
        val application = ApplicationRule()
    }

    private val settings get() = Ss14Settings.getInstance()

    @After
    fun reset() {
        settings.language = Ss14Language.AUTO
    }

    @Test
    fun englishAndRussianAreChosenBySetting() {
        settings.language = Ss14Language.EN
        assertEquals("SS14: Rebuild Schema", Ss14Bundle.message("action.rebuildSchema.text"))
        settings.language = Ss14Language.RU
        assertEquals("SS14: Пересобрать схему", Ss14Bundle.message("action.rebuildSchema.text"))
    }

    @Test
    fun parametersAreFilledIn() {
        settings.language = Ss14Language.RU
        assertTrue(Ss14Bundle.message("notification.nodeMissing.content", 18).contains("Node.js 18 или новее"))
    }

    @Test
    fun autoFollowsTheIdeWhichIsEnglishHere() {
        settings.language = Ss14Language.AUTO
        assertEquals(Ss14Language.EN, settings.effectiveLanguage)
    }

    @Test
    fun settingsPageIsRegisteredUnderTools() {
        val page = Configurable.APPLICATION_CONFIGURABLE.extensionList.single { it.id == "com.theshued.ss14editor.settings" }
        assertEquals("tools", page.parentId)
    }
}
