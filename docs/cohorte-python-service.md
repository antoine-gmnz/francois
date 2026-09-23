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
