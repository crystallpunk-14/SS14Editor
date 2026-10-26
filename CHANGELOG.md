# Changelog

## 1.0.0

First release.

- Completion of component names, fields of components, data definitions and
  prototypes, enum and flag values, prototype types and `!type:` classes.
- Completion of prototype ids in `parent:` and prototype references, filtered
  by prototype kind, including engine prototypes.
- Completion of resource paths under `Resources/`.
- Hover with C# docs, type and default value for components, fields and
  `!type:` tags.
- Go to definition from prototype ids to their YAML declaration, and from
  component names and `!type:` tags to their C# class.
- Schema rebuilt automatically after the fork is rebuilt; prototype index
  updated on save.
- Status and error reasons in the **SS14 Editor** Output channel.
- Commands: **SS14: Rebuild schema**, **SS14: Rebuild prototype index**.
