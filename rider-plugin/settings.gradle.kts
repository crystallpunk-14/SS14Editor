plugins {
    // Downloads the JDK the IntelliJ Platform toolchain asks for (21 for Rider 2025.3)
    // when the machine has none — Rider's own runtime is newer.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

rootProject.name = "ss14editor-rider"
