# Repository Instructions

## Change Discipline

For every update to this repository:

- Update the relevant documentation under `/Users/gary/Documents/Projects/emporion/app/docs` so the written architecture, workflow, and operator guidance stays current with the implementation.
- Keep the CLI implementation in `/Users/gary/Documents/Projects/emporion/app/src/cli.ts` aligned with the current transport and protocol surface.
- Verify that the CLI still works after changes. At minimum, run the relevant CLI path locally and keep automated CLI coverage up to date when behavior changes.
