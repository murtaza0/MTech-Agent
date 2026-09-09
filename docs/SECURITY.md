# Security model

The API applies project-root path resolution to reads, writes, downloads, ZIP
creation, and command cwd. Absolute paths, null bytes, and traversal outside
the project are rejected.

The command runner uses an executable allowlist, argument arrays, no shell,
bounded output, and a timeout. LLM responses are planning data and cannot
execute commands directly.

The security task scans the real workspace for environment files, common
credential formats, `eval`, and shell execution patterns. Findings include
severity, file, line, description, and recommendation. This is a review
pipeline, not a substitute for deployment-specific threat modeling.