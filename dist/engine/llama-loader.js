/**
 * Runtime loader for node-llama-cpp.
 *
 * Handles two distinct runtime layouts:
 *
 *   1. Normal Node + node_modules (dev tree, npm-ci'd plugin install): the
 *      bare specifier "node-llama-cpp" resolves via standard module resolution.
 *
 *   2. Node SEA single-executable (0.7.0+ ship target): there's no
 *      node_modules adjacent to the binary. The bootstrap downloads
 *      node-llama-cpp + its platform binding into <cacheDir>/native/, sets
 *      KONGCODE_NODE_LLAMA_CPP_PATH to the absolute path of the main
 *      package's index.js, and we import from that path.
 *
 * Keeping this in one place isolates the layout logic from embeddings.ts so
 * downstream callers don't need to know which runtime they're under.
 */
export async function loadNodeLlamaCpp() {
    const override = process.env.KONGCODE_NODE_LLAMA_CPP_PATH;
    // Bare specifier path = normal Node + node_modules. Absolute path =
    // bootstrap-cached layout (works under SEA where node_modules is absent).
    const target = override || "node-llama-cpp";
    return await import(target);
}
