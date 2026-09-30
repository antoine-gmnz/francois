# Cohorte source RPC regressions

From the François repository root, using the sibling checkout's Python environment:

```sh
../cohorte/.venv/bin/python scripts/integration/cohorte-source-rpc.py
```

For another checkout, pass `--cohorte-repo /path/to/cohorte` and use a Python environment with its dependencies installed. Cargo dependencies must already be cached; the script runs Cargo with `--offline`.

The script generates real RPC responses from the selected Cohorte source in temporary storage, then runs exactly three Rust regressions: current-candidate Ship approval, complete freeze review evidence, and oversized export fallback. It does not start a service or provider. Temporary data is deleted on exit; Unix socket transport and provider execution are separate validations.
