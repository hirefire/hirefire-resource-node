# Tools

Checks that go beyond the test suite. The suite shows that the code does what the tests say. These tools show whether the tests would catch a mistake, and how the client behaves when the server or the host misbehaves. Nothing here ships: `package.json` packs `src/`, `types/`, and three documents only.

Run every script from the repository root with the first Node.js of `.tool-versions`, after `bin/setup` and `tools/bin/services up`. They are not part of `npm run check` or CI, because the mutation run and the soak take long.

| Path                    | Holds                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/services`          | Starts the test services with one Redis per slot, and a Redis with TLS for one evidence script                                        |
| `bin/sandbox`           | Copies the tree to a throwaway directory. `bin/cell-sandbox` also installs the packages of a cell                                     |
| `bin/matrix-run`        | Runs every cell through `bin/run-cell`, with coverage or in random order with a seed                                                  |
| `bin/matrix-repeat`     | Runs the matrix several times, each with its own seed                                                                                 |
| `bin/rerun-alone`       | Runs one test of one cell alone, or its file with a seed                                                                              |
| `bin/rerun-failed`      | Runs every test that failed in a seeded matrix run again alone, and its cell again with the seed                                      |
| `bin/coverage-report`   | Merges line and branch coverage of all cells per file                                                                                 |
| `bin/mutate`            | Changes `src/` one small step at a time and runs the cells that cover the changed line                                                |
| `bin/mutation-verdicts` | Reports the score per file and fails on a surviving change without a verdict (`lib/mutation/rules.js`)                                |
| `bin/fault-run`         | Runs the client against a local server that misbehaves in 21 ways. `bin/fault-compare` prints two results side by side                |
| `bin/soak`              | Runs a `cluster` app for a long time with faults and worker restarts                                                                  |
| `bin/host-run`          | Boots the packed tarball in a Linux container under each framework, `cluster`, PM2, `worker_threads`, and Next.js                     |
| `bin/long-runs`         | Runs the matrix, the reruns, the mutation run, the soak, and the hosts in order, and writes each exit code to `results/long-runs.txt` |
| `bin/public-api`        | Writes the names the code exports and the type files declare, or checks them with `--check`                                           |
| `bin/wire-goldens`      | Captures the ingest and lease requests, or checks them with `--check`. `bin/wire-compare` compares them with Ruby                     |
| `baseline/`             | The golden copies of the public names and the wire requests, with the Ruby wire requests beside them                                  |
| `evidence/`             | One script per finding or check of the audit. Each prints what it saw and exits 0 when its claim holds                                |
| `lib/net_guard.js`      | Loaded into every Jest run of the tools. It keeps a connection to a host that is not local from resolving                             |
| `bin/net-guard-summary` | Counts what the guard recorded in the matrix runs and in the mutation run, by test and request                                        |
| `results/`              | Where every script writes. Ignored by git                                                                                             |

## Results

No result is committed to this repository. Results worth keeping are stored in the canon, under `hirefire-resource/node-audit/results/`, through `bin/keep-results`, which removes the paths of the machine.

## Throwaway copies

A cell installs its packages into `node_modules`, so two cells never run in one tree. The tools copy the tree to the temporary directory of the system, one copy per Node.js version for the matrix and one per cell for the mutation run. `TOOLS_SANDBOXES` names another place.
