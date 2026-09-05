# Coverage baseline

The v0.3 work remeasured commit `e04b387fca1b10ae6668b6b6223fb8c8a530712a` with 31 passing tests: 46.98% statements/lines and 54.82% branches. These measured values are the enforced global floor; the existing 52% function floor is retained.

The new scheduler, revision, supervisor, recovery, transition, journal/store and Git integration modules require **90% lines and branches** before stable release. `npm run check:release` evaluates the actual coverage summary. A passing global floor alone is insufficient.

Run `npm run test:coverage` to reproduce local measurements. Current evidence and remaining gates are in [release readiness](../project/v0.3-readiness.md). Never lower a threshold to label an incomplete release ready.
