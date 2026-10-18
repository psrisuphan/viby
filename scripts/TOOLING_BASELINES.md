# Local quality checks

`npm run check:style` runs Biome 2.5.15 over the project and compares findings
by rule category with `biome-baseline.json`, captured at base commit
`22391a29`. New categories and increases over a category's recorded count fail;
reductions are allowed. This prevents net increases by category, but an old
finding disappearing can offset a new finding in the same category. It does not
identify one-to-one finding changes. `npm run format` applies Biome to the full
source tree and should be reviewed as a separate formatting change.

`npm run check:rust-format` runs stable rustfmt on Rust source, example, and
test files. The five paths in `rustfmt-baseline.txt` have formatting
differences at the base commit and each whole file is skipped until cleaned up;
new formatting differences in those files are not checked. Remove entries as
files are reformatted.

`npm run check:rust-lints` runs Clippy and compares diagnostic counts by lint
against `clippy-baseline.json`, captured at base commit `22391a29` with Clippy
0.1.96. New lints and increases over a lint's recorded count fail; reductions
are allowed. This prevents net increases by lint, but an old finding
disappearing can offset a new finding in the same lint category. It does not
identify one-to-one finding changes. Remove entries as findings are fixed.

CI runs the frontend checks, Rust correctness tests, fmt, and Clippy on every
pull request. Release bundles build on pushes to `main` and on pull requests
when the `release-bundle` label is added, so platform packaging remains
exercised without running the LTO bundle job for every validation update.
