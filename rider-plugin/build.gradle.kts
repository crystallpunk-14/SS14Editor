import org.apache.tools.ant.taskdefs.condition.Os
import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.2.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "com.theshued.ss14editor"
version = providers.gradleProperty("pluginVersion").get()

/** A complete local Rider install named by gradle property `name`, or `null`. */
fun localRider(name: String): String? =
    providers.gradleProperty(name).orNull?.takeIf { it.isNotBlank() && file(it).resolve("product-info.json").isFile }

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // The oldest supported Rider (gradle.properties): a local install of it
        // when `riderPath` names one, else its SDK — from the IntelliJ Maven
        // repository rather than download.jetbrains.com, which answers 451 in
        // some regions.
        val local = localRider("riderPath")
        if (local != null) {
            local(local)
        } else {
            rider(providers.gradleProperty("riderVersion")) { useInstaller = false }
            // The Maven SDK carries no runtime; take the JetBrains Runtime it was built for.
            jetbrainsRuntime()
        }
        bundledPlugins("org.jetbrains.plugins.yaml", "JavaScript")
        testFramework(TestFrameworkType.Platform)
    }
    testImplementation("junit:junit:4.13.2")
    // The platform test framework expects it on the classpath and does not bring it.
    testImplementation("org.opentest4j:opentest4j:1.3.0")
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
        version = project.version.toString()
        ideaVersion {
            sinceBuild = "253"
        }
    }
    // `./gradlew publishPlugin` (docs/publishing-rider.md): the Marketplace token and,
    // optionally, the signing certificate come from the environment only — never
    // from a file in the repo. Without a certificate `signPlugin` is skipped and
    // the IDE warns about an unsigned plugin on install.
    publishing {
        token = providers.environmentVariable("PUBLISH_TOKEN")
    }
    signing {
        certificateChain = providers.environmentVariable("CERTIFICATE_CHAIN")
        privateKey = providers.environmentVariable("PRIVATE_KEY")
        password = providers.environmentVariable("PRIVATE_KEY_PASSWORD")
    }
    // `./gradlew verifyPlugin`: the Plugin Verifier against the Rider it was built
    // for — the same check JetBrains Marketplace runs on upload.
    pluginVerification {
        ides {
            // The oldest and the newest supported Rider.
            val oldest = localRider("riderPath")
            if (oldest != null) local(oldest)
            else create(IntelliJPlatformType.Rider, providers.gradleProperty("riderVersion")) { useInstaller = false }
            val newest = localRider("riderLatestPath")
            if (newest != null) local(newest)
            else create(IntelliJPlatformType.Rider, providers.gradleProperty("riderLatestVersion")) { useInstaller = false }
        }
    }
}

// The language server is the repo's own build output, shipped inside the plugin
// folder as `server/dist/*.js` + `server/assets/schema-cli/` — the layout
// `server.js` resolves its defaults against. Both are built from here, so
// `./gradlew buildPlugin` alone yields a complete plugin.
val repoRoot = rootDir.resolve("..")
val serverDist = repoRoot.resolve("dist")
val schemaCli = repoRoot.resolve("assets/schema-cli")

/** `npm run build` at the repo root: the server and the index worker bundles. */
val buildServer by tasks.registering(Exec::class) {
    workingDir = repoRoot
    commandLine(if (Os.isFamily(Os.FAMILY_WINDOWS)) "npm.cmd" else "npm", "run", "build")
    inputs.dir(repoRoot.resolve("src"))
    inputs.files(repoRoot.resolve("package.json"), repoRoot.resolve("package-lock.json"), repoRoot.resolve("esbuild.mjs"))
    outputs.files(serverDist.resolve("server.js"), serverDist.resolve("prototype-index-worker.js"))
}

/** The schema-extractor CLI, framework-dependent like the VS Code extension's copy. */
val buildSchemaCli by tasks.registering(Exec::class) {
    workingDir = repoRoot
    commandLine("dotnet", "publish", "schema-cli/SS14Editor.SchemaCli.csproj", "-c", "Release", "-o", schemaCli.path)
    inputs.files(fileTree(repoRoot.resolve("schema-cli")) { include("*.cs", "*.csproj", "vendor/**") })
    outputs.dir(schemaCli)
}

// `./gradlew runIde -PopenProject=D:/path/to/fork` opens that fork in the sandbox IDE.
tasks.runIde {
    providers.gradleProperty("openProject").orNull?.let { args(it) }
    jvmArgs("-Didea.log.debug.categories=#com.intellij.platform.lsp")
}

tasks.prepareSandbox {
    dependsOn(buildServer, buildSchemaCli)
    from(serverDist) {
        include("server.js", "prototype-index-worker.js")
        into(intellijPlatform.projectName.map { "$it/server/dist" })
    }
    from(schemaCli) {
        exclude("*.pdb")
        into(intellijPlatform.projectName.map { "$it/server/assets/schema-cli" })
    }
}
