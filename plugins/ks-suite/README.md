# ks-suite

A dependencies-only bundle: installing it installs and enables `ks` and
`ks-flow` from the karmasuite marketplace.

```bash
cd <your KarmaSuite checkout>            # per project, never user-wide
claude plugin marketplace add <path or URL of this repo>
claude plugin install --scope local ks-suite@karmasuite
# then, in Claude: /ks:setup
```

`ks-master` and `ks-browser` are on-demand plugins (`defaultEnabled: false`):
install them the same way (`claude plugin install --scope local ks-master@karmasuite` /
`ks-browser@karmasuite`, in the checkout); `claude-ks-master` and `claude-ks-test` turn them on for
their own session only. `ks-agent-limit` is disabled and not part of the set.
