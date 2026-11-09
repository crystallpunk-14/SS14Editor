using System.IO;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace Content.Editor.Tests;

using Content.Editor.Editor;

/// <summary>
/// End-to-end: stage the test DLL (which contains fixture types with attribute
/// names matching SS14 conventions) as if it were a built Content.Server DLL,
/// then run <see cref="MetadataExtractor.Extract"/> and verify the produced
/// metadata.json.
/// </summary>
public class MetadataExtractorTests
{
    private static TempDir StageFixtureAsContentServer()
    {
        var tmp = new TempDir();
        var binServer = Path.Combine(tmp.Path, "bin", "Content.Server");
        Directory.CreateDirectory(binServer);

        // Copy the test DLL plus its alongside dependencies (xunit, fixtures all
        // ship in the same assembly so a single copy suffices).
        var testDll = typeof(MetadataExtractorTests).Assembly.Location;
        var srcDir = Path.GetDirectoryName(testDll)!;
        foreach (var dll in Directory.GetFiles(srcDir, "*.dll"))
            File.Copy(dll, Path.Combine(binServer, Path.GetFileName(dll)), overwrite: true);
        return tmp;
    }

    private static JsonDocument RunAndRead(string root)
    {
        var outputDir = Path.Combine(root, "Redactor");
        MetadataExtractor.Extract(root, outputDir);
        var metaPath = Path.Combine(outputDir, "metadata.json");
        Assert.True(File.Exists(metaPath), "metadata.json not written");
        return JsonDocument.Parse(File.ReadAllText(metaPath));
    }

    [Fact]
    public void Extract_WritesMetadataJson()
    {
        using var tmp = StageFixtureAsContentServer();
        using var doc = RunAndRead(tmp.Path);
        Assert.True(doc.RootElement.TryGetProperty("prototypes", out _));
        Assert.True(doc.RootElement.TryGetProperty("components", out _));
        Assert.True(doc.RootElement.TryGetProperty("dataDefinitions", out _));
    }

    [Fact]
    public void Extract_FindsFixturePrototypes()
    {
        using var tmp = StageFixtureAsContentServer();
        using var doc = RunAndRead(tmp.Path);
        var protos = doc.RootElement.GetProperty("prototypes");
        Assert.True(protos.TryGetProperty("fixtureEntity", out var fe));
        Assert.True(fe.GetProperty("inheriting").GetBoolean());
        Assert.True(protos.TryGetProperty("fixtureSimple", out var fs));
        Assert.False(fs.GetProperty("inheriting").GetBoolean());
    }

    [Fact]
    public void Extract_FindsFixtureComponent()
    {
        using var tmp = StageFixtureAsContentServer();
        using var doc = RunAndRead(tmp.Path);
        var comps = doc.RootElement.GetProperty("components");
        // RegisterComponentAttribute on FixtureLightComponent → name "FixtureLight"
        // (trailing "Component" suffix stripped by InferComponentName).
        Assert.True(comps.TryGetProperty("FixtureLight", out var light));
        var fields = light.GetProperty("fields").EnumerateArray().ToList();
        Assert.Contains(fields, f => f.GetProperty("name").GetString() == "Radius");
        Assert.Contains(fields, f => f.GetProperty("name").GetString() == "Sprite");
    }

    [Fact]
    public void Extract_FindsDataDefinitions()
    {
        using var tmp = StageFixtureAsContentServer();
        using var doc = RunAndRead(tmp.Path);
        var dds = doc.RootElement.GetProperty("dataDefinitions");
        // Match by ShortName (key is fullName which depends on namespace).
        bool found = false;
        foreach (var kv in dds.EnumerateObject())
        {
            if (kv.Value.GetProperty("shortName").GetString() == "FixtureDataDef") { found = true; break; }
        }
        Assert.True(found, "FixtureDataDef should be registered as a data definition");
    }

