# Python Cohorte service in François

François's Cohorte screens use the local `cohorte/1` service. Install the Python
Cohorte CLI and make it available as `cohorte` on François's process `PATH`.
If an older TypeScript CLI has that name, set `COHORTE_PYTHON_CLI` to the
absolute path of the Python executable before launching François.

For an isolated qualification run, set `COHORTE_PYTHON_DATA_DIR` to a temporary
directory. François starts the persistent service when needed, performs the
`initialize` handshake, then uses JSON-RPC over the service's Unix socket or
Windows named pipe. It reads registered projects, features, runs, requests and
events; decisions and run controls go through the same protocol. A live event
subscription resumes from the last received sequence after a disconnect.

The existing UI can register a project, choose a feature, create a run, inspect
its activity, answer a question, approve or deny a request, and pause, resume
or cancel a run. `runs.start` creates a queued run; execution itself remains
owned by Cohorte. François does not launch workflow workers. The old TypeScript
CLI-backed Tauri handlers remain compiled for compatibility but are no longer
called by the Cohorte screens.

The Brainstorm sheet runs the Python CLI in JSON mode against the same data
directory and registered project. It displays the saved perspectives, objections,
previous project decisions and synthesis. A free-form message uses `--message`
and remains a question or objection; the separate confirm action uses `--answer`
and records a decision. Reopening a brainstorm loads its latest saved brief with
`brief show`. Install `cohorte-engine==1.0.0a20` or later for `brainstorm --message`.
The Spec sheet uses `cohorte-engine==1.0.0a21` or later. It loads the saved brief,
asks the agent for an initial spec proposal, and lets the user send free-form
feedback for a new revision. Feedback never counts as an approved answer. The
user accepts a specific proposal revision and supplies decisions for its open
questions; this creates a saved draft. The approval view shows the full frozen
candidate and project profile with their exact hashes. A separate confirmed
action approves and freezes only that request ID and those hashes. After freeze,
the user may explicitly keep a proposed standing decision for future features.
