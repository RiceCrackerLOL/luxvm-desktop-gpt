# Third-party software notices

## Stockfish.js 19.0.1

LuxVM bundles the single-threaded Lite WebAssembly build of Stockfish.js 19.0.1 as a separate local chess-engine worker.

- Project: https://github.com/nmrugg/stockfish.js
- Upstream engine: https://github.com/official-stockfish/Stockfish
- Package: https://www.npmjs.com/package/stockfish
- License: GNU General Public License, version 3 (GPL-3.0)
- License text: [third_party/stockfish/Copying.txt](third_party/stockfish/Copying.txt)
- Corresponding source: https://github.com/nmrugg/stockfish.js/tree/v19.0.1

The engine communicates with LuxVM through the UCI text protocol in a Web Worker. The engine is distributed unmodified. The corresponding source and build instructions are available from the linked Stockfish.js v19.0.1 source repository. Any redistribution of the bundled engine must comply with GPL-3.0.
