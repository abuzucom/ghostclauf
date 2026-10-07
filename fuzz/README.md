# Fuzz targets

This directory contains [Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js) fuzz targets that exercise the untrusted input surfaces of the bot.

Each target is a plain ESM JavaScript file exporting a `fuzz(data)` function.
The targets import the compiled code from `dist/`, so you must run `npm run build` before fuzzing.

## Running locally

Short sanity run (60 seconds per target):

```
npm run build
npm run fuzz
```

Long run (10 minutes per target):

```
npm run build
npm run fuzz:long
```

Individual target:

```
npm run build
npx jazzer fuzz/commands.fuzz.js -i dist/ corpus/commands -- -max_total_time=30
```

## Targets

- `config.fuzz.js` - `config.yaml` parsing via `parseFileConfig`.
- `commands.fuzz.js` - `CommandRegistry.match()` chat message parsing.
- `funfact.fuzz.js` - funfact text validation and id parsing.
- `quotes.fuzz.js` - quote text validation and id parsing.
- `loyalty.fuzz.js` - loyalty amount parsing and balance math.
- `streak.fuzz.js` - streak timezone/day-key logic and check-in math.
- `announce.fuzz.js` - announcement rendering and chat formatting.

## Corpus

Interesting inputs are saved under `corpus/<target>/` by Jazzer.js.
These are gitignored and cached in CI to make runs incremental.
