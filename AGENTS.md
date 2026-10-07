# PaperMind

Build a local-first browser document application for AI-assisted learning. Chinese UI. Tiptap editor, React/TypeScript, Node.js/SQLite, Pi agent/model libraries. Do not substitute Codex CLI/App Server for the primary Pi document agent.

Core acceptance: AI creates a real document; user edits and highlights; selection starts an anchored discussion; follow-up retains that discussion; the explicit discussion-writeback action saves once without a second confirmation; writing checks revision and exact anchor; undo and restart preserve content and discussion. Distinguish fixture tests from real model calls. No simulated model answers in production.

Secrets stay server-side. Do not log auth tokens, read user source corpora, publish repositories or push without authorization. Persist product data outside source control. Bind the local server to loopback and enforce same-origin/session protection.

This project is newly authorized. UI details can be decided pragmatically; keep a calm reading-first design with document outline and contextual AI discussion. GitHub synchronization and external article import follow core correctness.


Current workflow: external Codex / Agents generate notes; PaperMind is the reading and contextual discussion surface. Use the CLI protocol in docs/AGENT-HANDOFF.md for document delivery. Do not overwrite existing notes from an old source file: read the current note and revision first. Keep the global document library separate from the per-article stroke outline and per-article comments. GitHub pull preserves conflicting local copies; actual repository acceptance still requires a user-selected target.
