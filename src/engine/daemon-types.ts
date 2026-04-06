/**
 * Shared types for the memory daemon system.
 */

export interface TurnData {
  role: string;
  text: string;
  turnId?: string;
  tool_name?: string;
  tool_result?: string;
  file_paths?: string[];
}

/** Previously extracted item names for dedup across daemon runs. */
export interface PriorExtractions {
  conceptNames: string[];
  artifactPaths: string[];
  skillNames: string[];
}
