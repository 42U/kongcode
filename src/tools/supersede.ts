/**
 * supersede MCP tool — explicit stale-knowledge correction.
 *
 * Lets users/bots say "this thing we believed is no longer true — here is
 * the new version." The substrate:
 *   1. Embeds the old text, finds the top-N concepts whose embedding
 *      matches (via linkSupersedesEdges threshold)
 *   2. Writes a new memory node with the correction text (category
 *      "correction", importance 9)
 *   3. Creates supersedes edges: correction_memory → stale_concept
 *   4. Decays the stability of each superseded concept so it loses
 *      priority in recall
 *
 * This is the explicit, structured alternative to letting the daemon
 * detect corrections from transcript text — useful when the bot KNOWS
 * a belief is stale and wants to mark it definitively rather than hope
 * the extractor catches it.
 */

import type { GlobalPluginState, SessionState } from "../engine/state.js";
import { commitKnowledge } from "../engine/commit.js";
import { linkSupersedesEdges } from "../engine/supersedes.js";
import { swallow } from "../engine/errors.js";

export async function handleSupersede(
  state: GlobalPluginState,
  session: SessionState,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const oldText = String(args.old_text ?? "").trim();
  const newText = String(args.new_text ?? "").trim();

  if (!oldText || !newText) {
    return { content: [{ type: "text", text: "Error: both `old_text` (stale belief) and `new_text` (correction) are required." }] };
  }

  const { store, embeddings } = state;
  const importance = typeof args.importance === "number" ? args.importance : 9;

  // 1. Write the correction as a memory node via commitKnowledge so it
  //    auto-seals about_concept edges to the concept graph.
  const { id: correctionMemId } = await commitKnowledge(
    { store, embeddings },
    {
      kind: "memory",
      text: `CORRECTION: ${newText} (replaces: ${oldText})`,
      importance,
      category: "correction",
      sessionId: session.sessionId,
    },
  );

  if (!correctionMemId) {
    return { content: [{ type: "text", text: "Error: failed to write correction memory." }] };
  }

  // 2. Link supersedes edges from correction memory → stale concepts.
  //    linkSupersedesEdges handles the embedding search + stability decay.
  let superseded = 0;
  try {
    superseded = await linkSupersedesEdges(
      correctionMemId, oldText, newText,
      store, embeddings,
    );
  } catch (e) {
    swallow("supersede:linkEdges", e);
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: true,
        correction_memory_id: correctionMemId,
        superseded_concepts: superseded,
        message: superseded === 0
          ? "Correction stored but no concepts matched the old text above threshold — consider rephrasing the old_text to better match existing concept content."
          : `Marked ${superseded} concept${superseded === 1 ? "" : "s"} as superseded.`,
      }, null, 2),
    }],
  };
}
