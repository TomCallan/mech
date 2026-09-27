// The only bundler-specific import in the project. Vite resolves this to a URL
// for the emitted .wasm asset. Kept isolated so the simulation layer can be
// imported and exercised outside a browser bundle.
import wasmUrl from 'jolt-physics/jolt-physics.wasm.wasm?url';

export default wasmUrl;