    [Fact]
    public void Extract_PolymorphicTypes_LinkAbstractToConcrete()
    {
        using var tmp = StageFixtureAsContentServer();
        using var doc = RunAndRead(tmp.Path);
        var poly = doc.RootElement.GetProperty("polymorphicTypes");
        // FixtureBaseEffect → [FixtureConcreteEffect]
        bool found = false;
        foreach (var kv in poly.EnumerateObject())
        {
            if (kv.Name.EndsWith("FixtureBaseEffect"))
            {
                var impls = kv.Value.EnumerateArray().Select(e => e.GetString()!).ToList();
                if (impls.Any(s => s.EndsWith("FixtureConcreteEffect"))) { found = true; break; }
            }
        }
        Assert.True(found, "polymorphic mapping FixtureBaseEffect → FixtureConcreteEffect missing");
    }

    [Fact]
    public void Extract_NoBinDirs_NoOp()
    {
        using var tmp = new TempDir();
        var outputDir = Path.Combine(tmp.Path, "Redactor");
        MetadataExtractor.Extract(tmp.Path, outputDir);
        var metaPath = Path.Combine(outputDir, "metadata.json");
        Assert.False(File.Exists(metaPath));
    }

    /// <summary>
    /// Verifies that FlagSerializer&lt;TTag&gt; fields are resolved to "flags" kind
    /// when the corresponding [FlagsFor(typeof(TTag))] enum is present in the
    /// same assembly — the exact pattern used by Fixture.CollisionLayer/Mask
    /// in RobustToolbox.
    /// </summary>
    [Fact]
    public void Extract_FlagSerializer_ResolvesEnumValues()
    {
        using var tmp = StageFixtureAsContentServer();
        using var doc = RunAndRead(tmp.Path);

        var dds = doc.RootElement.GetProperty("dataDefinitions");

        // Find FixturePhysicsData by shortName (key is fully-qualified name).
        JsonElement? physDD = null;
        foreach (var kv in dds.EnumerateObject())
        {
            if (kv.Value.GetProperty("shortName").GetString() == "FixturePhysicsData")
            {
                physDD = kv.Value;
                break;
            }
        }
        Assert.True(physDD.HasValue, "FixturePhysicsData data definition not found in metadata");

        var fields = physDD.Value.GetProperty("fields").EnumerateArray().ToList();
        var root = doc.RootElement;

        // Helper: resolve enum values from either inline enumValues or via enumRef -> root.enums
        System.Collections.Generic.List<string> ResolveEnumVals(JsonElement field)
        {
            if (field.TryGetProperty("enumValues", out var inline))
                return inline.EnumerateArray().Select(e => e.GetString()!).ToList();
            var enumRef = field.GetProperty("enumRef").GetString()!;
            return root.GetProperty("enums").GetProperty(enumRef)
                       .EnumerateArray().Select(e => e.GetString()!).ToList();
        }

        // --- layer field ---
        var layerField = fields.Single(f => f.GetProperty("tag").GetString() == "layer");
        Assert.Equal("flags", layerField.GetProperty("fieldKind").GetString());

        var layerEnumVals = ResolveEnumVals(layerField);
        Assert.Contains("WallLayer", layerEnumVals);
        Assert.Contains("MobLayer", layerEnumVals);
        Assert.Contains("FullTileMask", layerEnumVals);

        // --- mask field ---
        var maskField = fields.Single(f => f.GetProperty("tag").GetString() == "mask");
        Assert.Equal("flags", maskField.GetProperty("fieldKind").GetString());

        var maskEnumVals = ResolveEnumVals(maskField);
        Assert.Contains("WallLayer", maskEnumVals);
        Assert.Contains("MobLayer", maskEnumVals);
    }

