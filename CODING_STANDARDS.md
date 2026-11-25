# Coding standards

Rules for review. Anything a tool already enforces (typecheck, tests) is not repeated here.

## Everything that starts, ends

A run, a loading toast, a poll or a mark ends on every path: success, failure, cancel, and the data it waits for disappearing (for example a batch that leaves the library's 30 newest).

## One client helper per server mutation

Each server mutation has one client helper. Surfaces (toast, Activity, Inspector) call it. They do not copy it.
