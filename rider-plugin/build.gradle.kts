import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.2.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "com.theshued.ss14editor"
version = "0.0.1-spike"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        local(providers.gradleProperty("riderPath"))
        bundledPlugin("org.jetbrains.plugins.yaml")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

intellijPlatform {
    // Rider's bundled JBR has no javac; nothing here needs form/nullability instrumentation.
    instrumentCode = false
    buildSearchableOptions = false
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "253"
        }
    }
}

// The language server is the repo's own esbuild output (`npm run build` and
// `npm run build:schema-cli` at the root), shipped inside the plugin folder as
// `server/dist/*.js` + `server/assets/schema-cli/` — the layout `server.js`
// resolves its defaults against.
val serverDist = rootDir.resolve("../dist")
val schemaCli = rootDir.resolve("../assets/schema-cli")

// `./gradlew runIde -PopenProject=D:/path/to/fork` opens that fork in the sandbox IDE.
tasks.runIde {
    providers.gradleProperty("openProject").orNull?.let { args(it) }
    jvmArgs("-Didea.log.debug.categories=#com.intellij.platform.lsp")
}

tasks.prepareSandbox {
    from(serverDist) {
        include("server.js", "prototype-index-worker.js")
        into(intellijPlatform.projectName.map { "$it/server/dist" })
    }
    from(schemaCli) {
        exclude("*.pdb")
        into(intellijPlatform.projectName.map { "$it/server/assets/schema-cli" })
    }
}