    /// <summary>
    /// Two <c>FlagSerializer</c> fields over <c>int</c> with different flags
    /// enums must not share one value list: the enum table used to key them
    /// both by <c>System.Int32</c>, so every flags field after the first
    /// pointed at the first one's values.
    /// </summary>
    [Fact]
    public void Extract_FlagSerializer_DistinctEnumsOnIntFields_KeepTheirOwnValues()
    {
        using var tmp = StageFixtureAsContentServer();
        using var doc = RunAndRead(tmp.Path);
        var root = doc.RootElement;

        System.Collections.Generic.List<string> ValuesOf(string definition, string tag)
        {
            var dd = root.GetProperty("dataDefinitions").EnumerateObject()
                .Single(kv => kv.Value.GetProperty("shortName").GetString() == definition).Value;
            var field = dd.GetProperty("fields").EnumerateArray()
                .Single(f => f.GetProperty("tag").GetString() == tag);
            if (field.TryGetProperty("enumValues", out var inline) && inline.ValueKind == JsonValueKind.Array)
                return inline.EnumerateArray().Select(e => e.GetString()!).ToList();
            var enumRef = field.GetProperty("enumRef").GetString()!;
            return root.GetProperty("enums").GetProperty(enumRef).EnumerateArray().Select(e => e.GetString()!).ToList();
        }

        var layer = ValuesOf("FixturePhysicsData", "layer");
        var ammo = ValuesOf("FixtureAmmoData", "flags");
        Assert.Contains("WallLayer", layer);
        Assert.DoesNotContain("ChangeFireCost", layer);
        Assert.Contains("ChangeFireCost", ammo);
        Assert.DoesNotContain("WallLayer", ammo);
    }

    /// <summary>
    /// <c>[ComponentProtoName]</c> names the component in YAML, as the engine's
    /// component factory registers it — not the class name minus <c>Component</c>.
    /// </summary>
    [Fact]
    public void Extract_ComponentProtoName_OverridesTheClassName()
    {
        using var tmp = StageFixtureAsContentServer();
        using var doc = RunAndRead(tmp.Path);
        var components = doc.RootElement.GetProperty("components");
        Assert.True(components.TryGetProperty("FixtureRenamed", out _));
        Assert.False(components.TryGetProperty("FixtureContainerManager", out _));
        // Inherited, as Attribute.GetCustomAttribute reads it: the subclass
        // registers under the same name, so it never shows up on its own.
        Assert.False(components.TryGetProperty("FixtureDerivedContainerManager", out _));
    }

    /// <summary>
    /// Verifies that <c>[ConstantsFor(typeof(TTag))]</c> enums are surfaced
    /// under <c>MetadataRoot.EnumConstants</c> keyed by the tag type's full
    /// name. Members from multiple enums sharing the same tag must merge
    /// into one ascending-by-value list — this is the input the Sprite
    /// component handler reads to render <c>drawdepth</c> as a dropdown
    /// instead of a plain int.
    /// </summary>
    [Fact]
    public void Extract_ConstantsFor_AggregatesNamedConstants()
    {
        using var tmp = StageFixtureAsContentServer();
        using var doc = RunAndRead(tmp.Path);

        var enums = doc.RootElement.GetProperty("enumConstants");

        // Tag key is the FullName of FixtureDrawDepthTag.
        string? tagKey = null;
        foreach (var kv in enums.EnumerateObject())
        {
            if (kv.Name.EndsWith("FixtureDrawDepthTag")) { tagKey = kv.Name; break; }
        }
        Assert.NotNull(tagKey);

        var entries = enums.GetProperty(tagKey!).EnumerateArray()
            .Select(e => (e.GetProperty("name").GetString()!, e.GetProperty("value").GetInt64()))
            .ToList();

        // Both enums' members must appear, sorted ascending by value.
        Assert.Equal(("BelowFloor", -10L), entries[0]);
        Assert.Equal(("Default",      0L), entries[1]);
        Assert.Equal(("Mobs",         6L), entries[2]);
        Assert.Equal(("Overlay",    100L), entries[3]);
    }
}
