# Data Model: Organize Repository Structure

**Feature**: 006-organize-repo-structure
**Date**: 2026-03-21

## Not Applicable

This feature is a repository structural reorganization. It does not introduce, modify, or remove any data entities, schemas, or state transitions. All data models (WebAuthn credentials, push subscriptions, sensor readings, etc.) remain unchanged — only the file paths to the code that manages them are updated.

The key "entities" for this feature are documented in the spec:
- **Logical Unit**: A directory grouping (shelly, playground, monitor, deploy, design, tests)
- **Cross-Reference**: A file path that must be updated when files move

These are organizational concepts, not data model entities.
