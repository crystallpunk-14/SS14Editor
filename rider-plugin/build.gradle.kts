import org.apache.tools.ant.taskdefs.condition.Os
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.2.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "com.theshued.ss14editor"
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // A local Rider (`-PriderPath=...`) keeps a dev build off the ~1.5 GB SDK
        // download; without one (CI) the SDK of `riderVersion` is fetched.
        val local = providers.gradleProperty("riderPath").orNull?.takeIf { file(it).isDirectory }
        if (local != null) local(local) else rider(providers.gradleProperty("riderVersion"))
        bundledPlugins("org.jetbrains.plugins.yaml", "JavaScript")
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
        version = project.version.toString()
        ideaVersion {
            sinceBuild = "253"
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
