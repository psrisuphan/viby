# Local quality checks

`npm run check:style` runs Biome 2.5.15 over the project and compares findings
by rule category with `biome-baseline.json`, captured at base commit
`22391a29`. New categories and increases over a category's recorded count fail;
reductions are allowed. This keeps existing lint and formatting debt visible
without reformatting active remediation work. `npm run format` applies Biome to
the full source tree and should be reviewed as a separate formatting change.

`npm run check:rust-format` runs stable rustfmt on Rust source, example, and
test files. The five paths in `rustfmt-baseline.txt` have formatting
differences at the base commit and are skipped until cleaned up. Remove entries
as files are reformatted.

`npm run check:rust-lints` runs Clippy and compares diagnostic counts by lint
against `clippy-baseline.json`, captured at base commit `22391a29` with Clippy
0.1.96. New lints and increases over a lint's recorded count fail; reductions
are allowed. This records existing Clippy debt without suppressing new findings
in those lint categories. Remove entries as the findings are fixed.

CI runs the frontend checks, Rust correctness tests, fmt, and Clippy on every
pull request. Release bundles build on pushes to `main` and on pull requests
with the `release-bundle` label so platform packaging remains exercised without
running the LTO bundle job for every validation update.
