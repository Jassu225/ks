# ks-suite

A dependencies-only bundle: installing it installs and enables `ks` and
`ks-flow` from the karmasuite marketplace.

```bash
cd <your KarmaSuite checkout>            # per project, never user-wide
claude plugin marketplace add <path or URL of this repo>
claude plugin install --scope local ks-suite@karmasuite
# then, in Claude: /ks:setup
```

`ks-master` and `ks-browser` are on-demand plugins (`defaultEnabled: false`) and are never
installed: `claude-ks-master` and `claude-ks-test` load them for their own session only, with
`--plugin-dir` from the karmasuite marketplace's copy of the repo (any machine that has the
marketplace has them). An installed copy would block that, so `ks-setup doctor` warns about one. `ks-agent-limit` is disabled and not part of the set.
